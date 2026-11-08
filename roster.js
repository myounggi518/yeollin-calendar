'use strict';
/*
 * 근무배치표 (보기 전용)
 * 노션 「월간일정표(근무)」의 일정·근무자·휴무를 읽어 "직원 × 날짜" 표로 만듭니다. 노션에는 쓰지 않습니다.
 *
 * ▶ 직원이 바뀌면 아래 STAFF만 고치면 됩니다.
 *   name    : 표에 보일 이름 (표시 순서 = 이 목록 순서)
 *   aliases : 「근무자」 칸이나 휴무 일정 제목에서 이 직원으로 알아볼 이름들
 */
const ROSTER_START_MONTH = '2026-11';   // 이 달부터 자동 표 사용 (10월까지는 기존 노션 표 유지)

const STAFF = [
  { name: '이득영', aliases: ['이득영', '득영', '이이사', '이사님', '이사'] },
  { name: '양정모', aliases: ['양정모', '양실장'] },
  { name: '정명기', aliases: ['정명기', '명기'] },
  { name: '조인기', aliases: ['조인기', '인기'] },
  { name: '윤상묵', aliases: ['윤상묵', '상묵'] },
  { name: '김영인', aliases: ['김영인', '영인'] },
  { name: '안준용', aliases: ['안준용', '준용'] },
  { name: '정덕수', aliases: ['정덕수', '덕수'] },
  { name: '김상연', aliases: ['김상연', '상연'] },
  { name: '이영범', aliases: ['이영범', '영범'] },
  { name: '김광헌', aliases: ['김광헌', '광헌'] },
];
const ALL_STAFF_WORDS = ['전직원'];             // 근무자 칸에 있으면 11명 전원 근무
const ALL_OFF_WORDS = ['전체휴무', '전직원휴무', '전원휴무']; // 제목에 있으면 11명 전원 휴무
const OFF_WORD = '휴무';
// 오늘(한국시간)까지, 그날 어떤 일정에도 없는 직원은 자동으로 휴무 표시. 아래 직원은 자동 휴무에서 제외
const AUTO_OFF_EXCLUDE = ['이득영', '김광헌'];
// 근무일수·휴무일수를 세지 않는(빈칸으로 두는) 직원
const NO_COUNT = ['이득영', '김광헌'];

// 긴 이름부터 찾아서 지움 → '이이사'가 '이사'로 두 번 잡히는 일 등을 막음
const ALIAS_LIST = STAFF.flatMap((s) => s.aliases.map((a) => [a, s.name])).sort((a, b) => b[0].length - a[0].length);

function findStaff(text) {
  let rest = String(text || '');
  const found = new Set();
  for (const [alias, name] of ALIAS_LIST) {
    if (rest.includes(alias)) { found.add(name); rest = rest.split(alias).join(' '); }
  }
  return found;
}
const allNames = () => new Set(STAFF.map((s) => s.name));
const hasAny = (text, words) => words.some((w) => String(text || '').includes(w));

function rosterMonthAllowed(month, now) {
  const k = new Date(now + 9 * 3600e3);
  const maxIdx = (k.getUTCFullYear() + 1) * 12 + 11;   // 내년 12월까지
  const [y, m] = month.split('-').map(Number);
  const idx = y * 12 + (m - 1);
  const [sy, sm] = ROSTER_START_MONTH.split('-').map(Number);
  return idx >= sy * 12 + (sm - 1) && idx <= maxIdx;
}

function daysOf(month) {
  const [y, m] = month.split('-').map(Number);
  const n = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return Array.from({ length: n }, (_, i) => `${month}-${String(i + 1).padStart(2, '0')}`);
}

// data = loadFromNotion() 결과 (그 달과 겹치는 일정)
// 구조물 체크 가능 여부: 집계 대상 직원 + 그날 근무 기록 있음 + 오늘(한국시간)까지
function structAllowedFor(roster, name, date, now = Date.now()) {
  if (!roster || !roster.structEnabled) return false;
  if (!STAFF.some((s) => s.name === name) || NO_COUNT.includes(name)) return false;
  const today = new Date(now + 9 * 3600e3).toISOString().slice(0, 10);
  if (date > today) return false;
  const s = roster.staff.find((x) => x.name === name);
  const c = s && s.cells[date];
  return !!(c && c.work.length);
}

// struct: { 이름: [날짜...] } (구조물 체크 기록), null = 기능 꺼짐, undefined = 이번에 못 읽음
function buildRoster(month, data, now = Date.now(), struct = null) {
  const days = daysOf(month);
  const first = days[0], last = days[days.length - 1];
  const cells = Object.fromEntries(STAFF.map((s) => [s.name, {}]));
  const eventsByDay = Object.fromEntries(days.map((d) => [d, []]));
  const offNotes = Object.fromEntries(days.map((d) => [d, []]));   // 날짜별 휴무 제목(행사 줄에는 넣지 않음)
  const cell = (name, day) => (cells[name][day] ||= { work: [], off: false });

  for (const e of data.events) {
    const lo = e.startDate > first ? e.startDate : first;
    const hi = e.endDate < last ? e.endDate : last;
    if (lo > hi) continue;
    const range = days.filter((d) => d >= lo && d <= hi);
    const isOff = e.personalOff === OFF_WORD || e.title.includes(OFF_WORD);
    const chip = { title: e.title, color: e.category ? e.category.color : null, url: e.url };

    if (isOff) {
      const who = hasAny(e.title, ALL_OFF_WORDS) ? allNames() : findStaff(`${e.title} ${e.workers}`);
      for (const d of range) {
        offNotes[d].push(e.title);
        for (const n of who) cell(n, d).off = true;
      }
      continue;
    }
    const who = hasAny(e.workers, ALL_STAFF_WORDS) ? allNames() : findStaff(e.workers);
    for (const d of range) {
      eventsByDay[d].push(chip);
      for (const n of who) cell(n, d).work.push(chip);
    }
  }

  // 자동 휴무: 오늘까지의 날짜에서 근무도 휴무도 없는 직원 → 휴무
  const today = new Date(now + 9 * 3600e3).toISOString().slice(0, 10);
  for (const s of STAFF) {
    if (AUTO_OFF_EXCLUDE.includes(s.name)) continue;
    for (const d of days) {
      if (d > today) break;
      const c = cells[s.name][d];
      if (!c || (!c.work.length && !c.off)) cell(s.name, d).off = true;
    }
  }

  const staff = STAFF.map((s) => {
    const c = cells[s.name];
    return {
      name: s.name,
      cells: c,
      workDays: NO_COUNT.includes(s.name) ? null : Object.values(c).filter((x) => x.work.length).length,
      offDays: NO_COUNT.includes(s.name) ? null : Object.values(c).filter((x) => x.off).length,
      // 구조물: 체크한 날짜 목록과 횟수 (집계 제외 직원은 null)
      structDays: (!struct || NO_COUNT.includes(s.name)) ? null : (struct[s.name] || []).filter((d) => d >= first && d <= last),
      structCount: null,
    };
  });
  for (const s of staff) if (s.structDays) s.structCount = s.structDays.length;
  // 색 안내용: 이 달에 나온 업무속성 (많은 순)
  const catCount = new Map();
  for (const e of data.events) if (e.category && !(e.personalOff === OFF_WORD || e.title.includes(OFF_WORD))) {
    const c = catCount.get(e.category.name) || { name: e.category.name, color: e.category.color, n: 0 };
    c.n++; catCount.set(e.category.name, c);
  }
  const categories = [...catCount.values()].sort((a, b) => b.n - a.n).map(({ name, color }) => ({ name, color }));
  return {
    month, days, events: eventsByDay, offNotes, staff, categories, fetchedAt: data.fetchedAt,
    structEnabled: struct !== null,          // 기능이 켜져 있는지
    structUnavailable: struct === undefined, // 켜져 있지만 이번에 기록을 못 읽음
  };
}

module.exports = { buildRoster, rosterMonthAllowed, findStaff, structAllowedFor, ROSTER_START_MONTH, STAFF, NO_COUNT };
