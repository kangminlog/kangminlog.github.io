---
layout: post
title: "산출물을 WAS 에 올린다는 것 — war 와 실행 가능한 jar 는 무엇이 다른가"
date: 2026-10-01 10:00:00 +0900
---

스프링부트로 개발하면 `gradle bootJar` 로 jar 하나가 떨어지고 `java -jar` 로 띄운다.
그런데 현장 문서를 보면 **빌드 산출물을 Tomcat 이나 JEUS 에 올린다**는 서술이 계속 나온다.
같은 자바 웹 애플리케이션인데 왜 두 방식이 있고, 넘어갈 때 무엇이 달라지나.

[왜 상용 WAS 를 쓰는지](/2026/09/30/korean-was-landscape.html)는 따로 적었으므로
여기서는 **배포 모델 자체**만 본다.

## 한 문장으로는 제어가 뒤집힌다

```
java -jar app.jar       애플리케이션이 서버를 품는다   (내장 Tomcat 이 jar 안에 있다)
war → WAS              서버가 애플리케이션을 품는다   (WAS 가 war 를 펼쳐 올린다)
```

누가 `main()` 을 가지고 있고 누가 JVM 프로세스의 주인인가가 반대다.
나머지 차이는 거의 전부 여기서 파생된다.

jar 쪽은 프로세스 하나가 애플리케이션 하나다. 포트도, 커넥션 풀도, 로깅도 애플리케이션이
자기 설정 파일로 들고 있다. war 쪽은 **WAS 프로세스 하나에 애플리케이션 여러 개**가 올라가고,
그 공통 자원은 WAS 가 쥔다.

## WAS 가 원래 풀려던 문제는 역할 분리다

WAS 를 "애플리케이션을 꽂아 쓰는 콘센트" 로 보면 설계 의도가 보인다.

2000년대 초에는 비싼 유닉스 장비 한 대에 여러 업무 애플리케이션을 함께 올리는 것이
당연했다. 그래서 서버가 공통 인프라를 전부 쥐고 있어야 했다 — HTTP 리스너, 스레드 풀,
DB 커넥션 풀, 트랜잭션 매니저, 세션 저장과 클러스터링, 보안 영역.
애플리케이션은 이것들을 각자 들고 있지 않고 **JNDI 이름으로 꺼내 쓴다.**

```java
// 애플리케이션 코드에는 접속 정보가 없다. 이름만 있다.
DataSource ds = (DataSource) new InitialContext().lookup("jdbc/ORCL");
```

접속 주소와 계정은 WAS 설정에 들어간다. 개발팀은 war 만 만들어 넘기고, 운영팀이
WAS 콘솔에서 DB 접속·풀 크기·튜닝·배포를 관리한다.

**이 역할 분리가 WAS 의 본질적 가치다.** DB 비밀번호가 개발자의 `application.yml` 이
아니라 운영팀 소관의 WAS 설정에 있다는 것. 공공·금융·의료 쪽에서 포기하기 어려운 조건이고,
기술 선택이 아니라 조직 구조의 문제다.

## war 로 바꾸면 코드는 생각보다 덜 바뀐다

스프링부트는 war 패키징을 공식 지원한다. 바뀌는 것은 세 군데다.

**하나, 내장 Tomcat 을 war 에서 뺀다.** WAS 가 이미 서블릿 컨테이너라서 중복되면 충돌한다.

```groovy
plugins { id 'war' }
dependencies {
    providedRuntime 'org.springframework.boot:spring-boot-starter-tomcat'
}
```

컴파일에는 쓰이고 war 안에는 안 들어가는 자리가 `providedRuntime` 이다.

**둘, 진입점을 하나 만든다.**

```java
public class ServletInitializer extends SpringBootServletInitializer {
    @Override
    protected SpringApplicationBuilder configure(SpringApplicationBuilder b) {
        return b.sources(DemoApplication.class);
    }
}
```

**셋, `main()` 은 호출되지 않는다.** 지워도 되고 로컬 실행용으로 남겨도 되지만,
WAS 에 올라갈 때 쓰이지 않는다. WAS 가 war 를 펼쳐
`ServletContainerInitializer` 규약으로 이 클래스를 찾아 스프링 컨텍스트를 올린다.

코드는 이것으로 끝이다. 문제는 코드가 아니라 **그 주변에 깔려 있던 가정들**이다.

## 발이 걸리는 자리는 정해져 있다

**`server.port` 가 무의미해진다.** 포트는 WAS 설정이다. `application.yml` 에
포트를 적어두고 안 바뀐다고 한참 들여다보게 되는 지점이다.

**컨텍스트 경로가 생긴다.** war 파일명이나 WAS 배포 설정에 따라 모든 URL 앞에
`/myapp` 같은 경로가 하나 더 붙는다. 프런트엔드가 절대경로로 API 를 호출하고 있었으면
전부 404 가 된다. jar 로 개발하는 동안은 루트(`/`)였으니 드러나지 않던 결합이다.

**상대경로가 엉뚱한 데를 가리킨다.** 로그 출력이나 파일 업로드 경로를 상대경로로
잡아뒀으면 WAS 의 작업 디렉터리 기준으로 해석된다. 애플리케이션 디렉터리가 아니다.

**라이브러리가 클래스로더 레벨에서 충돌한다.** WAS 가 이미 제공하는 것 —
서블릿 API, JSON 파서, 로깅 구현체 — 과 war 안의 것이 겹친다.
상용 WAS 는 "부모 우선 / 자식 우선" 로딩 정책을 전용 서술 파일로 뒤집어야 해결되는
경우가 많다. WebLogic 은 `weblogic.xml` 의 `prefer-application-packages`,
JEUS 는 `WEB-INF/jeus-web-dd.xml` 이 그 자리다.

**WAS 버전이 JDK 를 묶는다.** 이게 가장 현실적인 제약이다. JEUS 8 이 JDK 8 에
묶여 있으면 애플리케이션 언어 수준도 그 안에서만 움직인다. 라이브러리 최신 버전도
대체로 못 쓴다. jar 로 돌릴 때는 JDK 를 애플리케이션이 고르는데, WAS 에서는
**WAS 가 고른 JDK 를 애플리케이션이 받는다.**

## 배포는 파일을 떨어뜨리거나 명령을 쏜다

Tomcat 은 배포 디렉터리에 war 를 넣으면 펼쳐 올린다.

```
$CATALINA_HOME/webapps/myapp.war   →  /myapp 으로 서비스
```

상용 WAS 는 관리 콘솔이나 CLI 로 배포한다. JEUS 는 `jeusadmin` 에서
`deploy` 명령을 쓴다. WAS 하나에 애플리케이션이 여러 개 올라가 있으니
**애플리케이션만 따로 재배포**할 수 있는 것이 장점이다.

대신 같은 JVM 을 공유한다. **한 애플리케이션이 힙을 다 먹으면 같은 WAS 의 다른 업무가
같이 죽는다.** jar 로 프로세스를 분리했을 때는 생기지 않던 장애 전파 경로다.

## 관측 도구를 붙이는 자리도 달라진다

에이전트를 붙이는 입장에서는 이 차이가 실무에 바로 온다.

jar 실행이면 붙일 자리가 그 명령줄이다.

```bash
java -javaagent:/opt/apm/agent.jar -Dotel.service.name=order-api -jar app.jar
```

WAS 면 붙일 자리가 **WAS 의 기동 환경**이다.

```bash
# Tomcat — bin/setenv.sh
CATALINA_OPTS="-javaagent:/opt/apm/agent.jar -Dotel.service.name=was-01"
```

JEUS·WebLogic 은 도메인 설정의 서버별 JVM 옵션에 넣는다. 여기서 세 가지가 따라온다.

**에이전트 하나가 그 WAS 의 모든 애플리케이션을 함께 계측한다.** 프로세스가 하나니까
당연하다. 그래서 `otel.service.name` 을 하나 박으면 서로 다른 업무의 트레이스가
한 서비스 이름으로 섞인다. 애플리케이션 단위로 보려면 컨텍스트 경로나 배포 단위를
서비스 이름으로 매핑하는 설정을 따로 잡아야 한다. **jar 모델에서는 공짜로 되던 것이
WAS 에서는 설계 항목이 된다.**

**JVM 옵션을 바꾸면 WAS 를 재기동해야 한다.** 그 WAS 에 올라간 업무가 전부 멈춘다는 뜻이다.
jar 하나 재시작과는 승인 절차의 무게가 다르다. 기술적 난이도보다 **재기동 권한이
운영팀에 있다는 조직적 제약**이 더 크게 작용한다.

**JDK 가 선을 긋는다.** 앞의 제약이 그대로 돌아온다. WAS 가 묶어둔 JDK 가 에이전트
하한선보다 낮으면 에이전트는 기동 자체가 안 된다. 이 경계선은
[따로 실측해서 적었다](/2026/09/30/how-old-a-jvm-can-you-instrument.html).

## 직접 확인해보는 가장 짧은 경로

가지고 있는 스프링부트 프로젝트를 war 로 바꿔 Tomcat 10 컨테이너에 올려보면
위에 적은 것이 한 번에 체감된다. Tomcat 10 부터 `javax.*` 가 `jakarta.*` 로 바뀌었으므로
**스프링부트 3 기준으로 맞춰야** 한다.

```bash
./gradlew clean build          # build/libs/demo-0.0.1-SNAPSHOT.war

docker run -d --name war-probe -p 18080:8080 \
  -v $PWD/build/libs/demo-0.0.1-SNAPSHOT.war:/usr/local/tomcat/webapps/demo.war:ro \
  tomcat:10.1-jre17

curl -i http://localhost:18080/           # 404 — 루트에는 없다
curl -i http://localhost:18080/demo/      # 여기에 붙었다
```

war 파일명이 컨텍스트 경로가 되는 것을 두 줄로 확인할 수 있다. 파일명을
`ROOT.war` 로 바꿔 올리면 루트로 붙는다 — 컨텍스트 경로가 코드가 아니라
**배포 산출물의 이름**에 달려 있다는 것이 이 지점에서 드러난다.

JNDI 쪽까지 보려면 `application.yml` 의 datasource 설정을 지우고
`spring.datasource.jndi-name` 으로 바꿔서, 접속 정보가 애플리케이션에서 WAS 로
넘어가는 것을 확인하면 된다.

## 정리

```
jar    애플리케이션이 서버를 품는다   프로세스=애플리케이션   설정도 JDK 도 애플리케이션이 고른다
war    서버가 애플리케이션을 품는다   프로세스=WAS           설정도 JDK 도 WAS 가 고른다
```

신규 개발에서는 jar 단독 실행이 사실상 표준이다. WAS 가 제공했던 가치가 다른 층으로
옮겨갔기 때문이다 — 애플리케이션 격리는 컨테이너가, 재시작·헬스체크는 오케스트레이터가,
설정 외부화는 설정 저장소가 맡는다.

그래서 **"산출물을 WAS 에 올린다" 는 서술이 많이 보이는 것은 지금 새로 만드는 방식이
그렇다는 뜻이 아니다.** 2000년대부터 구축돼 아직 돌고 있는 시스템과 그 운영 관행이
그만큼 많다는 뜻으로 읽는 편이 맞다. 그리고 그 시스템들이 관측 도구의 주요 대상이므로,
붙이는 쪽에서는 두 모델을 다 알아야 한다.
