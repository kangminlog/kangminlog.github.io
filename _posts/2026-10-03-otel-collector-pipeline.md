---
layout: post
title: "OpenTelemetry Collector 의 수신-가공-송신 파이프라인"
date: 2026-10-03 10:00:00 +0900
---

애플리케이션이 백엔드로 직접 보내면 되는데 왜 중간에 프로세스를 하나 더 두는가.
이게 Collector 를 처음 볼 때 드는 의문이고, 답을 알고 나면 대부분 쓰게 된다.

## 왜 중간에 두나

**설정을 바꾸려고 애플리케이션을 재배포하지 않아도 된다.** 이게 가장 크다. 보내는 곳을
바꾸거나, 샘플링 비율을 조정하거나, 민감한 속성을 지우는 일이 전부 Collector 설정
변경으로 끝난다. WAS 재기동이 필요 없다.

**백엔드가 잠깐 죽어도 데이터가 안 사라진다.** 애플리케이션 안의 버퍼는 크게 잡을 수
없다. 애플리케이션 메모리이기 때문이다. Collector 는 자기 메모리와 디스크를 쓸 수 있다.

**여러 곳으로 보낼 수 있다.** 제품을 바꾸는 기간에 두 백엔드로 동시에 보내며 비교하는
것이 가능해진다.

**민감 정보를 나가기 전에 지울 수 있다.** 애플리케이션에서 실수로 담은 주민번호나
토큰을 여기서 걸러낸다. 애플리케이션을 고치는 것보다 빠르고, 전 서비스에 한 번에 적용된다.

## 구성 요소 넷

설정 파일은 늘 같은 모양이다.

```yaml
receivers:    # 어떻게 받나
processors:   # 받은 것을 어떻게 손보나
exporters:    # 어디로 보내나
extensions:   # 위 셋을 거드는 것 (저장소·헬스체크 등)

service:
  extensions: [...]
  pipelines:
    traces:
      receivers:  [...]
      processors: [...]
      exporters:  [...]
```

앞의 셋은 **선언만 해둔 부품**이고, 실제로 무엇이 도는지는 `service.pipelines` 가 정한다.
선언해두고 파이프라인에 안 넣으면 그 부품은 기동조차 하지 않는다. 설정을 고쳤는데
아무 일도 안 일어나면 대개 여기를 빠뜨린 것이다.

신호별로 파이프라인이 따로 있고, 같은 신호에 대해 여러 개를 둘 수도 있다.

```yaml
  pipelines:
    metrics:        # 애플리케이션 메트릭
      receivers: [otlp]
    metrics/snmp:   # 장비 메트릭 — 다른 가공을 건다
      receivers: [snmp/sw01, snmp/sw02]
```

## 받는 방법은 OTLP 만이 아니다

`receivers` 에 들어갈 수 있는 것이 많다. OTLP 는 그중 하나다.

```yaml
receivers:
  otlp:                      # 애플리케이션
    protocols:
      grpc: { endpoint: 0.0.0.0:4317 }
      http: { endpoint: 0.0.0.0:4318 }
  syslog:                    # 장비 로그
    tcp: { listen_address: "0.0.0.0:514" }
  snmp/sw01:                 # 장비 상태 — 이건 우리가 가지러 간다
    endpoint: udp://10.0.0.11:161
    collection_interval: 60s
```

그래서 Collector 는 "OpenTelemetry 전용 중계기" 가 아니라 **여러 출처를 하나의 모양으로
바꿔주는 변환기**에 가깝다. syslog 로 들어온 장비 로그도, SNMP 로 긁어온 포트 상태도
같은 파이프라인을 타고 같은 형식으로 나간다.

SNMP 만 방향이 반대라는 점은 기억해둘 만하다. 나머지는 대상이 보내주지만 SNMP 는
Collector 가 주기적으로 가지러 간다.

## 가공은 순서가 의미를 가진다

`processors` 는 **배열에 적은 순서대로** 걸린다. 이게 단순한 취향 문제가 아니다.

```yaml
    processors: [memory_limiter, transform/..., batch]
```

`memory_limiter` 를 맨 앞에 두는 이유는, 메모리가 넘칠 때 **뒤쪽 작업을 하기 전에**
거절해야 의미가 있기 때문이다. 가공을 다 해놓고 나서 버리면 CPU 만 쓴 셈이다.

`batch` 를 맨 뒤에 두는 이유는 그 반대다. 한 건씩 보내면 네트워크 왕복이 너무 많아지니
마지막에 묶는다. 앞에 두면 가공기들이 묶음을 다시 풀었다 싸는 일을 한다.

## 보내는 쪽 — 버퍼와 재시도

`exporters` 에서 실무상 중요한 건 두 가지다.

```yaml
exporters:
  otlp/backend:
    endpoint: backend:4317
    sending_queue:
      enabled: true
      num_consumers: 16
      queue_size: 10000
    retry_on_failure:
      enabled: true
      initial_interval: 5s
      max_interval: 30s
      max_elapsed_time: 300s
```

`sending_queue` 는 보낼 것을 쌓아두는 대기열이고, `retry_on_failure` 는 실패했을 때
다시 보내는 규칙이다.

**`max_elapsed_time` 은 한 번 확인해보는 게 좋다.** 기본값이 5 분인 경우가 있는데,
백엔드가 그보다 오래 멈추면 그때부터 들어온 것을 포기한다. 점검 시간이 5 분을 넘을
수 있는 환경이라면 넉넉히 잡거나 `0`(무한)으로 둔다. 무한으로 두더라도 대기열이 차면
결국 거절하므로, 대기열 크기와 같이 봐야 한다.

## 대기열을 디스크에 두기

기본 대기열은 메모리다. Collector 프로세스가 죽거나 서버가 재부팅되면 그 안의 것은
사라진다.

`file_storage` 확장을 붙이면 대기열이 디스크에 앉는다.

```yaml
extensions:
  file_storage/queue:
    directory: /var/lib/otelcol/queue
    create_directory: true

service:
  extensions: [file_storage/queue]

exporters:
  otlp/backend:
    sending_queue:
      storage: file_storage/queue   # ← 이 한 줄
```

이러면 프로세스가 죽었다 살아나도 못 보낸 것을 이어서 보낸다. 컨테이너로 돌린다면
그 디렉터리를 볼륨으로 빼야 의미가 있다. 안 빼면 컨테이너와 함께 사라진다.

**확장은 파이프라인이 아니라 `service.extensions` 에 등록한다.** 여기에 안 적으면
선언만 하고 안 쓰는 상태가 된다.

## 어디에 두나

배치 형태는 둘로 나뉜다.

**호스트마다 하나씩.** 애플리케이션 바로 옆에 두는 방식이다. 네트워크 왕복이 짧고
호스트 메트릭을 같이 걷기 좋다. 대신 설정을 바꾸려면 전 호스트에 배포해야 한다.

**중앙에 몇 대.** 애플리케이션들이 한 곳으로 보내는 방식이다. 설정 관리가 쉽고
민감정보 필터링 같은 정책을 한 군데서 건다. 대신 그 몇 대가 병목이자 단일 장애점이
되므로 앞에 로드밸런서를 두거나 여러 대로 나눈다.

둘을 섞기도 한다. 호스트마다 가벼운 것을 두어 걷고, 중앙의 무거운 것이 가공과 저장을
맡는 식이다. 수집과 가공의 부하 성격이 다르기 때문에 이렇게 나누면 각자 필요한
만큼만 키울 수 있다.

## 확인하는 법

Collector 는 자기 상태를 메트릭으로 내놓는다.

```yaml
service:
  telemetry:
    metrics:
      address: 0.0.0.0:8888
```

여기서 받은 건수·거절 건수·대기열 길이를 볼 수 있다. **들어온 수와 나간 수를 대조하는
것**이 가장 기본적인 점검이고, 설정을 바꿀 때마다 이걸 보는 습관이 도움이 된다.
