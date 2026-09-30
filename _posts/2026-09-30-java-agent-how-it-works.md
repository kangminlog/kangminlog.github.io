---
layout: post
title: "자바 에이전트는 어떻게 코드를 안 고치고 추적하나"
date: 2026-09-30 10:00:00 +0900
---

APM 을 붙일 때 가장 먼저 듣는 질문이 이거다. "우리 애플리케이션을 고쳐야 합니까?"

답은 아니다. 기동 옵션에 한 줄을 넣으면 된다.

```
-javaagent:/opt/otel/opentelemetry-javaagent.jar
```

그런데 이 한 줄이 어떻게 남의 코드에 추적 코드를 끼워 넣는지는 설명이 필요하다.
"마법처럼 된다" 고 넘어가면 나중에 왜 재기동이 필요한지, 왜 JDK 7 에서는 안 되는지를
설명할 수 없다. jar 을 직접 뜯어보면서 정리한다.

## `-javaagent` 는 JVM 기능이다

에이전트는 OpenTelemetry 가 만든 것이지만, **에이전트를 읽어 들이는 기능 자체는
자바 표준**이다. JDK 5 부터 `java.lang.instrument` 패키지로 들어와 있다.

jar 의 매니페스트를 보면 이 계약이 그대로 드러난다.

```
$ unzip -p opentelemetry-javaagent.jar META-INF/MANIFEST.MF

Implementation-Version: 2.31.1
Premain-Class: io.opentelemetry.javaagent.OpenTelemetryAgent
Agent-Class:   io.opentelemetry.javaagent.OpenTelemetryAgent
Can-Redefine-Classes:    true
Can-Retransform-Classes: true
```

`Premain-Class` 가 핵심이다. JVM 은 `-javaagent` 로 지정된 jar 을 열어 이 항목을 읽고,
거기 적힌 클래스의 `premain` 메서드를 **`main` 보다 먼저** 부른다.

```java
public static void premain(String args, Instrumentation inst)
```

두 번째 인자 `Instrumentation` 이 전부다. 이 객체에 "앞으로 로드되는 클래스를 내가
한 번 보겠다" 고 등록할 수 있다. 등록해두면 JVM 이 클래스를 로드할 때마다 바이트 배열을
넘겨주고, 바꿔서 돌려주면 **바뀐 것이 로드된다.**

`Can-Retransform-Classes: true` 는 이미 로드된 클래스도 다시 요청해서 바꿀 수 있다는
선언이다.

## 바이트코드를 어떻게 바꾸나

넘어오는 건 `.class` 파일의 바이트 배열이다. 이걸 직접 다루는 건 고통스러워서
라이브러리를 쓴다. jar 안을 보면 뭘 쓰는지 나온다.

```
$ unzip -l opentelemetry-javaagent.jar | grep -oiE "bytebuddy|asm/" | sort -u
ByteBuddy
asm/
```

ASM 은 바이트코드를 읽고 쓰는 저수준 라이브러리이고, Byte Buddy 는 그 위에서
"이런 시그니처의 메서드를 찾아 앞뒤에 코드를 끼워라" 를 선언적으로 쓰게 해준다.

개념적으로는 이런 일이 일어난다. 원래 코드가

```java
public void doGet(HttpServletRequest req, HttpServletResponse resp) {
    // 원래 하던 일
}
```

였다면, 로드 시점에 이렇게 바뀐 바이트코드가 들어간다.

```java
public void doGet(HttpServletRequest req, HttpServletResponse resp) {
    Span span = tracer.spanBuilder("GET /orders").startSpan();
    try {
        // 원래 하던 일
    } finally {
        span.end();
    }
}
```

소스 파일은 그대로다. 빌드 산출물도 그대로다. **메모리에 올라가는 순간의 모습만
다르다.** 그래서 "코드를 고치지 않는다" 는 말이 성립한다.

## 무엇을 감쌀지는 어떻게 아나

프레임워크마다 감쌀 지점이 다르다. Servlet 은 `service()`, JDBC 는 `Statement.execute()`,
HTTP 클라이언트는 각자의 `execute()` 다. 그래서 에이전트는 프레임워크별 규칙을
모아 들고 다닌다.

```
$ unzip -l opentelemetry-javaagent.jar | grep -oE "instrumentation/[a-z0-9-]+/" | sort -u | wc -l
140
```

계측 모듈 디렉터리만 140 개다. Spring, Tomcat 같은 WAS, 각종 JDBC 드라이버, Kafka,
gRPC, Redis 클라이언트 등이 각각 들어 있다. jar 이 25 MB 나 되는 이유가 이것이다.

에이전트는 클래스가 로드될 때 "이건 내가 아는 프레임워크인가" 를 확인하고, 아는
것이면 해당 모듈의 규칙을 적용한다. 모르는 프레임워크는 그냥 지나간다. 그래서
**전용 모듈이 없는 WAS 라도 Servlet 규격만 지키면 범용 Servlet 모듈로 붙는다.**

## 왜 재기동이 필요한가

`premain` 은 이름 그대로 **`main` 보다 먼저** 한 번 불린다. JVM 이 시작할 때가 아니면
부를 기회가 없다. `-javaagent` 를 나중에 추가해도 이미 돌고 있는 JVM 은 그 옵션을
다시 읽지 않는다. 그래서 재기동이 필요하다.

`Agent-Class` 항목이 매니페스트에 있는 걸 보고 "런타임에 붙일 수 있는 것 아닌가" 하고
생각할 수 있다. 실제로 JVM 에는 돌고 있는 프로세스에 에이전트를 붙이는 Attach API 가
있고, 그 진입점이 `agentmain` 이다.

다만 OpenTelemetry 에서 지원하는 경로는 별도 라이브러리(`RuntimeAttach`)를 통해
**애플리케이션 `main()` 첫 부분에서 스스로를 붙이는** 방식이다. 조건도 붙는다 —
JRE 가 아닌 JDK 여야 하고, 메인 스레드의 `main` 에서 호출해야 하고, 임시 디렉터리에
쓸 수 있어야 한다.

정리하면 **코드를 고치고 다시 띄워야 한다.** 재기동을 피하려고 찾은 길인데 코드 수정이
추가로 붙는 셈이라, 실무에서는 그냥 옵션 한 줄 넣고 재기동하는 쪽이 빠르다.

## 왜 JDK 8 이상인가

에이전트 진입 클래스의 바이트코드 버전을 보면 나온다.

```
$ unzip -p opentelemetry-javaagent.jar \
    io/opentelemetry/javaagent/OpenTelemetryAgent.class | head -c 8 | od -An -tu1
  202 254 254 186   0   0   0  52
                                ^^
```

끝의 `52` 가 메이저 버전이다. 44 를 더하면 자바 버전이 되는 규칙이라 **Java 8** 이다.
JDK 7 JVM 은 51 까지만 읽으므로 이 클래스를 거부한다 — `UnsupportedClassVersionError` 로
기동 자체가 안 된다.

여기서 흔한 오해가 하나 있다. "구버전 에이전트를 쓰면 되지 않나" 다. 1.x 계열의
마지막 판인 1.33.6 을 똑같이 뜯어보면 **역시 52** 다. 구버전을 써도 JDK 7 에서는 안 된다.
국내 현장에는 JDK 6·7 로 도는 WAS 가 아직 있으므로, 붙이기 전에 **WAS 가 실제로 쓰는
JVM** 으로 확인하는 편이 좋다. 서버에 JDK 가 여러 개 깔려 있는 경우가 흔하다.

## 별도 프로세스가 뜨지 않는다

에이전트는 데몬이 아니다. `premain` 도, 그 뒤에 도는 수집·전송 코드도 **감시 대상과
같은 JVM 안**에서 돈다. 프로세스 목록에 새로 뜨는 것이 없고, 열어야 할 포트도 없다.

장점은 설치가 가볍다는 것이고, 대가는 같은 운명을 진다는 것이다. 에이전트가
메모리를 많이 쓰면 애플리케이션이 그만큼 못 쓴다. 그래서 프로덕션에 넣을 때는
대표 인스턴스 한 대에 먼저 붙여 재보고 확대하는 순서를 권한다.

## 되돌리기

추가한 옵션을 지우고 재기동하면 끝이다. 설치한 서비스도, 고친 설정 파일도, 남은
프로세스도 없다. jar 파일 하나만 지우면 흔적이 사라진다.

붙이는 것도 떼는 것도 같은 비용이라는 점이 이 방식의 가장 큰 장점이라고 생각한다.

## 확인하는 법

제대로 올라왔는지는 기동 로그에서 본다.

```
[otel.javaagent 2026-09-30 00:19:03] INFO io.opentelemetry.javaagent.tooling.VersionLogger
  - opentelemetry-javaagent - version: 2.31.1
```

이 줄이 없으면 에이전트가 아예 안 읽힌 것이다. 경로 오타나 권한 문제인 경우가 대부분이다.
