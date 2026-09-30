---
layout: post
title: "런타임별 자동 계측 붙이기 — 그대로 따라 할 수 있는 실습"
date: 2026-09-30 13:00:00 +0900
---

[앞 글](/2026/09/30/one-trace-four-languages.html)에서 Java → Python → Node → Go 가
하나의 트레이스로 이어지는 것을 보였다. 이 글은 **그걸 그대로 재현하는 방법**이다.

빌드 환경을 따로 만들지 않고 각 언어 이미지에 소스만 마운트한다. 도커와 수집기
주소만 있으면 된다.

---

## 0. 준비

수집기가 OTLP/HTTP 를 4318 에서 받고 있다고 가정한다. 아래 명령의 `<수집서버>` 를
그 주소로 바꾼다. 수집기가 없으면 컨테이너 하나로 띄워도 된다.

```bash
docker network create demo-net
mkdir -p demo/{java,python,node,go}
curl -sL -o demo/agent.jar \
  https://github.com/open-telemetry/opentelemetry-java-instrumentation/releases/latest/download/opentelemetry-javaagent.jar
```

체인은 이렇게 흐른다.

```
curl → demo-java → demo-python → demo-node → demo-go
```

---

## 1. Java — `-javaagent`

**빌드가 필요 없다.** JSP 를 쓰면 톰캣이 실행 시점에 컴파일한다.

`demo/java/index.jsp`

```jsp
<%@ page import="java.io.*,java.net.*" %><%
String r;
try {
  HttpURLConnection c = (HttpURLConnection) new URL("http://demo-python:5000/work").openConnection();
  c.setConnectTimeout(5000); c.setReadTimeout(10000);
  BufferedReader br = new BufferedReader(new InputStreamReader(c.getInputStream()));
  StringBuilder sb = new StringBuilder(); String l;
  while ((l = br.readLine()) != null) sb.append(l);
  r = sb.toString();
} catch (Exception e) { r = "ERR " + e; }
%>java -> <%= r %>
```

```bash
docker run -d --name demo-java --network demo-net -p 18090:8080 \
  -v $PWD/demo/agent.jar:/agent.jar:ro \
  -v $PWD/demo/java:/usr/local/tomcat/webapps/ROOT \
  -e JAVA_OPTS="-javaagent:/agent.jar \
                -Dotel.service.name=demo-java \
                -Dotel.exporter.otlp.endpoint=http://<수집서버>:4318 \
                -Dotel.metrics.exporter=none -Dotel.logs.exporter=none \
                -Dotel.bsp.schedule.delay=1000" \
  tomcat:9-jre8
```

`otel.bsp.schedule.delay` 는 배치 전송 주기다. 기본이 5 초라 실습에서 답답하니
1 초로 줄였다. 운영에서는 기본값을 쓴다.

확인 — 기동 로그에 이 줄이 있어야 한다.

```
[otel.javaagent ...] INFO ... VersionLogger - opentelemetry-javaagent - version: 2.x.y
```

---

## 2. Python — `opentelemetry-instrument`

`demo/python/app.py`

```python
from flask import Flask
import requests
app = Flask(__name__)

@app.route("/work")
def work():
    r = requests.get("http://demo-node:3000/work", timeout=10)
    return "python -> " + r.text
```

```bash
docker run -d --name demo-python --network demo-net -w /app -v $PWD/demo/python:/app \
  -e OTEL_EXPORTER_OTLP_ENDPOINT=http://<수집서버>:4318 \
  -e OTEL_SERVICE_NAME=demo-python \
  -e OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf \
  -e OTEL_METRICS_EXPORTER=none -e OTEL_LOGS_EXPORTER=none \
  python:3.11-slim sh -c "pip install -q flask requests opentelemetry-distro \
    opentelemetry-exporter-otlp-proto-http && \
    opentelemetry-bootstrap -a install && \
    opentelemetry-instrument flask run --host 0.0.0.0 --port 5000"
```

`opentelemetry-bootstrap -a install` 이 핵심이다. **설치된 패키지를 훑어 그에 맞는
계측 패키지를 알아서 깐다.** Flask 가 있으면 Flask 계측을, requests 가 있으면
requests 계측을 넣는다. 이걸 빼먹으면 `opentelemetry-instrument` 를 붙여도
아무것도 안 잡힌다.

`OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf` 도 필요하다. 파이썬 배포판은
기본이 gRPC 인데, gRPC 판을 쓰려면 `grpcio` 를 따로 깔아야 한다.

---

## 3. Node.js — `--require`

`demo/node/server.js`

```javascript
const express = require('express');
const http = require('http');
const app = express();
app.get('/work', (req, res) => {
  http.get('http://demo-go:8000/work', (r) => {
    let b = ''; r.on('data', c => b += c);
    r.on('end', () => res.send('node -> ' + b));
  }).on('error', e => res.send('node -> ERR ' + e.message));
});
app.listen(3000);
```

```bash
docker run -d --name demo-node --network demo-net -w /app -v $PWD/demo/node:/app \
  -e OTEL_EXPORTER_OTLP_ENDPOINT=http://<수집서버>:4318 \
  -e OTEL_SERVICE_NAME=demo-node \
  -e OTEL_TRACES_EXPORTER=otlp \
  -e OTEL_METRICS_EXPORTER=none -e OTEL_LOGS_EXPORTER=none \
  node:20-slim sh -c "npm i -s express @opentelemetry/api \
    @opentelemetry/auto-instrumentations-node @opentelemetry/sdk-node \
    @opentelemetry/exporter-trace-otlp-http && \
    node --require @opentelemetry/auto-instrumentations-node/register server.js"
```

`--require` 는 애플리케이션보다 먼저 모듈을 읽으라는 노드 옵션이다. 그 모듈이
`require` 를 가로채서 Express·http 같은 것들을 감싼다.

---

## 4. Go — 소스에 SDK

Go 는 다른 언어처럼 **실행 중인 프로세스에 붙는 에이전트가 없다.** 아래는 소스에
SDK 를 넣는 방식이고, 대안은 이 글 끝에 적었다.

`demo/go/main.go`

```go
package main

import (
	"context"
	"net/http"

	"go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	semconv "go.opentelemetry.io/otel/semconv/v1.26.0"
)

func main() {
	ctx := context.Background()
	exp, err := otlptracehttp.New(ctx)   // OTEL_EXPORTER_OTLP_ENDPOINT 를 읽는다
	if err != nil { panic(err) }
	res, _ := resource.New(ctx, resource.WithAttributes(semconv.ServiceName("demo-go")))
	tp := sdktrace.NewTracerProvider(sdktrace.WithBatcher(exp), sdktrace.WithResource(res))
	otel.SetTracerProvider(tp)
	otel.SetTextMapPropagator(propagation.TraceContext{})   // ← 빠뜨리면 트레이스가 끊긴다
	defer tp.Shutdown(ctx)

	h := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte("go(end)"))
	})
	http.Handle("/work", otelhttp.NewHandler(h, "GET /work"))
	http.ListenAndServe(":8000", nil)
}
```

`demo/go/go.mod`

```
module demo

go 1.22

require (
	go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp v0.58.0
	go.opentelemetry.io/otel v1.33.0
	go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp v1.33.0
	go.opentelemetry.io/otel/sdk v1.33.0
)
```

```bash
docker run -d --name demo-go --network demo-net -w /src -v $PWD/demo/go:/src \
  -e OTEL_EXPORTER_OTLP_ENDPOINT=http://<수집서버>:4318 \
  -e OTEL_SERVICE_NAME=demo-go \
  golang:1.23 sh -c "go mod tidy && go run main.go"
```

`SetTextMapPropagator` 를 빼면 **스팬은 들어오는데 트레이스가 갈라진다.**
Go SDK 는 전파기를 기본으로 켜주지 않는다. 처음 하면 여기서 제일 오래 헤맨다.

---

## 5. 돌려보기

Go 빌드와 npm·pip 설치가 끝나야 체인이 뚫린다. 1~3 분 걸린다.

```bash
curl http://localhost:18090/
# java -> python -> node -> go(end)
```

이 문자열이 나오면 네 서비스가 서로 호출한 것이다. 이제 트레이스를 본다.

---

## 6. 이어졌는지 확인하기

**서비스 하나만 보면 이어졌는지 모른다.** 여러 서비스를 거친 요청 하나를 잡아
`TraceId` 가 같은지 봐야 한다.

ClickHouse 에 저장했다면 이렇게 센다.

```sql
SELECT TraceId,
       uniqExact(ServiceName) AS langs,
       count() AS spans,
       arrayStringConcat(arraySort(groupUniqArray(ServiceName)), ' > ') AS services
FROM otel.otel_traces
WHERE ServiceName LIKE 'demo-%' AND Timestamp > now() - INTERVAL 15 MINUTE
GROUP BY TraceId HAVING langs > 1
ORDER BY langs DESC, spans DESC LIMIT 5
```

```
TraceId                            langs  spans  services
a2e88cd3ec3c5a9dd241409a99720f0d     4      11   demo-go > demo-java > demo-node > demo-python
```

`langs = 4` 가 나오면 성공이다. 부모-자식까지 보려면 이렇게 펼친다.

```sql
SELECT ServiceName, SpanKind, SpanName,
       round(Duration/1e6,1) AS ms,
       if(ParentSpanId='', '(root)', substring(ParentSpanId,1,8)) AS parent,
       substring(SpanId,1,8) AS self
FROM otel.otel_traces
WHERE TraceId = '<위에서 나온 값>'
ORDER BY Timestamp
```

---

## 7. 안 될 때 보는 곳

**아무것도 안 들어온다** — 수집기 주소가 맞는지, 컨테이너에서 그 주소에 닿는지
먼저 본다. 네트워크가 다르면 서로 못 찾는다.

```bash
docker exec demo-python curl -s -o /dev/null -w '%{http_code}\n' http://<수집서버>:4318/v1/traces
```

405 가 나오면 리스너는 살아 있다는 뜻이다(GET 을 안 받을 뿐).

**한 언어만 안 들어온다** — 그 언어의 계측이 안 걸린 것이다. 파이썬이면
`opentelemetry-bootstrap -a install` 을 했는지, 노드면 `--require` 경로가 맞는지 본다.

**스팬은 들어오는데 트레이스가 갈라진다** — 전파기 문제다. Go 면
`SetTextMapPropagator`, 다른 언어면 나가는 HTTP 호출이 계측된 클라이언트를
쓰는지 본다. 계측 안 된 클라이언트로 부르면 헤더가 안 실린다.

**스팬 수가 언어마다 크게 다르다** — 정상이다. 자동 계측의 촘촘함이 언어·프레임워크
마다 다르다. Node 자동 계측은 미들웨어와 라우트 핸들러까지 각각 잡아서 유독 많다.
**서비스별 스팬 수를 그냥 비교하면 오해한다.**

---

## 8. 정리

```
Java     -javaagent:agent.jar                       코드 수정 없음
Python   opentelemetry-bootstrap -a install
         opentelemetry-instrument <명령>             없음
Node     node --require @otel/.../register <파일>    없음
Go       소스에 SDK + SetTextMapPropagator          필요
```

세 언어는 **실행 명령만 바꾸면 된다.** Go 만 다르다.

Go 에도 코드를 안 고치는 길이 없지는 않다. 셋 중 하나를 골라야 한다.

| 경로 | 대가 |
|---|---|
| 소스에 SDK (위 예시) | 코드 수정 + 재빌드 |
| 컴파일 타임 계측 | 코드는 그대로, **재빌드 필요** |
| eBPF 자동 계측 | 코드·빌드 그대로, **커널 특권 필요** (`CAP_SYS_ADMIN` 또는 5.8+ 의 `CAP_BPF`) |

eBPF 방식은 `opentelemetry-go-instrumentation` 으로 나와 있고 2026-09 기준 `v0.24.0` 이다.
아직 0.x 이고, 감시 대상에 특권을 줘야 하므로 보안 심사가 있는 환경에서는 쉽지 않다.

**어느 쪽이든 "실행 명령에 한 줄" 로는 안 된다** 는 점이 다른 세 언어와의 차이다.

그리고 네 언어 모두 **환경변수 이름이 같다.**

```
OTEL_SERVICE_NAME
OTEL_EXPORTER_OTLP_ENDPOINT
OTEL_EXPORTER_OTLP_PROTOCOL
```

여러 언어가 섞인 환경이면 시스템 속성 대신 환경변수로 통일하는 편이 관리가 쉽다.
자바도 `-D` 대신 이 환경변수를 읽는다.
