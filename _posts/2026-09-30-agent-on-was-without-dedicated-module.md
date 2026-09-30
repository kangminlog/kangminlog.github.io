---
layout: post
title: "전용 계측 모듈이 없는 WAS 에 에이전트를 붙일 수 있나"
date: 2026-09-30 13:05:00 +0900
---

OpenTelemetry 자바 에이전트를 도입할 때 자주 부딪히는 질문이 있다.

**"우리 WAS 를 지원합니까?"**

지원 목록에 없으면 안 되는 걸까. jar 을 뜯어보고, 실제로 붙여서 확인한 결과를
정리한다.

## 전용 모듈이 있는 WAS 와 없는 WAS

에이전트가 들고 다니는 계측 모듈을 통째로 뽑아보면 나온다.

```
$ unzip -l opentelemetry-javaagent.jar \
  | grep -oE "instrumentation/[a-z0-9_-]+/" | sed 's|.*/\([a-z0-9_-]*\)/|\1|' | sort -u
```

WAS 계열만 추리면 이렇다.

```
있음   tomcat  jetty  undertow  payara  liberty  grizzly  quarkus  helidon
       netty  vertx  ratpack
없음   WebLogic  WebSphere  JEUS  JBoss/WildFly
```

상용 WAS 상당수에 전용 모듈이 없다. 오픈소스 프로젝트가 라이선스 있는 제품을
받아 시험하기 어려우니 자연스러운 결과다.

## 그런데 전용 모듈이 없어도 붙는다

에이전트에는 **규격 기반 모듈**이 따로 있다.

```
$ unzip -l opentelemetry-javaagent.jar | grep -oE "instrumentation/servlet/[a-z0-9_.-]+/"
instrumentation/servlet/common/
instrumentation/servlet/v2_2/
instrumentation/servlet/v3_0/
instrumentation/servlet/v5_0/
```

제품 이름이 아니라 **Servlet 규격 버전**으로 나뉘어 있다. WAS 가 어느 회사 것이든
Servlet 규격을 구현했다면 그 규격의 모듈이 붙는다.

```
Servlet 2.2 ~ 2.5   →  v2_2     javax, 비동기 없음
Servlet 3.0 ~ 4.0   →  v3_0     javax, 비동기 있음
Servlet 5.0 이상    →  v5_0     jakarta 로 패키지가 바뀜
```

JDBC 도 같은 구조다. 드라이버별이 아니라 **JDBC 인터페이스 레벨**에서 감싼다
(`jdbc/datasource`, `jdbc/internal`). 그래서 덜 알려진 DB 드라이버라도 표준
인터페이스만 구현했다면 질의 추적이 된다.

## 그 경로가 실제로 작동하는지 확인했다

"이론상 붙는다" 와 "실제로 스팬이 들어온다" 는 다르다. 규격별로 대리 컨테이너를
띄워서 에이전트 → 수집기 → 저장소 → 조회까지 전 구간을 확인했다.

| 컨테이너 | Servlet | JDK | 결과 |
|---|---|---|---|
| Tomcat 6 | 2.5 | 8 | 스팬 3 · 트레이스 3 · `GET /index.html` |
| Tomcat 7 | 3.0 | 8 | 스팬 3 · 트레이스 3 · `GET /index.jsp` |
| Tomcat 9 | 4.0 | 8 | 스팬 6 · 트레이스 3 |
| Tomcat 10.1 | 6.0 (jakarta) | 17 | 스팬 6 · 트레이스 3 |

전부 `SpanKind = Server` 로 진입 스팬이 잡히고 `http.request.method` 와 `url.path` 가
채워졌다. **네 세대 규격 모두 동작한다.**

시험 방법은 단순하다. 톰캣 기본 페이지도 서블릿이 서빙하므로 **요청 한 번이면
진입 스팬이 생긴다.** 애플리케이션을 만들 필요가 없다.

```bash
docker run -d --name probe -p 18080:8080 \
  -v $PWD/agent.jar:/agent.jar:ro \
  -e JAVA_OPTS="-javaagent:/agent.jar -Dotel.service.name=probe \
                -Dotel.exporter.otlp.endpoint=http://<수집서버>:4318" \
  tomcat:9-jre8
curl http://localhost:18080/
```

## 그래도 남는 위험

**규격이 같아도 구현이 다를 수 있다.** 상용 WAS 는 자체 클래스로더와 자체 서블릿
컨테이너 구현을 쓰는 경우가 많다. 에이전트가 감싸려는 클래스의 이름이나 로딩
시점이 예상과 다르면 안 걸릴 수 있다.

그래서 대리 검증으로 알 수 있는 것은 **"범용 경로 자체가 멀쩡한가"** 까지다.
이게 안 되면 그 WAS 에서도 안 되지만, 이게 된다고 그 WAS 에서 된다는 보장은 아니다.

위험을 줄이는 방법은 순서를 나누는 것뿐이다. **전 인스턴스에 한 번에 붙이지 말고
대표 한 대에 먼저 붙여 기동 로그와 화면을 확인한 뒤 확대한다.** 그 한 대에서
오버헤드도 같이 잴 수 있다.

## 안 걸리면

트레이스는 포기하더라도 완전히 빈손은 아니다. **JMX 로 JVM 지표는 받을 수 있다.**

```yaml
receivers:
  jmx:
    endpoint: <WAS IP>:<JMX 포트>
    target_system: jvm
    collection_interval: 30s
```

힙·GC·스레드·커넥션 풀이 나온다. 애플리케이션을 건드리지 않고 수집기 설정만으로
되므로 **당일에 전환할 수 있다.** 빠지는 것은 요청 단위 추적과 SQL 수행 시간이다.

## 확인 순서

새 WAS 에 붙이기 전에 이 순서로 보면 대체로 답이 나온다.

**하나. JDK 가 8 이상인가.** 에이전트 진입 클래스가 바이트코드 major 52 라
7 이하에서는 기동 자체가 안 된다. 구버전 에이전트를 써도 마찬가지다.
**WAS 가 실제로 쓰는 JVM** 으로 봐야 한다 — 서버에 JDK 가 여럿 깔린 경우가 흔하다.

**둘. Servlet 규격이 몇인가.** WAS 문서에 나온다. 2.2 이상이면 대응 모듈이 있다.

**셋. 전용 모듈이 있는가.** 있으면 더 촘촘한 정보가 나온다. 없어도 규격 모듈로 간다.

**넷. 한 대에 붙여본다.** 여기까지 와도 마지막은 해봐야 안다.

---

정리하면 **"지원 목록에 없다" 가 "안 된다" 는 아니다.** 규격 기반으로 붙기 때문에
목록보다 넓게 커버된다. 다만 **마지막 확인은 실제 장비에서 해야 하고**, 안 될 때의
대안을 미리 정해두는 편이 낫다.
