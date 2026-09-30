---
layout: post
title: "자동 계측은 자바 몇까지 닿나 — 경계선을 실측으로 그어보기"
date: 2026-09-30 15:00:00 +0900
---

앞선 글에서 OpenTelemetry 자바 에이전트가 **Java 8 이상**만 지원한다는 것을 적었다.
클래스 파일의 메이저 버전이 52 로 박혀 있고, JVM 은 자기보다 높은 번호를 거부한다.

그러면 그 아래는 전부 포기해야 하나. 그렇지 않다. 다만 **하한선이 하나가 아니고,
축도 하나가 아니다.** 어디까지 닿는지 실제로 붙여보고 선을 그어봤다.

## 하한선은 세 개다

자동 계측을 하는 에이전트를 공개 문서 기준으로 늘어놓으면 하한선이 나뉜다.

```
OpenTelemetry Java      Java 8+            공식 문서 · 전 릴리스 major 52
Elastic APM Java        Oracle/OpenJDK ≥7u60
Pinpoint (2.1.x 이하)   JDK 6~13
Scouter (2.20.0 이전)   JDK 1.6+
```

Pinpoint 는 2.2.0 에서 JDK 6 지원을 끝냈고 Scouter 는 2.20.0 에서 최소 버전을 8 로
올렸다. 즉 **자바 6 을 지원하는 것은 어느 쪽이든 유지되지 않는 옛 릴리스뿐**이다.
자바 7 은 사정이 다르다. Elastic 은 2026 년 9 월에 나온 최신 1.57.0 지원 표에도
`≥7u60` 이 그대로 있다.

`7u60` 이라는 경계가 중요하다. 2014 년 5 월 릴리스다. 그보다 낮은 JVM 을 만나면
에이전트는 **스스로 비활성화**한다. 릴리스 노트 원문은 이렇다.

> "When trying to attach to a non-supported version, the agent will disable itself
> and not apply any instrumentations."

장애를 내지 않고 조용히 아무것도 하지 않는다. 그래서 **붙여보는 것 자체는 위험하지
않다.** 미리 확인받아야 하는 전제조건이 아니라, 붙이면 그 자리에서 드러나는 것이다.

## 축이 하나 더 있다 — Servlet 세대

JDK 만 보면 안 된다. Elastic 의 Servlet 지원 범위는 `≥ 3.x, ≤ 6.x` 다.
**Servlet 2.5 는 의도적으로 계측하지 않는다.** 런타임 오류가 나기 때문이다.

반대로 OpenTelemetry 에이전트에는 `servlet/v2_2` 모듈이 있어 Servlet 2.2~2.5 를
덮는다. 그러니 두 에이전트의 강점이 서로 엇갈린다.

```
            Servlet 2.5        Servlet 3.0+
JDK 8+      OTel ○             OTel ○
JDK 7u60+   ✗                  Elastic ○
JDK 7u59-   ✗                  ✗
JDK 6       ✗                  ✗
```

왼쪽 위와 오른쪽 가운데만 열려 있다. **낡은 규격과 낡은 JDK 가 겹치는 칸이 빈다.**

## 실제로 붙여봤다

표만 보고 끝낼 일이 아니라서 재봤다. 대상은 **JEUS 8 + JDK 1.7.0_80** 이다.
JEUS 8 은 Java EE 7 인증이라 Servlet 3.1 세대이고, 7u80 은 자바 7 의 마지막 공개
릴리스이니 7u60 조건을 넉넉히 넘는다. 앞선 글에서 적었듯 이 제품은 OpenTelemetry
에이전트의 전용 모듈 목록에 없고, Elastic 의 시험 목록에도 없다.

기동 옵션에 에이전트를 한 줄 넣었다. JEUS 7 이상은 도메인 설정 XML 의 `<jvm-option>`
이 그 자리다. JEUS 6 은 `JEUSMain.xml` 의 `<command-option>` 이다.

```xml
<jvm-config>
    <jvm-option>-Xmx1024m -javaagent:/path/elastic-apm-agent-1.57.0.jar
                -Delastic.apm.server_url=http://수집지:8200
                -Delastic.apm.service_name=legacy-was</jvm-option>
</jvm-config>
```

기동 로그에 이렇게 남았다.

```
Starting Elastic APM 1.57.0 as legacy-was on Java 1.7.0_80
  Runtime version: 1.7.0_80-b15  VM version: 24.80-b11 (Oracle Corporation)
Tracer switched to RUNNING state
```

그리고 첫 요청이 들어오자 이 한 줄이 나왔다.

```
co.elastic.apm.agent.servlet.ServletVersionInstrumentation
    - Servlet container info = JEUS 8
```

**시험 목록에 없는 제품인데 이름까지 알아보고 계측이 발동했다.** 문서에 적힌
"Other Servlet 3+ compliant servers will most likely work as well" 이 실제로 통했다.
스택 추적을 보면 `jeus.servlet.engine.RequestProcessor` → `jeus.servlet.servlets.JspServlet`
을 지나 `javax.servlet.http.HttpServlet.service` 에서 잡힌 것이 확인된다.
규격 계층에서 후킹하니 제품 고유 구조를 몰라도 되는 셈이다.

## 그런데 프로토콜이 다르다

여기서 문제가 하나 생긴다. **옛 JDK 에서 도는 에이전트 중 OTLP 를 말하는 것이 없다.**
OpenTelemetry SDK 자체가 Java 8 을 요구하니 당연한 결과다. Elastic 은 자기 형식인
intake v2 로, Pinpoint 는 자기 gRPC 로, Scouter 는 자기 TCP 로 보낸다.

그러면 OTLP 백엔드를 쓰는 쪽은 선택지가 둘이다. 그 제품의 백엔드를 따로 세워
화면을 두 개 보든가, **중간에 번역기를 두든가**.

Elastic 의 intake v2 는 번역하기 좋은 편이다. `POST /intake/v2/events` 로
줄바꿈 구분 JSON 이 오고 스키마가 공개돼 있다. 압축은 deflate, 전송은 chunked 다.
트랜잭션 한 건이 이렇게 온다.

```json
{"timestamp":1790757067703017,"name":"GET /index.jsp",
 "id":"bb12bac71bb583b7","trace_id":"8e7d39e5864f0163fa360471924092e7",
 "type":"request","duration":18.545,"outcome":"success",
 "context":{"request":{"method":"GET","url":{"pathname":"/index.jsp"},
            "http_version":"1.1"},"response":{"status_code":200}}}
```

**식별자 규격이 같다.** `trace_id` 는 32 자 128 비트, `id` 는 16 자 64 비트로 W3C
Trace Context 와 동일하다. 그대로 옮기면 된다. 시간은 `timestamp` 가 마이크로초,
`duration` 이 밀리초 실수라 계산만 하면 된다. 나머지는 이름 바꾸기다.

```
context.request.method        → http.request.method
context.request.url.pathname  → url.path
context.response.status_code  → http.response.status_code
context.request.http_version  → network.protocol.version
metadata.service.name         → service.name (Resource)
jvm.memory.heap.used          → jvm.memory.used {jvm.memory.type=heap}
```

수신기 하나를 세워 이 번역을 하고 OTLP/HTTP 로 넘기게 했다. 350 줄쯤 된다.
WAS 쪽에서는 `server_url` 을 그 수신기로 돌리면 끝이고, 수집기부터 뒤쪽은 한 줄도
바뀌지 않는다.

## 트레이스가 경계를 넘나

가장 궁금했던 부분이다. 옛 JDK 쪽은 Elastic 에이전트, 나머지는 OpenTelemetry
에이전트를 쓰게 되니 **서로 다른 에이전트 사이에서 트레이스가 이어지느냐**가 걸린다.

Elastic 은 1.14 부터 W3C Trace Context 를 정식 지원하고 기본으로 `traceparent` 와
`tracestate` 를 쓴다. 다만 하위 호환용 `elastic-apm-traceparent` 도 같이 보내므로
`use_elastic_traceparent_header=false` 로 끄는 편이 깔끔하다.

WAS 의 JSP 에서 `HttpURLConnection` 으로 다른 서비스를 부르게 하고 확인했다.
그 다음 서비스부터는 전부 OpenTelemetry 로 계측된 것들이다.

```
서비스        종류      스팬명              span      parent
legacy-was    Server    GET /call.jsp       3e003aa7
legacy-was    Client    GET …               11df37c3  ← 3e003aa7
svc-java      Server    GET /               ef291cb1  ← 11df37c3   ★ 에이전트 경계
svc-java      Client    GET                 5c0e85f1  ← ef291cb1
svc-python    Server    GET /work           1bb803cb  ← 5c0e85f1
svc-node      Server    GET /work           bcd8c8b2  ← 44550ad3
svc-go        Server    GET /work           6e83e469  ← 7456f31f
```

**하나의 TraceId 로 다섯 서비스가 이어지고 부모-자식이 끝까지 맞는다.** 서비스맵에도
`legacy-was → svc-java` 간선이 그려졌다. 저장소에 들어간 리소스 속성에는
`process.runtime.version: 1.7.0_80` 과 `telemetry.sdk.name: elastic-apm-agent` 가
남아, 어느 경로로 들어온 데이터인지 나중에도 구분된다.

JVM 지표도 15 종이 들어왔다. `jvm.memory.used`(풀별), `jvm.gc.collection.count`,
`jvm.thread.count`, `process.cpu.utilization` 같은 것들이다.

## 번역기를 만들면서 밟은 것 네 개

**첫째, `type` 이 복합 문자열이다.** 외부 호출 스팬의 종류가 `type`/`subtype` 으로
나뉘어 올 줄 알았는데 `"type": "external.http"` 한 덩어리로 왔다. 따로 볼 줄 알고
짜면 CLIENT 가 아니라 INTERNAL 로 떨어져 호출 트리 모양이 틀린다. 점으로 분해해야
한다. DB 는 `db.<벤더>` 형태다.

**둘째, 예외를 스팬으로 만들면 오류 건수가 두 배가 된다.** intake v2 는 예외를
`error` 라는 별도 줄로 보낸다. 이걸 스팬으로 바꿨더니 트랜잭션이 이미 Error 인데
스팬이 하나 더 생겨 화면의 오류 건수가 정확히 2 배로 셌다. 엔드포인트 목록에
`java.lang.IllegalStateException` 이라는 가짜 항목까지 생겼다. **OTLP 로그 레코드**
(severity ERROR, `traceId`·`spanId` 부여)로 보내니 건수가 맞고 예외는 트레이스
문맥을 가진 로그로 남는다.

**셋째, JSP 컴파일 실패는 계측되지 않는다.** 예외 시험용 JSP 가 500 을 반환하는데
트랜잭션이 아예 안 잡혀 에이전트 결함인가 의심했다. 원인은 내 JSP 였다. scriptlet
끝에 맨 `throw` 를 두면 생성된 서블릿 코드에 도달 불가 문장이 생겨 **컴파일 자체가
실패**한다. 컴파일 실패는 `HttpServlet.service` 에 도달하기 전이라 계측 대상이
아니다. `if (…) { throw …; }` 로 감싸니 런타임 예외로 정상 포착됐다.
**500 이 안 잡힌다고 에이전트를 의심하기 전에 그 500 이 어디서 났는지 봐야 한다.**

**넷째, 아주 오래된 바이트코드는 건너뛴다.** 기동 중 이런 경고가 떴다.

```
listeners.ContextListenerTest uses an unsupported class file version (pre Java 4))
and can't be instrumented. You may try setting the 'instrument_ancient_bytecode'
config option to 'true', but notice that it may cause VerificationErrors
```

WAS 예제 앱의 클래스 몇 개가 자바 4 이전 바이트코드였다. 2000년대에 만들어진
애플리케이션에는 실제로 있을 수 있다. 대응 옵션이 있다는 것까지는 알아둘 만하다.

## 벤더 JVM 은 선이 또 다르다

HotSpot 만 생각하면 안 된다. Elastic 의 지원 표를 벤더별로 보면 이렇다.

```
Oracle JDK / OpenJDK    ≥7u60, ≥8u40, 9, 10, 11, 17, 21, 25
IBM J9 VM               8 service refresh ≥5 (2.9 / 8.0.5.0 ~ 8.0.8.x)
HP-UX JVM               ≥7.0.10, 8.0.x
SAP JVM                 8.1.065
```

**IBM J9 는 8 부터다.** 자바 7 행이 아예 없다. 상용 WAS 는 AIX 와 HP-UX 를 지원하는
경우가 많고 AIX 는 IBM JVM 을 쓰므로, `AIX + IBM JDK 7` 조합이면 이 경로가 닫힌다.
HP-UX 는 `7.0.10` 이상이라 열려 있다. **같은 "자바 7" 인데 벤더가 갈림길을 만든다.**
그래서 OS 선택이 곧 벤더 선택이고, 벤더가 계측 가능 여부를 정한다.

벤더가 갈리는 이유는 바이트코드 계측이 JVM 내부에 의존하기 때문이다. 클래스 재변환은
JVMTI 구현에 기대고, 고쳐 쓴 바이트코드는 그 JVM 의 검증기를 통과해야 한다. 검증기의
엄격함과 재변환 동작이 구현마다 달라서, 벤더별로 따로 시험하지 않으면 지원한다고
쓸 수 없다. 표에 벤더 행이 따로 있는 것 자체가 그 사정을 보여준다. IBM J9 8 행에도
`Sampling profiler is not supported` 라는 단서가 붙어 있다 — 뜨긴 뜨지만 기능이
줄어든다는 뜻이다.

헷갈리기 쉬운 지점 하나. **Temurin·Zulu·Corretto·Liberica 는 OpenJDK 빌드라
OpenJDK 행으로 본다.** 별도 벤더가 아니다. 반대로 IBM Semeru 는 OpenJ9 기반이라
J9 쪽으로 봐야 한다. `java -version` 출력에 `HotSpot` 이 있으면 OpenJDK 계열,
`IBM J9 VM` 이나 `Eclipse OpenJ9` 가 있으면 J9 계열이다.

## 그래서 경계선

정리하면 이렇다.

```
가능
  JDK 8 이상 · Servlet 2.2~6.x          OpenTelemetry 에이전트 그대로
  JDK 7u60 이상 · Servlet 3.0 이상       Elastic 에이전트 + intake v2 번역기
  HP-UX JVM 7.0.10 이상 · Servlet 3.0+  같은 경로

불가능
  JDK 7u59 이하                          에이전트가 스스로 비활성화
  JDK 6 이하                             유지되는 구현이 없다
  IBM J9 7 이하                          지원 표에 없다
  Servlet 2.5 이하 · JDK 8 미만          규격도 JDK 도 둘 다 걸린다
```

JEUS 세대로 옮겨 적으면 이렇게 된다.

```
JEUS 6    Java EE 5 · Servlet 2.5 · JDK 6/7/8   → JDK 8 + OTel 만 가능
JEUS 7    Java EE 6 · Servlet 3.0 · JDK 6/7     → 7u60 이상이면 Elastic 경로
JEUS 8    Java EE 7 · Servlet 3.1 · JDK 7/8     → 7u60 이상이면 Elastic (실측)
JEUS 8.5  Jakarta EE 8 · JDK 8 인증              → OTel 그대로
```

일반화하면 **Java EE 6 세대(Servlet 3.0) 이상이면서 JDK 가 7u60 을 넘는 곳까지
닿는다.** Java EE 5 세대는 JDK 를 8 로 올려 OpenTelemetry 로 가는 길만 남는다.

## 붙이기 전에 재야 하는 것

위 경계선을 가르는 정보는 사실 명령 하나에 다 있다.

```
$ ps -ef | grep <was>                     # WAS 가 실제로 쓰는 java 경로
$ /그/경로/java -version
java version "1.7.0_80"
Java(TM) SE Runtime Environment (build 1.7.0_80-b15)
Java HotSpot(TM) 64-Bit Server VM (build 24.80-b11, mixed mode)
```

이 출력에 **업데이트 번호와 벤더가 동시에** 들어 있다. `_80` 이 7u60 을 넘는지,
`HotSpot` 인지 `IBM J9 VM` 인지가 한 화면에 나온다. `PATH` 의 java 를 보면 안 된다.
서버에 JDK 가 여러 개 깔려 있고 WAS 는 자기 설정이 가리키는 것으로 뜨기 때문이다.

그리고 이건 **질문 목록에 넣을 항목이 아니라 설치 절차의 첫 줄**이다. 어느 APM 을
넣든 JVM 확인부터 하는 것이 표준이고, 앞서 적었듯 하한선 미달이면 에이전트가 조용히
꺼지므로 확인 자체가 위험을 만들지 않는다.

## 남은 것

DB 스팬은 아직 못 재봤다. 데이터소스를 붙이면 `db.<벤더>` 형태의 스팬이 올 텐데
`db.system.name`·`db.query.text` 매핑을 실제 페이로드로 확인해야 번역표가 완성된다.

그리고 에이전트 버전을 **고정해야 한다.** Elastic 의 자바 7 지원은 1.33.0 부터 폐기
예고 상태이고, 1.46.0 에서 jctools 때문에 실제로 깨졌다가 1.51.0 에서 복구됐다.
1.46 ~ 1.50 구간은 피하고, 쓰는 버전의 jar 를 직접 보관해두는 편이 안전하다.
언젠가 빠질 지원에 기대는 경로라는 것은 분명히 알고 시작해야 한다.

---

**근거**

- [OpenTelemetry Java zero-code instrumentation](https://opentelemetry.io/docs/zero-code/java/agent/) — "any Java 8+ application"
- [Elastic APM Java agent supported technologies](https://www.elastic.co/docs/reference/apm/agents/java/supported-technologies) — JVM 벤더별 지원 표, Servlet `≥3.x ≤6.x`, "Other Servlet 3+ compliant servers will most likely work as well"
- [Elastic APM Java agent release notes](https://www.elastic.co/docs/release-notes/apm/agents/java) — 1.46.0 자바 7 깨짐, 1.51.0 복구, 최신 1.57.0
- [Elastic APM Java agent breaking changes](https://www.elastic.co/docs/release-notes/apm/agents/java/breaking-changes) — 1.33.0 자바 7 폐기 예고, 1.18.0 에서 7u60 미만 제외
- [Elastic APM events intake API](https://www.elastic.co/docs/solutions/observability/apm/elastic-apm-events-intake-api) — intake v2 NDJSON 규격
- [Elastic APM adopts W3C TraceContext](https://www.elastic.co/blog/elastic-apm-adopts-w3c-tracecontext) — 자바 에이전트 1.14 이상
- [Pinpoint](https://github.com/pinpoint-apm/pinpoint) — 에이전트 JDK 지원 매트릭스
- [Scouter releases](https://github.com/scouter-project/scouter/releases) — v2.20.0 "The lowest supported version has been changed to java 8"
