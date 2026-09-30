---
layout: post
title: "언어 네 개를 관통하는 트레이스 하나 만들어보기"
date: 2026-09-30 12:30:00 +0900
---

"OpenTelemetry 를 쓰면 언어가 달라도 추적이 이어집니다" 라는 설명을 자주 본다.
그런데 정말 이어지는지, 무엇 때문에 이어지는지는 직접 해보기 전엔 감이 안 온다.

Java → Python → Node.js → Go 로 이어지는 체인을 만들고, **요청 한 번이 하나의
트레이스로 묶이는지** 확인했다. 결론부터 보면 이렇게 나온다.

```
$ curl http://localhost:18090/
java -> python -> node -> go(end)
```

```
TraceId                            언어 수  스팬
a2e88cd3ec3c5a9dd241409a99720f0d      4      11
```

## 언어마다 붙이는 방법이 다르다

같은 표준을 쓰지만 **삽입 방식은 런타임마다 다르다.** 이게 이 실험에서 제일 먼저
부딪히는 지점이다.

| 런타임 | 삽입 방법 | 코드 수정 |
|---|---|---|
| Java | `-javaagent:agent.jar` | 없음 |
| Python | `opentelemetry-instrument <명령>` | 없음 |
| Node.js | `node --require @opentelemetry/auto-instrumentations-node/register` | 없음 |
| Go | **소스에 SDK 삽입** | **필요** |

Go 만 다른 이유는 컴파일 언어이기 때문이다. Java 는 JVM 이 클래스를 로드할 때
가로챌 수 있고, Python·Node 는 실행 중에 함수를 바꿔치기할 수 있다. **Go 는
빌드가 끝나면 프로세스 안에서 바꿀 자리가 없다.**

코드를 안 고치는 길이 아주 없지는 않다. 컴파일 타임 계측(재빌드 필요)과 eBPF
기반 자동 계측(커널 특권 필요)이 있다. 다만 둘 다 "실행 명령에 한 줄" 은 아니라서,
여기서는 가장 직관적인 SDK 삽입으로 했다.

## 준비 — 빌드 없이

네 개를 띄우려면 빌드 환경이 필요한데, 각 언어 이미지에 소스만 마운트하면
그럴 필요가 없다.

**Java** 는 JSP 를 쓰면 빌드가 아예 없다. 톰캣이 실행 시점에 컴파일한다.

```jsp
<%@ page import="java.io.*,java.net.*" %><%
HttpURLConnection c = (HttpURLConnection) new URL("http://demo-python:5000/work").openConnection();
BufferedReader br = new BufferedReader(new InputStreamReader(c.getInputStream()));
...
%>java -> <%= r %>
```

```bash
docker run -d --name demo-java --network demo-net -p 18090:8080 \
  -v $PWD/agent.jar:/agent.jar:ro \
  -v $PWD/java:/usr/local/tomcat/webapps/ROOT \
  -e JAVA_OPTS="-javaagent:/agent.jar -Dotel.service.name=demo-java \
                -Dotel.exporter.otlp.endpoint=http://<수집서버>:4318" \
  tomcat:9-jre8
```

**Python** 은 Flask 애플리케이션 앞에 단어 하나를 붙인다.

```bash
docker run -d --name demo-python --network demo-net -w /app -v $PWD/python:/app \
  -e OTEL_EXPORTER_OTLP_ENDPOINT=http://<수집서버>:4318 \
  -e OTEL_SERVICE_NAME=demo-python -e OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf \
  python:3.11-slim sh -c "pip install -q flask requests opentelemetry-distro \
    opentelemetry-exporter-otlp-proto-http && opentelemetry-bootstrap -a install && \
    opentelemetry-instrument flask run --host 0.0.0.0 --port 5000"
```

`opentelemetry-bootstrap -a install` 이 재미있는 부분이다. **설치된 패키지를 훑어서
그에 맞는 계측 패키지를 알아서 깔아준다.** Flask 가 있으면 Flask 계측을, requests
가 있으면 requests 계측을 넣는다.

**Node** 는 `--require` 로 모듈 하나를 먼저 읽게 한다.

```bash
node --require @opentelemetry/auto-instrumentations-node/register server.js
```

**Go** 는 소스를 고쳐야 한다. 여기서 한 줄이 특히 중요하다.

```go
exp, _ := otlptracehttp.New(ctx)
tp := sdktrace.NewTracerProvider(sdktrace.WithBatcher(exp), sdktrace.WithResource(res))
otel.SetTracerProvider(tp)
otel.SetTextMapPropagator(propagation.TraceContext{})   // ← 이 줄
http.Handle("/work", otelhttp.NewHandler(h, "GET /work"))
```

`SetTextMapPropagator` 를 빠뜨리면 **스팬은 생기는데 트레이스가 안 이어진다.**
Go SDK 는 전파기를 기본으로 켜주지 않는다. 처음 해보면 여기서 한참 헤맨다 —
데이터는 들어오는데 트레이스가 두 개로 갈라져 보인다.

## 결과 — 스팬 트리

```
svc          kind      name                      ms    parent    self
demo-java    Server    GET /index.jsp          30.7    (root)    84e3ddfd
demo-java    Client    GET                     26.5    84e3ddfd  416e88e3
demo-python  Server    GET /work               20.3    416e88e3  6e3c7e09   ← 경계 1
demo-python  Client    GET                     17.2    6e3c7e09  e8b63c78
demo-node    Server    GET /work               13.0    e8b63c78  35ad92e2   ← 경계 2
demo-node    Internal  middleware - patched    11.3    35ad92e2  65165902
demo-node    Internal  request handler - /work 10.3    65165902  ade46aff
demo-node    Internal  request handler - /work  9.9    ade46aff  781b53b2
demo-node    Client    GET                      5.4    781b53b2  867b3796
demo-node    Internal  tcp.connect              1.7    867b3796  e6940ba1
demo-go      Server    GET /work                0.0    867b3796  28584ffa   ← 경계 3
```

**경계 세 곳에서 부모-자식이 정확히 이어졌다.** 자바의 Client 스팬 `416e88e3` 이
파이썬 Server 스팬의 부모이고, 파이썬 Client `e8b63c78` 이 Node Server 의 부모이고,
Node Client `867b3796` 이 Go Server 의 부모다.

이어지는 원리는 HTTP 헤더 하나다.

```
traceparent: 00-a2e88cd3ec3c5a9dd241409a99720f0d-416e88e3...-01
```

나가는 쪽 계측이 이걸 심고, 들어오는 쪽 계측이 읽는다. **서로 다른 회사가 만든
라이브러리끼리도 이 규약만 지키면 이어진다.** 네 언어의 계측은 각각 다른 사람들이
만들었고 서로를 모른다.

## 곁가지로 보이는 것들

트리를 보면 Node 쪽에 `Internal` 스팬이 유독 많다. Express 의 미들웨어와 라우트
핸들러가 각각 스팬으로 잡히기 때문이다. `tcp.connect` 까지 따로 나온다.

**계측의 상세함이 언어·프레임워크마다 다르다.** Node 자동 계측이 특히 촘촘하고,
Go 는 우리가 넣은 만큼만 나온다. 서비스별 스팬 수를 비교할 때 이걸 모르면
"Node 가 유난히 느린가" 하고 오해하게 된다.

그리고 Go 의 Server 스팬이 `0.0ms` 로 찍힌 것도 눈에 띈다. 실제로 하는 일이 없는
핸들러라 그렇다. 밀리초 미만은 반올림되면 0 이 된다.

## 무엇을 확인했나

**하나.** 같은 표준을 쓰면 언어가 달라도 한 트레이스로 묶인다. 설명이 아니라
실제로 그렇다.

**둘.** 붙이는 방법은 언어마다 다르고, **Go 만 설정으로 안 끝난다.** 재빌드하거나
커널 특권을 받아야 한다. 도입 검토할 때 "어떤 언어가 돌고 있는가" 를 먼저 물어봐야
하는 이유다. Go 가 섞여 있으면 설정 작업이 아니라 협의와 일정이 필요하다.

**셋.** 전파기 설정 같은 작은 것 하나로 트레이스가 끊긴다. 데이터가 들어오는 것과
제대로 이어지는 것은 다른 문제라, **처음 붙일 때는 반드시 여러 서비스를 거치는
요청 하나로 확인해봐야 한다.** 서비스 하나만 보면 끊긴 걸 모른다.
