// 서버와 브라우저가 같이 쓰는 주기 계산. 날짜는 'YYYY-MM-DD' 문자열, 내부 계산은 일(day) 번호.
const DAY = 86400000;
export const toNum = (s) => Math.round(Date.parse(s + 'T00:00:00Z') / DAY);
export const toStr = (n) => new Date(n * DAY).toISOString().slice(0, 10);

const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;

// days: 생리일로 표시한 날짜 목록, today: 오늘 날짜 문자열
export function analyze(days, today) {
  const t = toNum(today);
  const nums = [...new Set(days)].map(toNum).sort((a, b) => a - b);

  // 표시한 날 사이가 5일 이하로 벌어지면 같은 생리로 묶는다
  const periods = [];
  for (const n of nums) {
    const p = periods[periods.length - 1];
    if (p && n - p.end <= 5) p.end = n;
    else periods.push({ start: n, end: n });
  }

  // 15~60일 범위를 벗어난 간격은 기록 누락으로 보고 평균에서 뺀다
  const gaps = [];
  for (let i = 1; i < periods.length; i++) {
    const g = periods[i].start - periods[i - 1].start;
    if (g >= 15 && g <= 60) gaps.push(g);
  }
  const cycleLen = gaps.length ? Math.round(mean(gaps.slice(-6))) : 28;

  // 아직 진행 중일 수 있는 최근 생리는 기간 평균에서 뺀다
  const lens = periods.filter((p) => p.end < t - 1).map((p) => p.end - p.start + 1);
  const periodLen = lens.length ? Math.max(2, Math.round(mean(lens.slice(-6)))) : 5;

  const predictions = [];
  const last = periods[periods.length - 1];
  if (last) {
    for (let k = 1; k <= 6; k++) {
      const start = last.start + k * cycleLen;
      predictions.push({
        start,
        end: start + periodLen - 1,
        ovulation: start - 14,
        fertileStart: start - 19,
        fertileEnd: start - 13,
      });
    }
  }
  return { periods, cycleLen, periodLen, samples: gaps.length, predictions };
}

// 화면 상단과 알림에 쓰는 현재 상태
export function status(a, today) {
  const t = toNum(today);
  const last = a.periods[a.periods.length - 1];
  if (!last) return { kind: 'empty' };
  if (t >= last.start && t <= last.end) return { kind: 'period', day: t - last.start + 1 };
  const next = a.predictions[0].start;
  return { kind: 'waiting', next, diff: next - t };
}
