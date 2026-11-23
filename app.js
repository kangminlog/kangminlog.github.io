import { analyze, status, toNum, toStr } from './predict.js';

const $ = (id) => document.getElementById(id);
const KEY = 'cycle-share-v2';
const validDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && Number.isFinite(toNum(s)) && toStr(toNum(s)) === s;
const today = () => { const t = new Date(); return toStr(Math.round(Date.UTC(t.getFullYear(), t.getMonth(), t.getDate()) / 86400000)); };

// 기록: 생리일 목록, 날짜별 메모, 직접 입력한 주기·기간(없으면 null). 이 기기의 브라우저에만 저장한다.
function normalize(o) {
  if (!o || !Array.isArray(o.days)) return null;
  const notes = {};
  for (const [d, t] of Object.entries(o.notes || {})) if (validDate(d) && typeof t === 'string' && t.trim()) notes[d] = t.trim().slice(0, 500);
  const int = (v, lo, hi) => { v = parseInt(v, 10); return v >= lo && v <= hi ? v : null; };
  return { days: [...new Set(o.days.filter(validDate))].sort(), notes, cycle: int(o.cycle, 15, 60), period: int(o.period, 1, 10) };
}
function fromHash() {
  if (!location.hash.startsWith('#d=')) return null;
  const q = new URLSearchParams(location.hash.slice(1));
  let notes = {};
  try { notes = JSON.parse(q.get('n') || '{}'); } catch {}
  const o = normalize({ days: q.get('d').split(',').filter(Boolean), notes, cycle: q.get('c'), period: q.get('p') });
  return o.days.length ? o : null; // 날짜가 하나도 유효하지 않은 링크로 기존 기록을 지우지 않는다
}
function load() { try { return normalize(JSON.parse(localStorage.getItem(KEY))); } catch { return null; } }
function save() { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch {} }

const EMPTY = () => ({ days: [], notes: {}, cycle: null, period: null });
let state = load() || EMPTY();
const incoming = fromHash();
if (incoming) {
  if (JSON.stringify(incoming) !== JSON.stringify(state) &&
      (!state.days.length || confirm('공유받은 기록으로 바꿀까요?\n이 기기에 있던 기록은 덮어씁니다.'))) {
    state = incoming;
    save();
  }
  history.replaceState(null, '', location.pathname + location.search); // 주소창에서 기록을 지운다
}
addEventListener('hashchange', () => location.reload()); // 열린 탭에서 공유 링크를 다시 연 경우

let view = (() => { const [y, m] = today().split('-').map(Number); return { y, m }; })();
let sheetDate = null; // 열려 있는 날짜

const md = (n) => {
  const [, m, d] = toStr(n).split('-').map(Number);
  return `${m}월 ${d}일`;
};

function render() {
  const now = today();
  const a = analyze(state.days, now, state.cycle, state.period);
  const st = status(a, now);

  // 상단 상태
  if (st.kind === 'empty') {
    $('statusMain').textContent = '기록을 시작해 보세요';
    $('statusSub').textContent = '달력에서 생리한 날을 눌러 표시합니다.';
  } else if (st.kind === 'period') {
    $('statusMain').textContent = `생리 ${st.day}일째`;
    $('statusSub').textContent = `다음 예정일 ${md(a.predictions[0].start)}`;
  } else {
    $('statusMain').textContent = st.diff > 0 ? `예정일까지 ${st.diff}일` : st.diff === 0 ? '오늘이 예정일' : `예정일 ${-st.diff}일 지남`;
    $('statusSub').textContent = `예정일 ${md(st.next)} · ${state.cycle ? `주기 ${a.cycleLen}일` : `평균 주기 ${a.cycleLen}일${a.samples ? '' : ' (기본값)'}`}`;
  }

  // 달력
  const period = new Set(state.days);
  const predicted = new Set(), fertile = new Set(), ovulation = new Set();
  for (const p of a.predictions) {
    for (let n = p.start; n <= p.end; n++) predicted.add(toStr(n));
    for (let n = p.fertileStart; n <= p.fertileEnd; n++) fertile.add(toStr(n));
    ovulation.add(toStr(p.ovulation));
  }
  $('monthTitle').textContent = `${view.y}년 ${view.m}월`;
  const first = new Date(Date.UTC(view.y, view.m - 1, 1));
  const count = new Date(Date.UTC(view.y, view.m, 0)).getUTCDate();
  const grid = $('grid');
  grid.replaceChildren();
  for (let i = 0; i < first.getUTCDay(); i++) grid.append(document.createElement('span'));
  for (let d = 1; d <= count; d++) {
    const date = `${view.y}-${String(view.m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const b = document.createElement('button');
    b.textContent = d;
    b.dataset.date = date;
    const labels = [];
    if (period.has(date)) { b.classList.add('period'); labels.push('생리'); }
    else if (predicted.has(date)) { b.classList.add('predicted'); labels.push('생리 예정'); }
    else if (fertile.has(date)) { b.classList.add('fertile'); labels.push('가임기'); }
    if (ovulation.has(date) && !period.has(date)) { b.classList.add('ovulation'); labels.push('배란 예상'); }
    if (date === now) { b.classList.add('today'); labels.push('오늘'); }
    if (state.notes[date]) { b.classList.add('noted'); labels.push('메모 있음'); }
    b.setAttribute('aria-label', `${view.m}월 ${d}일${labels.length ? ', ' + labels.join(', ') : ''}`);
    grid.append(b);
  }

  $('btnToday').textContent = period.has(now) ? '오늘 생리 표시 지우기' : '오늘 생리 표시하기';
}

$('prevMonth').onclick = () => { view.m === 1 ? (view = { y: view.y - 1, m: 12 }) : view.m--; render(); };
$('nextMonth').onclick = () => { view.m === 12 ? (view = { y: view.y + 1, m: 1 }) : view.m++; render(); };

function setDay(date, on) {
  state.days = on ? [...new Set([...state.days, date])].sort() : state.days.filter((d) => d !== date);
  save();
  render();
}
$('btnToday').onclick = () => setDay(today(), !state.days.includes(today()));

// 날짜 시트
$('grid').onclick = (ev) => {
  const b = ev.target.closest('button[data-date]');
  if (!b) return;
  sheetDate = b.dataset.date;
  $('dayTitle').textContent = md(toNum(sheetDate));
  $('dayPeriod').checked = state.days.includes(sheetDate);
  $('dayNote').value = state.notes[sheetDate] || '';
  $('daySheet').returnValue = '';
  $('daySheet').showModal();
};
$('daySheet').onclose = () => {
  if ($('daySheet').returnValue !== 'save') return;
  const text = $('dayNote').value.trim();
  if (text) state.notes[sheetDate] = text; else delete state.notes[sheetDate];
  setDay(sheetDate, $('dayPeriod').checked);
};

// 설정
function cycleHint() {
  const a = analyze(state.days, today());
  $('cycleHint').textContent = a.samples
    ? `기록으로 계산한 평균은 주기 ${a.cycleLen}일, 기간 ${a.periodLen}일이에요. 숫자를 넣으면 그 값을 대신 씁니다.`
    : '주기를 알고 있으면 넣어 주세요. 비워 두면 28일로 계산하다가, 생리가 두 번 이상 기록되면 평균으로 바뀝니다.';
}
$('btnSettings').onclick = () => {
  $('setCycle').value = state.cycle || '';
  $('setPeriod').value = state.period || '';
  cycleHint();
  $('settings').showModal();
};
$('setCycle').onchange = $('setPeriod').onchange = () => {
  state = normalize({ ...state, cycle: $('setCycle').value, period: $('setPeriod').value });
  $('setCycle').value = state.cycle || '';   // 범위를 벗어난 값은 비운다
  $('setPeriod').value = state.period || '';
  save();
  render();
};
$('btnShare').onclick = async () => {
  if (!state.days.length) { alert('먼저 생리한 날을 기록해 주세요.'); return; }
  const q = new URLSearchParams({ d: state.days.join(',') });
  if (state.cycle) q.set('c', state.cycle);
  if (state.period) q.set('p', state.period);
  if (Object.keys(state.notes).length) q.set('n', JSON.stringify(state.notes));
  const url = `${location.href.split('#')[0]}#${q}`;
  if (navigator.share) {
    try { await navigator.share({ title: '우리 주기', url }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  try { await navigator.clipboard.writeText(url); alert('링크를 복사했어요. 대화방에 붙여넣어 보내세요.'); }
  catch { prompt('아래 링크를 복사해서 보내세요.', url); }
};
$('btnReset').onclick = () => {
  if (!confirm('이 기기에 저장된 기록을 모두 지울까요? 되돌릴 수 없어요.')) return;
  state = EMPTY();
  try { localStorage.removeItem(KEY); } catch {}
  $('settings').close();
  render();
};

document.addEventListener('visibilitychange', () => { if (!document.hidden) render(); }); // 날짜가 바뀐 뒤 다시 열었을 때
render();
