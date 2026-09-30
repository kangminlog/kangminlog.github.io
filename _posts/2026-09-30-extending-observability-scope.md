---
layout: post
title: "수신기 하나로 감시 범위를 넓히는 구조"
date: 2026-09-30 11:30:00 +0900
---

애플리케이션을 관측하려고 들인 도구에 스위치 포트 상태를 붙였다. 그다음엔
데이터베이스 연결 수를, 그다음엔 웹서버 응답 코드 분포를 붙였다.

**그때마다 한 일은 설정 파일에 대여섯 줄을 더한 것뿐이다.** 저장소 스키마도,
애플리케이션도, 화면 코드도 건드리지 않았다.

이게 어떻게 가능한지가 이 글의 내용이다.

## 얼마나 붙일 수 있나

OpenTelemetry Collector 배포판이 어떤 수신기를 갖고 있는지는 직접 물어볼 수 있다.

```
docker run --rm --entrypoint /otelcol-contrib \
  otel/opentelemetry-collector-contrib:<버전> components
```

세어보니 **95 종**이었다. 성격별로 추리면 이렇다.

```
데이터베이스   postgresql  mysql  oracledb  sqlserver  mongodb  redis  elasticsearch
웹서버·프록시  nginx  apache  haproxy  iis
JVM            jmx
OS·컨테이너    hostmetrics  docker_stats  podman_stats
쿠버네티스     k8s_cluster  kubeletstats  k8s_events  k8sobjects
로그           filelog  journald  windowseventlog  syslog
장비           snmp  sshcheck  ntp  chrony
외형 감시      httpcheck
임의 질의      sqlquery
기존 도구      prometheus  statsd  collectd  zipkin  jaeger  loki  splunk_hec
```

마지막 줄이 실무에서 특히 쓸모 있다. **이미 Prometheus 나 Zipkin 을 쓰고 있다면
그걸 걷어내지 않고 그대로 받아들일 수 있다.** 이관 기간에 둘을 나란히 두고
비교하는 것도 된다.

## 왜 출처가 달라도 같은 모양이 되나

핵심은 여기다. SNMP 로 받은 스위치 포트 상태와, PostgreSQL 에서 읽은 연결 수와,
애플리케이션이 보낸 응답시간이 **전부 같은 형태의 메트릭**이 된다.

```
MetricName           snmp.if.in.octets
TimeUnix             2026-09-30 11:00:00
Value                1604564781
Attributes           if.name = GigabitEthernet1/0/24
ResourceAttributes   snmp.device  = sw01/port.24
                     snmp.chassis = sw01
```

두 개의 속성 주머니가 있고 **역할이 나뉘어 있다.**

```
ResourceAttributes   누구를 잰 값인가    장비 · 호스트 · 서비스 · 인스턴스
Attributes           무엇을 잰 값인가    포트 이름 · 디스크 이름 · 질의 종류
```

이 분리가 확장의 전부다. 새 장비를 붙여도 **표를 새로 만들지 않는다.** 같은 표에
`ResourceAttributes` 가 다른 행이 늘 뿐이다.

로그도 마찬가지다. syslog 로 들어온 장비 로그와 애플리케이션 로그가 같은 표에
들어가고 같은 화면에서 조회된다. 다른 점은 애플리케이션 로그에는 `TraceId` 가
있고 장비 로그에는 없다는 것 정도다 — 장비 이벤트는 특정 요청에 속하지 않으니까.

## 붙이는 절차

```
1. 수신기를 선언한다
2. 파이프라인에 넣는다
3. 재기동한다
```

```yaml
receivers:
  postgresql/db1:
    endpoint: 10.0.0.50:5432
    username: monitor
    collection_interval: 60s

service:
  pipelines:
    metrics/db:
      receivers:  [postgresql/db1]
      processors: [memory_limiter, batch]
      exporters:  [<기존과 동일>]
```

**2 번을 빠뜨리는 실수가 잦다.** 선언만 하고 파이프라인에 안 넣으면 그 수신기는
기동조차 하지 않는다. 설정을 고쳤는데 아무 일도 안 일어나면 대개 여기다.

대상 쪽에서는 읽기 권한만 열어주면 된다. 쓰기 권한은 필요 없다.

## 방향이 반대인 것들

대부분의 수신기는 **대상이 보내온 것을 받는다.** OTLP, syslog, 로그 파일이 그렇다.

그런데 일부는 **우리가 가지러 간다.** SNMP, 데이터베이스, 웹서버 상태 페이지가
그렇다. 이들은 주기적으로 대상에 접속해 읽는다.

```
otlp · syslog · filelog      대상 → 수집기      방화벽: 대상에서 수집기로
snmp · postgresql · nginx    수집기 → 대상      방화벽: 수집기에서 대상으로
```

**방화벽 신청서를 쓸 때 이 구분이 필요하다.** 방향을 반대로 적어서 다시 신청하는
일이 실제로 생긴다.

그리고 가지러 가는 쪽은 **폴링 주기가 곧 해상도**다. 60 초 주기로 읽으면 그보다
짧은 사건은 안 보인다. 짧게 잡으면 대상에 부담이 가고, 길게 잡으면 놓친다.

## 한계도 있다

**수신기가 내놓는 항목은 수신기가 정한다.** 대상 장비나 소프트웨어가 제공하지 않는
값은 만들 수 없다. SNMP 를 붙였다고 모든 장비에서 온도가 나오는 게 아니다 —
센서가 없으면 없다.

**화면이 알아야 그림이 그려진다.** 수집은 설정만으로 되지만, 그 지표를 어떤 그림으로
보여줄지는 화면이 알아야 한다. 알려진 지표 이름이면 바로 그려지고, 새 지표라면
대시보드를 직접 만들거나 화면 쪽 작업이 필요하다.

**지표 이름이 표준이 아닐 수 있다.** 수신기마다 이름 규칙이 조금씩 다르다.
여러 출처를 한 화면에서 비교하려면 이름을 맞추는 가공이 필요할 때가 있다.

## 그래서 무엇이 좋은가

애플리케이션만 보면 답이 안 나오는 문제가 많다. 응답시간이 튀었는데 애플리케이션은
멀쩡한 경우가 그렇다. 디스크가 밀렸거나, 스위치 포트에 오류가 늘고 있었거나,
데이터베이스 커넥션 풀이 말랐거나 한다.

**원인이 애플리케이션 밖에 있을 때 같은 화면에서 같은 시각으로 볼 수 있는 것**,
이게 감시 범위를 넓히는 실질적인 이유다.

그리고 넓히는 비용이 설정 대여섯 줄이라면, 안 넓힐 이유가 별로 없다.
