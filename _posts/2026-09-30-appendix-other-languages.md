---
layout: post
title: "부록 — .NET · Ruby · PHP · Go 에 자동 계측 붙이기"
date: 2026-09-30 13:10:00 +0900
---

[앞 글](/2026/09/30/otel-autoinstrument-hands-on.html)에서 Java · Python · Node.js · Go
넷을 다뤘다. 이 글은 나머지다. **.NET 과 Ruby 는 실제로 붙여서 스팬이 들어오는 것까지
확인했고**, PHP 는 방법만 정리했다.

각각 한 군데씩 막히는 지점이 있었다. 그 지점을 같이 적는다.

---

## 1. .NET — 공식 자동 계측

CLR 프로파일러 API 를 쓴다. Java 의 `-javaagent` 와 비슷한 위치다.

```bash
# 설치
curl -sSfL https://github.com/open-telemetry/opentelemetry-dotnet-instrumentation/releases/latest/download/otel-dotnet-auto-install.sh -O
OTEL_DOTNET_AUTO_HOME=/otel sh ./otel-dotnet-auto-install.sh

# 실행
export OTEL_DOTNET_AUTO_HOME=/otel      # ← 이걸 export 해둬야 한다
. /otel/instrument.sh
dotnet /out/app.dll
```

### 막힌 곳 둘

**하나. 설치 스크립트가 `gh` CLI 를 요구한다.**

```
The GitHub CLI ('gh') is required to verify release assets.
Install it from https://cli.github.com/ or set SKIP_RELEASE_VERIFICATION=true
```

릴리스 서명을 검증하려고 `gh` 를 쓴다. 없으면 `SKIP_RELEASE_VERIFICATION=true` 로
건너뛸 수 있다. **오프라인 환경이면 미리 받아 가야 하니 어차피 검증을 못 한다** —
대신 체크섬을 따로 대조하는 편이 낫다.

**둘. `OTEL_DOTNET_AUTO_HOME` 을 sourcing 시점에 안 주면 조용히 실패한다.**

이게 진짜 함정이었다. 설치할 때만 주고 `instrument.sh` 를 부를 때 안 주면,

```bash
$ . /otel/instrument.sh
$ echo $CORECLR_PROFILER_PATH
                              ← 빈 값
```

`CORECLR_PROFILER_PATH` 가 빈 문자열이 되고 **프로파일러가 아예 안 붙는다.**
그런데 애플리케이션은 멀쩡히 뜨고 요청도 잘 받는다. 오류가 없으니 된 줄 안다.
스팬이 안 들어와서야 알게 된다.

제대로 걸리면 이렇게 나온다.

```
CORECLR_PROFILER_PATH=/otel/linux-arm64/OpenTelemetry.AutoInstrumentation.Native.so
```

**확인하는 습관을 들이는 편이 좋다.** 이 한 줄을 찍어보면 5 초에 끝난다.

**셋(덤). `dotnet run` 말고 빌드 산출물을 직접 실행한다.**

`dotnet run` 은 자기가 하나의 .NET 프로세스이고 앱을 따로 띄운다. 프로파일러가
바깥쪽에 붙어버릴 수 있다. 빌드해서 dll 을 직접 실행하는 편이 확실하다.

```bash
dotnet build -c Release -o /out
. /otel/instrument.sh
exec dotnet /out/app.dll
```

### 결과

```
svc          spans  sample     kind
demo-dotnet    4    GET /work  Server
```

`linux-arm64` 네이티브 라이브러리가 함께 배포되므로 **ARM 서버에서도 그대로 된다.**

---

## 2. Ruby — `use_all`

Ruby 는 완전한 zero-code 가 아니다. **초기화 코드 몇 줄을 넣어야 한다.**
대신 그 몇 줄이 설치된 라이브러리를 전부 찾아 패치한다.

```ruby
require 'sinatra/base'                     # ← 계측 대상 라이브러리를 먼저
require 'opentelemetry/sdk'
require 'opentelemetry/instrumentation/all'
require 'opentelemetry-exporter-otlp'

OpenTelemetry::SDK.configure { |c| c.use_all() }   # ← 그다음에 configure
```

```bash
gem install sinatra rackup puma \
  opentelemetry-sdk opentelemetry-instrumentation-all opentelemetry-exporter-otlp
OTEL_SERVICE_NAME=demo-ruby \
OTEL_EXPORTER_OTLP_ENDPOINT=http://<수집서버>:4318 \
ruby app.rb
```

### 막힌 곳

**`require` 순서가 뒤바뀌면 아무것도 안 잡힌다.**

처음에 이렇게 썼다가 한참 헤맸다.

```ruby
OpenTelemetry::SDK.configure { |c| c.use_all() }
require 'sinatra'          # ← configure 다음에 로드하면 패치 대상이 아니다
```

`use_all` 은 **호출 시점에 이미 로드된 라이브러리**를 찾아 패치한다. 아직 안 불린
것은 대상이 아니다. 그런데 로그에는 이렇게 찍힌다.

```
Instrumentation: OpenTelemetry::Instrumentation::Net::HTTP was successfully installed
```

Net::HTTP 는 표준 라이브러리라 이미 로드돼 있어서 성공한다. **"successfully
installed" 를 보고 잘 됐다고 판단하기 쉽다.** 정작 웹 프레임워크는 안 잡혔는데도.

라이브러리를 먼저 `require` 하고 그다음에 `configure` 한다. 이 순서만 지키면 된다.

### 결과

```
svc         spans  sample     kind
demo-ruby     4    GET /work  Server
```

---

## 3. PHP — 확장 모듈

PHP 는 C 확장을 설치하고 `auto_prepend_file` 로 초기화 파일을 먼저 읽게 한다.

```bash
pecl install opentelemetry
echo "extension=opentelemetry.so" >> php.ini

composer require \
  open-telemetry/sdk \
  open-telemetry/opentelemetry-auto-slim \
  open-telemetry/exporter-otlp
```

```ini
; php.ini
auto_prepend_file = /app/vendor/autoload.php
```

```bash
OTEL_PHP_AUTOLOAD_ENABLED=true \
OTEL_SERVICE_NAME=demo-php \
OTEL_EXPORTER_OTLP_ENDPOINT=http://<수집서버>:4318 \
php -S 0.0.0.0:8080
```

**이건 직접 확인하지 않았다.** `pecl install` 이 컴파일을 요구해서 빌드 도구가
필요하고, 프레임워크별 `opentelemetry-auto-*` 패키지를 따로 깔아야 한다.
공식 문서 기준으로 적었으니 그대로 믿지 말고 확인하고 쓰는 편이 좋다.

오프라인 환경이라면 **확장 모듈을 미리 컴파일해 가야 한다.** PHP 버전과
아키텍처가 맞아야 하므로 대상 환경을 먼저 알아야 한다.

---

## 4. Go — 세 갈래

Go 는 앞 글에서 SDK 삽입으로 했는데, 코드를 안 고치는 길도 있다. 다만 전부 대가가 있다.

| 경로 | 코드 수정 | 재빌드 | 그 밖에 |
|---|---|---|---|
| SDK 삽입 | 필요 | 필요 | — |
| 컴파일 타임 계측 | 불필요 | **필요** | — |
| eBPF 자동 계측 | 불필요 | 불필요 | **커널 특권 필요** |

eBPF 방식은 `opentelemetry-go-instrumentation` 으로 나와 있다. 2026-09 기준
`v0.24.0` 으로 아직 0.x 다. 조건은 이렇다.

```
리눅스 커널 4.4 이상 (BTF 완전 지원은 5.2+)
CAP_SYS_ADMIN 또는 CAP_BPF (커널 5.8+)
amd64 · arm64 지원
```

**감시 대상 서버에 특권을 줘야 한다**는 점이 실무에서 가장 큰 걸림돌이다. 보안
심사가 있는 환경에서는 통과가 쉽지 않고, 통과하더라도 "모니터링 도구에 커널 권한" 은
설명이 필요한 결정이다.

컴파일 타임 계측은 특권이 필요 없는 대신 빌드 파이프라인을 손봐야 한다. **CI 가
있으면 이쪽이 현실적**이고, 빌드 환경에 접근할 수 없으면 eBPF 말고는 답이 없다.

---

## 5. 정리 — 언어별 삽입 난이도

여섯 언어를 실제로 붙여보고 나서 정리하면 이렇다.

| 런타임 | 방법 | 코드 수정 | 재빌드 | 확인 |
|---|---|---|---|---|
| Java | `-javaagent` | 없음 | 없음 | ✔ 스팬 확인 |
| Python | `opentelemetry-instrument` | 없음 | 없음 | ✔ |
| Node.js | `--require` | 없음 | 없음 | ✔ |
| .NET | `instrument.sh` + 프로파일러 | 없음 | 없음 | ✔ |
| Ruby | `use_all` 초기화 | **몇 줄** | 없음 | ✔ |
| Go | SDK · 컴파일타임 · eBPF | 경우에 따라 | **대개 필요** | ✔ (SDK) |
| PHP | 확장 + `auto_prepend_file` | 없음 | 없음 | 미확인 |

**네 언어는 실행 명령만 바꾸면 된다.** Ruby 는 초기화 몇 줄, Go 는 그 이상이 든다.

## 6. 공통으로 걸린 것

여섯 개를 붙이면서 반복된 실패 양상이 있었다.

**애플리케이션은 멀쩡히 뜨는데 스팬만 안 온다.** 계측이 안 걸려도 앱은 정상 동작한다.
오류가 안 나므로 성공한 줄 알고 넘어간다. .NET 의 빈 `CORECLR_PROFILER_PATH`,
Ruby 의 `require` 순서가 전부 이 모양이었다.

그래서 **붙인 직후에 스팬이 실제로 들어왔는지 확인하는 단계를 절차에 넣어야 한다.**
기동 로그만 보고 넘어가면 나중에 화면이 빈 것을 보고서야 알게 된다.

```sql
SELECT ServiceName, count() AS spans, max(Timestamp) AS last_seen
FROM otel.otel_traces
WHERE Timestamp > now() - INTERVAL 10 MINUTE
GROUP BY ServiceName ORDER BY ServiceName
```

한 줄이면 된다. 붙일 때마다 이걸 돌려보는 습관이 제일 값싼 보험이다.
