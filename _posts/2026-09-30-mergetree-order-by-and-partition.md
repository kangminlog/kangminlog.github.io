---
layout: post
title: "MergeTree 정렬 키와 파티션을 고르는 기준"
date: 2026-09-30 09:10:00 +0900
---

ClickHouse 로 테이블을 만들 때 고민되는 건 대체로 두 줄이다.

```sql
PARTITION BY ...
ORDER BY ...
```

관계형 DB 에서 오면 `ORDER BY` 를 인덱스라고 생각하고, `PARTITION BY` 를 조회 성능
장치라고 생각하기 쉽다. 둘 다 반은 맞고 반은 틀리다. 텔레메트리 데이터를 담는 테이블을
예로 정리한다.

## ORDER BY 는 정렬 순서이자 인덱스다

MergeTree 는 데이터를 `ORDER BY` 순서로 **디스크에 정렬해 저장한다.** 그리고 8,192 행
(`index_granularity` 기본값)마다 첫 행의 키 값을 뽑아 인덱스를 만든다.

```
행 0        ← 인덱스에 기록
행 8,192    ← 인덱스에 기록
행 16,384   ← 인덱스에 기록
```

10 억 행이면 인덱스 항목은 12 만 개다. 통째로 메모리에 올라간다. **행마다 항목을
만들지 않기 때문에 희소 인덱스(sparse index)** 라 부른다.

조회할 때는 이 인덱스로 "몇 번째 덩어리부터 몇 번째까지 읽으면 되는지" 를 정한다.
정확히 한 행을 집어내지 못하고 8,192 행 단위로 읽지만, 10 억 행을 훑는 것에 비하면
비교가 안 된다.

여기서 중요한 성질이 나온다. **이 인덱스는 정렬 순서의 앞쪽부터만 쓸모가 있다.**

```sql
ORDER BY (ServiceName, SpanName, Timestamp)
```

`ServiceName` 으로 좁히면 인덱스가 듣는다. `ServiceName` + `SpanName` 도 듣는다.
그런데 `SpanName` 만 조건에 넣으면 거의 못 듣는다. 전화번호부를 성 다음 이름 순으로
정렬해놓고 이름만으로 찾는 것과 같다.

## 카디널리티가 낮은 것을 앞에

그래서 순서를 정하는 기본 규칙이 나온다. **자주 조건에 들어가면서 값 종류가 적은 것을
앞에 둔다.**

서비스가 열두 개라면 `ServiceName` 이 앞에 오는 게 좋다. 이 컬럼 하나로 데이터가
열두 덩어리로 갈리고, 한 서비스를 조회하면 나머지 11/12 를 안 읽는다.

반대로 `TraceId` 같은 걸 앞에 두면 어떻게 될까. 값이 전부 다르니 인접한 행끼리
공통점이 없다. 정렬해도 덩어리가 안 생기고, 압축률도 나빠진다. **정렬 키는 압축에도
영향을 준다** — 비슷한 값이 붙어 있어야 잘 눌린다.

다만 이건 "대체로" 다. `TraceId` 로 한 건씩 찾는 것이 그 테이블의 주 용도라면
`ORDER BY TraceId` 가 맞다.

```sql
-- 트레이스 하나를 통째로 꺼내는 것이 주 용도인 요약 테이블
ENGINE = AggregatingMergeTree
ORDER BY TraceId
```

용도가 기준이지 규칙이 기준이 아니다.

## PRIMARY KEY 를 따로 둘 수 있다

덜 알려진 기능이다. `PRIMARY KEY` 는 `ORDER BY` 의 **앞부분만** 따로 지정할 수 있다.

```sql
PRIMARY KEY (ServiceName, TimestampTime)
ORDER BY    (ServiceName, TimestampTime, Timestamp)
```

정렬은 세 컬럼으로 하되 **인덱스는 두 컬럼만으로 만든다**는 뜻이다. 세 번째 컬럼은
정렬 순서를 결정하는 데는 쓰이지만 인덱스 항목에는 안 들어간다.

왜 이렇게 하나. 인덱스는 메모리에 상주하므로 컬럼이 늘면 그만큼 메모리를 먹는다.
정렬은 필요한데 인덱스로는 쓸 일이 없는 컬럼이 있다면 빼는 게 이득이다.

## PARTITION BY 는 조회용이 아니다

여기가 가장 많이 오해하는 부분이다.

파티션은 **데이터를 물리적으로 다른 디렉터리에 나눠 담는 것**이다. 조회 성능을 위한
장치가 아니라 **관리를 위한 장치**다. 조회 최적화는 `ORDER BY` 가 한다.

파티션이 많아지면 오히려 손해다. 병합할 대상이 늘고, 조회할 때 열어야 할 파일이
늘어난다. 파티션을 잘게 쪼개서 빨라지는 경우는 드물다.

그러면 왜 나누나. **통째로 버리기 위해서**다.

## 일 단위 파티션 + TTL 의 궁합

텔레메트리 데이터는 오래된 것을 계속 버린다. 이때 날짜로 파티션을 나눠두면 삭제가
공짜에 가까워진다.

```sql
PARTITION BY toDate(Timestamp)
TTL toDate(Timestamp) + toIntervalDay(30)
SETTINGS ttl_only_drop_parts = 1
```

`ttl_only_drop_parts = 1` 이 핵심이다. 이게 없으면 TTL 이 걸릴 때 ClickHouse 는
**만료된 행만 골라내고 파트를 다시 쓴다.** 수억 행을 읽고 다시 쓰는 일이 벌어진다.

파티션이 하루 단위면 그 파티션의 모든 행이 같은 날 만료된다. 그러면 행을 고를 필요 없이
**디렉터리를 지우면 끝이다.** 쓰기 I/O 가 거의 0 이 된다.

반대로 파티션 기준과 TTL 기준이 어긋나 있으면 이 최적화가 안 걸린다. 파티션은
월 단위인데 TTL 은 일 단위라면, 한 달 내내 매일 파트를 다시 쓴다. **둘을 같은 컬럼,
같은 단위로 맞추는 것**이 요령이다.

## 실제 예시 셋

텔레메트리 테이블 세 개를 비교해보면 원칙이 보인다.

```sql
-- 스팬 원본: 서비스 → 스팬 이름 순으로 파고든다
ENGINE       = MergeTree
PARTITION BY toDate(Timestamp)
ORDER BY     (ServiceName, SpanName, toDateTime(Timestamp))
TTL          toDate(Timestamp) + toIntervalDay(30)
SETTINGS     index_granularity = 8192, ttl_only_drop_parts = 1

-- 로그: 서비스 → 시각. 인덱스는 두 컬럼만
ENGINE       = MergeTree
PARTITION BY toDate(TimestampTime)
PRIMARY KEY  (ServiceName, TimestampTime)
ORDER BY     (ServiceName, TimestampTime, Timestamp)

-- 트레이스 요약: 트레이스 하나를 통째로 꺼내는 것이 주 용도
ENGINE       = AggregatingMergeTree
PARTITION BY toDate(Ts)
ORDER BY     TraceId
```

셋 다 파티션은 일 단위로 같고, 정렬 키만 용도에 따라 다르다. **파티션은 버리는 단위,
정렬 키는 찾는 단위**라는 구분이 그대로 드러난다.

## 정할 때 물어볼 것

새 테이블을 만들 때 이 네 가지를 순서대로 답하면 대체로 결론이 난다.

**이 테이블을 무엇으로 조회하나.** 조건절에 가장 자주 들어가는 컬럼이 정렬 키의 앞이다.

**그 컬럼의 값 종류가 몇 개인가.** 적을수록 앞에 두기 좋다. 전부 다른 값이면
그 컬럼 하나로 찾는 용도가 아닌 이상 앞에 두지 않는다.

**언제 버리나.** 버리는 기준 컬럼이 파티션 기준이다. 안 버린다면 파티션을 안 나눠도 된다.

**버리는 주기가 얼마인가.** 그 주기와 파티션 단위를 맞춘다. 30 일 보관이면 일 단위가
무난하다. 1 년 보관이면 월 단위도 괜찮다.

마지막으로 하나. **`ORDER BY` 는 나중에 바꾸기 어렵다.** 컬럼을 뒤에 덧붙이는 정도는
되지만 앞을 바꾸려면 테이블을 새로 만들어 옮겨야 한다. 데이터가 쌓이기 전에 정하는
게 좋다.
