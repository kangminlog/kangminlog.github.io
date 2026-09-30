---
layout: post
title: "APM 백엔드에서 집계를 적재 시점으로 옮기기 — ClickHouse 롤업"
date: 2026-09-30 14:00:00 +0900
---

APM 백엔드가 푸는 문제는 한 문장으로 요약된다. **저장은 한 건씩 하는데 화면은 늘
집계를 본다.**

들어오는 것은 스팬 한 줄, 로그 한 줄이다. 그런데 사람이 보는 화면은 "서비스별 평균
응답시간", "분당 요청 수", "오류율 추이" 다. 매번 원본을 다 읽어 접으면 데이터가 쌓일수록
화면이 느려진다. 그것도 선형으로 느려진다.

ClickHouse 로 APM 백엔드를 만들 때 이 문제를 어떻게 다루는지 정리한다.

## 왜 GROUP BY 가 비싼가

서비스 목록 화면을 만든다고 하자. 서비스는 열두 개뿐이다.

```sql
SELECT ServiceName,
       count()                          AS spans,
       sum(Duration) / count()          AS avg_dur,
       quantileTDigest(0.95)(Duration)  AS p95
FROM otel_traces
WHERE Timestamp >= ? AND Timestamp <= ?
GROUP BY ServiceName
```

결과는 열두 줄이다. 그런데 사흘 치를 조회하면 스팬은 수억 건이다. **결과가 열두 줄이든
말든 수억 행의 컬럼을 읽어야 한다.** 해시 테이블이 큰 게 문제가 아니라, 읽는 행 수 자체가
비용이다.

컬럼 지향 저장이라 필요한 컬럼만 읽고 압축도 잘 되지만, 그래도 행 수에 비례한다.
조회 범위를 늘리면 정직하게 느려진다.

## 적재 시점에 미리 접는다

해법은 오래된 것이다. **읽을 때 접지 말고 쓸 때 접는다.**

ClickHouse 는 이걸 `AggregatingMergeTree` + 머티리얼라이즈드 뷰로 한다. 원본 테이블에
insert 가 들어오면 뷰가 그 배치를 받아 집계한 결과를 별도 테이블에 쓴다.

분 단위로 접으면 이렇게 된다.

```
원본     사흘 × 수억 행
롤업     12 서비스 × 1,440 분 × 3 일 ≈ 5.2 만 행
```

읽을 양이 네 자릿수 단위로 줄어든다. 그리고 **데이터가 쌓여도 롤업 행 수는 시간에만
비례한다.** 트래픽이 열 배로 늘어도 롤업은 그대로다. 이게 핵심이다.

## 합칠 수 있는 값과 없는 값

여기서 한 번 걸린다. 모든 집계가 부분합에서 다시 합쳐지는 건 아니다.

`count` 와 `sum` 은 쉽다. 분 단위 부분합을 더하면 시간 단위가 되고, 또 더하면 일 단위가
된다. 이런 건 `SimpleAggregateFunction` 으로 값만 들고 있으면 된다.

```sql
`Spans`    SimpleAggregateFunction(sum, UInt64),
`ErrSpans` SimpleAggregateFunction(sum, UInt64),
`DurSum`   SimpleAggregateFunction(sum, UInt64),
`LastSeen` SimpleAggregateFunction(max, DateTime64(9))
```

평균은 따로 저장할 필요가 없다. 평균의 평균은 틀리지만 **합과 건수를 들고 있으면
언제든 나눠서 만들 수 있다.** `DurSum / Spans` 면 된다.

문제는 **백분위와 고유 개수**다. p95 의 p95 는 아무 의미가 없다. 값을 버리고 나면 다시
만들 방법이 없다. 그래서 이 둘은 **값이 아니라 중간 상태**를 저장한다.

```sql
`DurQ`  AggregateFunction(quantileTDigest, UInt64),
`Users` AggregateFunction(uniqExact, String)
```

쓸 때는 `State` 를 붙여 상태를 만들고,

```sql
quantileTDigestState(Duration) AS DurQ,
uniqExactState(userKey)        AS Users
```

읽을 때 `Merge` 로 합친다.

```sql
quantileTDigestMerge(0.95)(DurQ) AS p95,
uniqExactMerge(Users)            AS users
```

t-digest 는 분포를 요약한 작은 구조체라 합쳐도 백분위가 나온다. `uniqExact` 는 값의
집합을 그대로 들고 있어서 합치면 정확한 고유 개수가 나온다.

`uniqExact` 대신 `uniq` 를 쓰면 상태가 훨씬 작아진다. 대신 근사값이다. 고유 사용자 수처럼
화면에 숫자로 찍히는 값이면 **바꾸는 순간 숫자의 의미가 달라진다는 점**을 염두에 둬야
한다. 카디널리티가 수천~수만 수준이면 `uniqExact` 로 두는 편이 설명하기 쉽다.

## 상태가 얼마나 커지나

`uniqExact` 는 값을 다 들고 있으므로 카디널리티가 높으면 롤업 테이블이 원본만큼
커질 수 있다. 넣기 전에 재보는 게 맞다.

```sql
SELECT uniqExact(userKey) FROM otel_traces WHERE ...
```

이 숫자가 수천이면 걱정할 것이 없고, 수백만이면 `uniq` 로 가거나 롤업 자체를 재고해야
한다. **재보지 않고 정하면 나중에 디스크로 되돌아온다.**

## 롤업과 원본의 조건식이 갈리는 문제

이게 실무에서 가장 조심할 부분이다.

"요청 수" 를 세려면 진입 스팬만 골라야 한다. 조건은 대체로 이렇게 생겼다.

```sql
SpanKind IN ('SPAN_KIND_SERVER', 'SPAN_KIND_CONSUMER') OR ParentSpanId = ''
```

이 조건이 **조회 코드와 머티리얼라이즈드 뷰 정의 두 곳에** 존재한다. 한쪽만 바꾸면
어떻게 될까. 오류가 안 난다. 화면도 멀쩡하다. **숫자만 조용히 틀린다.**

이건 리뷰로 막기 어렵다. 다른 저장소, 다른 언어, 다른 파일이기 때문이다. 그래서
조건식을 코드 상수로 하나 두고, **마이그레이션 SQL 안에 그 문자열이 그대로 들어 있는지
확인하는 시험**을 붙이는 편이 낫다.

```go
func TestRollupMatchesEntrySpanCond(t *testing.T) {
    sql := readMigration(t, "service_metrics_1m.sql")
    if !strings.Contains(norm(sql), norm(entrySpanCond)) {
        t.Error("MV 와 Go 상수가 어긋났다 — 값이 조용히 틀어진다")
    }
}
```

DB 없이 도는 시험이라 어디서든 돌릴 수 있다. 그리고 **일부러 한쪽을 고쳐서 실제로
FAIL 하는지 확인한 뒤에 커밋해야 한다.** 안 깨지는 시험은 있으나 마나다.

## 기존 데이터는 백필한다

뷰는 **만든 다음에 들어오는 insert** 부터 받는다. 이미 쌓인 데이터는 안 들어간다.
그래서 뷰를 만든 뒤 컷오프를 잡고 그 이전 구간을 한 번 밀어 넣는다.

```sql
INSERT INTO service_metrics_1m
SELECT <뷰와 같은 SELECT>
FROM otel_traces
WHERE Timestamp < '<컷오프>'
GROUP BY ServiceName, Bucket
```

버킷이 분 단위라 컷오프에 걸친 분은 양쪽 부분합이 같은 행으로 합쳐진다. 겹쳐도
`AggregatingMergeTree` 가 병합하므로 정확하다.

## 롤업이 원본보다 오래 산다

롤업은 작으니 보존 기간을 길게 잡는 게 자연스럽다. 원본은 30 일, 롤업은 90 일 같은
식이다. 용량 대비 효용이 크다.

대신 **차트에는 보이는데 눌러도 원본이 없는 구간**이 생긴다. 지난 60 일 추이는 그려지는데
그 시점 트레이스를 열면 없다. APM 제품에서 일반적인 동작이지만, 사용자는 처음 보면
버그로 오해한다. 화면에서 설명하든 문서에 적든, 한 번은 짚고 가야 한다.

## 그래서 언제 쓰나

전부 롤업으로 만들 필요는 없다. 판단 기준은 단순하다.

**조회할 때마다 같은 모양으로 접는 화면**이면 롤업이 맞다. 서비스 목록, 엔드포인트 목록,
개요 추이, 사용자 수 같은 것들이다. 축이 고정돼 있고 매번 같은 집계를 한다.

**임의 조건으로 파고드는 화면**이면 원본이 맞다. 트레이스 하나를 열어 보는 것, 특정
속성으로 필터링하는 것은 미리 접어둘 수가 없다.

APM 화면 대부분은 앞쪽이다. 그래서 롤업을 깔아두면 체감이 크게 바뀐다. 원본은 파고들기
위해 남겨두면 된다.
