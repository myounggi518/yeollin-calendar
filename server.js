'use strict';
/*
 * 열린기획 월간 일정표 — Notion 읽기 전용 서버 (v2)
 * - 외부 패키지 없이 Node.js 20+ 기본 기능만 사용합니다.
 * - 원본 월간일정표에는 "조회(query)"만 합니다. 쓰기는 「🏗️ 구조물 체크 기록」 DB에만, 그 DB 전용 키로 합니다.
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// ── 설정 ────────────────────────────────────────────────────────────
const PORT = Number(process.env.PORT) || 3000;
const NOTION_API_KEY = process.env.NOTION_API_KEY || '';
const CALENDAR_PASSWORD = process.env.CALENDAR_PASSWORD || '';
const DATA_SOURCE_ID = process.env.NOTION_DATA_SOURCE_ID || '272d2f7f-5131-8205-b193-87613435dcf2';
const NOTION_API_BASE = process.env.NOTION_API_BASE || 'https://api.notion.com'; // 테스트 때만 바꿉니다
// 구조물 체크용(쓰기): 「🏗️ 구조물 체크 기록」 DB에만 연결된 별도 통합 키. 없으면 구조물 체크 기능은 꺼집니다.
const NOTION_WRITE_KEY = process.env.NOTION_WRITE_KEY || '';
const STRUCT_DATA_SOURCE_ID = process.env.STRUCT_DATA_SOURCE_ID || '18001b84-b4c0-40ae-ba4d-f92ce77bcd7c';
const NOTION_VERSION = '2025-09-03';
const TITLE_PROP = '일정명 / Tasks';
const DATE_PROP = '날짜';
const CATEGORY_PROP = '업무속성'; // 일정 색 구분 기준 (노션 선택지 색을 그대로 사용)
const WORKERS_PROP = '근무자';
const PERSONAL_OFF_PROP = '개인휴무';
const { buildRoster, rosterMonthAllowed, ROSTER_START_MONTH, structAllowedFor } = require('./roster');

const SERVER_CACHE_MS = Number(process.env.SERVER_CACHE_MS ?? 60 * 1000); // 같은 데이터를 1분 동안 여러 직원이 공유 → Notion 호출 절약
const STALE_MAX_MS = 24 * 60 * 60 * 1000;   // Notion 장애 시 최대 24시간 전 데이터까지 대신 제공
const NOTION_TIMEOUT_MS = 10 * 1000;
const MAX_PAGES = 20;                        // 최대 2,000건
const TOKEN_DAYS = 30;                       // 암호 입력 후 30일 동안 다시 묻지 않음
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
// CALENDAR_PASSWORD를 비워두면 암호 없이 누구나 볼 수 있습니다(보기 전용). 값을 넣으면 암호 화면이 다시 켜집니다.
const AUTH_ENABLED = CALENDAR_PASSWORD.length > 0;

const INDEX_HTML = fs.readFileSync(path.join(__dirname, 'public', 'index.html'));
const ROSTER_HTML = fs.readFileSync(path.join(__dirname, 'public', 'roster.html'));
const CLOCK_HTML = fs.readFileSync(path.join(__dirname, 'public', 'clock.html'));
const GEAR_HTML = fs.readFileSync(path.join(__dirname, 'public', 'gear.html'));

// ── 공통 도구 ───────────────────────────────────────────────────────
class AppError extends Error { constructor(code) { super(code); this.code = code; } }

const ERRORS = {
  BAD_PASSWORD:      [401, '캘린더 암호가 맞지 않습니다.'],
  AUTH_REQUIRED:     [401, '암호를 다시 입력해 주세요.'],
  TOO_MANY:          [429, '요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.'],
  NOT_CONFIGURED:    [503, '서버 설정(NOTION_API_KEY)이 필요합니다.'],
  NOTION_AUTH:       [502, '노션 연결 키가 유효하지 않습니다. 관리자에게 알려 주세요.'],
  NOTION_NOT_SHARED: [502, '노션 데이터베이스에 연결(통합) 권한이 없습니다. 관리자에게 알려 주세요.'],
  NOTION_RATE_LIMIT: [503, '노션 요청 한도를 잠시 초과했습니다. 곧 자동으로 다시 시도합니다.'],
  NOTION_TIMEOUT:    [504, '노션 응답이 늦습니다. 곧 자동으로 다시 시도합니다.'],
  NOTION_NETWORK:    [502, '노션 서버에 연결하지 못했습니다. 곧 자동으로 다시 시도합니다.'],
  NOTION_DOWN:       [502, '노션 서버에 일시적인 문제가 있습니다. 곧 자동으로 다시 시도합니다.'],
  NOTION_ERROR:      [502, '노션 일정 조회에 실패했습니다. 관리자에게 알려 주세요.'],
  TOO_MANY_RESULTS:  [502, '조회 결과가 너무 많습니다. 관리자에게 알려 주세요.'],
  BAD_REQUEST:       [400, '잘못된 요청입니다.'],
  COMMENT_DENIED:    [502, '노션 댓글 권한이 꺼져 있습니다. 관리자에게 알려 주세요.'],
  ALREADY_SENT:      [429, '방금 알림을 보냈습니다. 1분 뒤에 다시 보낼 수 있어요.'],
  STRUCT_DISABLED:   [503, '구조물 체크 기능이 아직 설정되지 않았습니다. 관리자에게 알려 주세요.'],
  STRUCT_NOT_ALLOWED:[400, '근무한 날(오늘까지)에만 구조물 체크를 할 수 있습니다.'],
  NOT_FOUND:         [404, '페이지를 찾을 수 없습니다.'],
};

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest();
const safeEqual = (a, b) => crypto.timingSafeEqual(sha256(a), sha256(b));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function sendJson(res, status, obj, extraHeaders = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(body);
}
function sendError(res, code, extra = {}) {
  const [status, message] = ERRORS[code] || ERRORS.NOTION_ERROR;
  sendJson(res, status, { error: message, code, ...extra });
}

function setSecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  // 임베드 제한 없음: 휴대폰 Notion 앱은 앱 내부 주소(웹 주소가 아님)에서 화면을 띄우기 때문에
  // frame-ancestors로 노션 웹 주소만 허용하면 앱에서 빈칸이 됩니다. 보기 전용 화면이라 제한하지 않습니다.
}

// 실제 접속자 IP (Render 등 프록시 뒤). 가장 오른쪽 값이 프록시가 붙인 실제 IP입니다.
function clientIp(req) {
  const xff = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
  return (process.env.TRUST_PROXY !== '0' && xff.length) ? xff[xff.length - 1] : (req.socket.remoteAddress || '?');
}

// ── 요청 횟수 제한 ──────────────────────────────────────────────────
const buckets = new Map();
function limited(key, max, windowMs) {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || now > b.until) { b = { count: 0, until: now + windowMs }; buckets.set(key, b); }
  b.count++;
  return b.count > max;
}
setInterval(() => { const now = Date.now(); for (const [k, b] of buckets) if (now > b.until) buckets.delete(k); }, 60 * 1000).unref();

// ── 로그인 토큰 (암호 자체는 브라우저에 저장하지 않음) ─────────────
// 암호나 키를 바꾸면 기존 토큰은 모두 자동으로 무효가 됩니다.
const tokenKey = () => sha256(`yeollin-token-v2|${CALENDAR_PASSWORD}|${process.env.TOKEN_SECRET || NOTION_API_KEY}`);
const sign = (payload) => crypto.createHmac('sha256', tokenKey()).update(payload).digest('base64url');
function issueToken() {
  const exp = Date.now() + TOKEN_DAYS * 24 * 60 * 60 * 1000;
  return { token: `${exp}.${sign(String(exp))}`, expiresAt: new Date(exp).toISOString() };
}
function verifyToken(req) {
  const m = /^Bearer\s+(\d{10,16})\.([\w-]{20,})$/.exec(String(req.headers.authorization || ''));
  if (!m || Number(m[1]) < Date.now()) return false;
  return safeEqual(m[2], sign(m[1]));
}

// ── 날짜 계산 (한국시간 기준) ───────────────────────────────────────
const ymd = (y, m) => new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10); // m은 0부터, 범위 밖이면 자동으로 넘어감
function kstWindow(now = Date.now()) {
  const k = new Date(now + KST_OFFSET_MS);
  const y = k.getUTCFullYear(), m = k.getUTCMonth();
  return {
    from: ymd(y, m - 1),      // 지난달 1일 (포함)
    until: ymd(y, m + 2),     // 다다음 달 1일 (미포함) → 지난달·이번 달·다음 달
    queryFrom: ymd(y, m - 3), // 지난달 전에 시작해 이어지는 여러 날 일정까지 잡기 위한 여유분
  };
}
// Notion 날짜 → 한국 날짜(YYYY-MM-DD). 시간이 있는 일정은 한국시간으로 바꿔 날짜를 정합니다.
function toKstDate(s) {
  if (!s) return null;
  if (s.length === 10) return s;
  const t = Date.parse(s);
  return Number.isNaN(t) ? s.slice(0, 10) : new Date(t + KST_OFFSET_MS).toISOString().slice(0, 10);
}
function toKstTime(s) {
  if (!s || s.length === 10) return '';
  const t = Date.parse(s);
  return Number.isNaN(t) ? '' : new Date(t + KST_OFFSET_MS).toISOString().slice(11, 16);
}

// ── Notion 요청 ─────────────────────────────────────────────────────
// 월간일정표(원본)는 읽기 전용 키(NOTION_API_KEY)로 "조회"만 합니다.
// 구조물 체크 기록 DB만 별도 키(NOTION_WRITE_KEY)로 쓰기를 합니다. 이 키는 그 DB에만 연결되어 있어 원본에 쓸 수 없습니다.
async function notionRequest(method, apiPath, body, key, attempt = 0) {
  let res;
  try {
    res = await fetch(`${NOTION_API_BASE}${apiPath}`, {
      method,
      headers: {
        Authorization: `Bearer ${key}`,
        'Notion-Version': NOTION_VERSION,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(NOTION_TIMEOUT_MS),
    });
  } catch (e) {
    throw new AppError(e && (e.name === 'TimeoutError' || e.name === 'AbortError') ? 'NOTION_TIMEOUT' : 'NOTION_NETWORK');
  }
  if (res.status === 429 && attempt < 1) {                // 한도 초과 시 1회만, 짧게 기다렸다 재시도
    const wait = Math.min(Number(res.headers.get('retry-after')) || 1, 3);
    await sleep(wait * 1000);
    return notionRequest(method, apiPath, body, key, attempt + 1);
  }
  let data = null;
  try { data = await res.json(); } catch { /* JSON이 아닌 응답 */ }
  if (!res.ok) {
    console.error(`Notion API ${res.status}:`, data && data.message);
    if (res.status === 401) throw new AppError('NOTION_AUTH');
    if (res.status === 403 || res.status === 404) throw new AppError('NOTION_NOT_SHARED');
    if (res.status === 429) throw new AppError('NOTION_RATE_LIMIT');
    if (res.status >= 500) throw new AppError('NOTION_DOWN');
    throw new AppError('NOTION_ERROR');
  }
  if (!data) throw new AppError('NOTION_ERROR');
  return data;
}
async function notionQuery(body) {
  const data = await notionRequest('POST', `/v1/data_sources/${encodeURIComponent(DATA_SOURCE_ID)}/query`, body, NOTION_API_KEY);
  if (!Array.isArray(data.results)) throw new AppError('NOTION_ERROR');
  return data;
}

// ── 구조물 체크 (직원이 직접 체크 → 「🏗️ 구조물 체크 기록」 DB) ─────────
const STRUCT_ENABLED = !!(NOTION_WRITE_KEY && STRUCT_DATA_SOURCE_ID);
async function structQuery(filter) {
  const out = []; let cursor;
  for (let i = 0; i < MAX_PAGES; i++) {
    const body = { page_size: 100, filter }; if (cursor) body.start_cursor = cursor;
    const d = await notionRequest('POST', `/v1/data_sources/${encodeURIComponent(STRUCT_DATA_SOURCE_ID)}/query`, body, NOTION_WRITE_KEY);
    out.push(...(d.results || []));
    if (!d.has_more) break;
    cursor = d.next_cursor;
  }
  return out;
}
const structRow = (p) => ({
  id: p.id,
  name: p.properties?.['직원']?.select?.name || '',
  date: (p.properties?.['날짜']?.date?.start || '').slice(0, 10),
  checked: !!p.properties?.['체크']?.checkbox,
});
// 한 달치 체크: { 이름: [날짜, ...] }
async function loadStructMonth(month) {
  const [y, m] = month.split('-').map(Number);
  const rows = await structQuery({ and: [
    { property: '날짜', date: { on_or_after: ymd(y, m - 1) } },
    { property: '날짜', date: { before: ymd(y, m) } },
    { property: '체크', checkbox: { equals: true } },
  ] });
  const map = {};
  for (const r of rows.map(structRow)) if (r.name && r.date) (map[r.name] ||= new Set()).add(r.date);
  return Object.fromEntries(Object.entries(map).map(([k, v]) => [k, [...v].sort()]));
}
// 같은 직원·날짜는 한 줄만: 있으면 '체크'만 바꾸고, 없으면 새로 만듦
const structLocks = new Map();
async function setStruct(name, date, checked) {
  const key = `${name}|${date}`;
  while (structLocks.has(key)) await structLocks.get(key).catch(() => {});
  const job = (async () => {
    const existing = (await structQuery({ and: [
      { property: '직원', select: { equals: name } },
      { property: '날짜', date: { equals: date } },
    ] })).map(structRow);
    if (existing.length) {
      for (const r of existing) if (r.checked !== checked) {
        await notionRequest('PATCH', `/v1/pages/${r.id}`, { properties: { '체크': { checkbox: checked } } }, NOTION_WRITE_KEY);
      }
    } else if (checked) {
      await notionRequest('POST', '/v1/pages', {
        parent: { type: 'data_source_id', data_source_id: STRUCT_DATA_SOURCE_ID },
        properties: {
          '기록': { title: [{ text: { content: `${name} ${date} 구조물` } }] },
          '직원': { select: { name } },
          '날짜': { date: { start: date } },
          '체크': { checkbox: true },
        },
      }, NOTION_WRITE_KEY);
    }
  })();
  structLocks.set(key, job);
  try { await job; } finally { if (structLocks.get(key) === job) structLocks.delete(key); }
}

// ── 반출장비 (일정별 가져갈 장비) ─────────────────────────────────────
const gear = require('./gear')({ notionRequest, key: NOTION_WRITE_KEY, AppError });

// ── 반출목록 작성 완료 알림: 일정 페이지에 댓글을 달고 직원을 @멘션 → 노션 앱 알림 ──
// 근무 DB에 연결된 읽기 통합(NOTION_API_KEY)이 「댓글 쓰기」 권한으로 댓글만 답니다(페이지 내용은 건드리지 않음).
const NOTIFY_STAFF = [   // 노션 멤버 중 알림 받을 사람 (김광큰·jeongseonghun 제외 — 명기님 요청)
  ['양정모', '407d872b-594c-81bf-a6ac-000296f2dffc'], ['안준용', '409d872b-594c-81c7-8d5e-00020ac6b2b6'],
  ['정명기', '38cd872b-594c-81ef-87c8-000274048c5c'], ['인기 조', 'e3480cd3-1893-43dd-9a4c-d2e479f3ba30'],
  ['정덕수', '405d872b-594c-81b5-9791-000263a9a564'], ['김상연', '408d872b-594c-8173-9b4f-0002a23e9336'],
  ['이영범', '408d872b-594c-81e6-97bc-0002d55a099c'], ['김영인', '31dd872b-594c-8180-b1af-00024405d40d'],
  ['Mook_sound_89', '408d872b-594c-8198-a46f-0002975539ef'], ['이득영', 'ee67a09c-194e-4359-87c0-52824f1f049c'],
  ['열린기획', '406d872b-594c-813d-ac11-0002b2fad244'],
];
const lastNotify = new Map();
async function notifyGear(ev, screen, name, count) {
  const k = `${gear.normId(ev.id)}:${screen}`;
  if (Date.now() - (lastNotify.get(k) || 0) < 60 * 1000) throw new AppError('ALREADY_SENT');
  lastNotify.set(k, Date.now());
  const [y, m, d] = ev.startDate.split('-').map(Number);
  const w = '일월화수목금토'[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  const icon = screen === '영상' ? '🎬' : '📦';
  const head = `${icon} ${m}/${d}(${w}) ${ev.title} — ${screen}장비 반출목록 작성 완료 · 작성자 ${name}${count ? ` · ${count}종` : ''}\n`;
  const rich = [{ type: 'text', text: { content: head } }];
  NOTIFY_STAFF.forEach(([, id], i) => {
    rich.push({ type: 'mention', mention: { type: 'user', user: { id } } });
    if (i < NOTIFY_STAFF.length - 1) rich.push({ type: 'text', text: { content: ' ' } });
  });
  try {
    await notionRequest('POST', '/v1/comments', { parent: { page_id: ev.id }, rich_text: rich }, NOTION_API_KEY);
  } catch (e) {
    lastNotify.delete(k);
    if (e instanceof AppError && e.code === 'NOTION_NOT_SHARED') throw new AppError('COMMENT_DENIED');
    throw e;
  }
}

// 업무속성(선택/상태/다중선택) → { name, color }. 비어 있으면 null
const NOTION_COLORS = new Set(['default', 'gray', 'brown', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink', 'red']);
function readCategory(prop) {
  if (!prop) return null;
  const opt = prop.select || prop.status || (Array.isArray(prop.multi_select) ? prop.multi_select[0] : null);
  if (!opt || !opt.name) return null;
  return { name: String(opt.name).slice(0, 40), color: NOTION_COLORS.has(opt.color) ? opt.color : 'default' };
}

// 근무자(다중선택/선택/글자) → 한 줄 글자. 근무배치표 이름 찾기에 사용
function readText(prop) {
  if (!prop) return '';
  if (Array.isArray(prop.multi_select)) return prop.multi_select.map((o) => o.name).join(' ');
  if (prop.select) return prop.select.name || '';
  if (prop.status) return prop.status.name || '';
  if (Array.isArray(prop.rich_text)) return prop.rich_text.map((x) => x.plain_text).join('');
  if (Array.isArray(prop.title)) return prop.title.map((x) => x.plain_text).join('');
  return '';
}

// w = { from, until(미포함), queryFrom } 범위와 겹치는 일정 (근무자·개인휴무 포함)
async function loadFromNotion(w) {
  const filter = { and: [
    { property: DATE_PROP, date: { on_or_after: w.queryFrom } },
    { property: DATE_PROP, date: { before: w.until } },
  ] };
  const pages = [];
  let cursor;
  for (let i = 0; i < MAX_PAGES; i++) {
    const body = { page_size: 100, filter };
    if (cursor) body.start_cursor = cursor;
    const data = await notionQuery(body);
    pages.push(...data.results);
    if (!data.has_more) { cursor = null; break; }
    cursor = data.next_cursor;
  }
  if (cursor) throw new AppError('TOO_MANY_RESULTS');

  const events = [];
  for (const p of pages) {
    const d = p.properties && p.properties[DATE_PROP] && p.properties[DATE_PROP].date;
    if (!d || !d.start) continue;
    const startDate = toKstDate(d.start);
    const endDate = d.end ? toKstDate(d.end) : startDate;    // Notion의 종료일은 "그날 포함"입니다
    if (startDate >= w.until || endDate < w.from) continue;  // 3개월 범위와 겹치는 일정만
    const title = ((p.properties[TITLE_PROP] && p.properties[TITLE_PROP].title) || [])
      .map((x) => x.plain_text).join('').trim() || '제목 없음';
    events.push({
      id: p.id, title, startDate, endDate: endDate < startDate ? startDate : endDate, time: toKstTime(d.start), url: p.url,
      category: readCategory(p.properties[CATEGORY_PROP]),
      workers: readText(p.properties[WORKERS_PROP]),
      personalOff: readText(p.properties[PERSONAL_OFF_PROP]),
    });
  }
  events.sort((a, b) => (a.startDate.localeCompare(b.startDate)) || (a.time.localeCompare(b.time)) || a.title.localeCompare(b.title, 'ko'));
  return { events, range: { from: w.from, until: w.until }, fetchedAt: new Date().toISOString() };
}

// 서버 캐시 + 동시 요청 묶기: 여러 직원이 동시에 열어도 같은 범위의 Notion 조회는 한 번만 나갑니다.
const cacheStore = new Map();   // key → { data, at }
const inflightStore = new Map(); // key → promise
async function cached(key, loader) {
  const c = cacheStore.get(key);
  if (c && Date.now() - c.at < SERVER_CACHE_MS) return c.data;
  if (inflightStore.has(key)) return inflightStore.get(key);
  const promise = loader()
    .then((data) => { cacheStore.set(key, { data, at: Date.now() }); return data; })
    .finally(() => inflightStore.delete(key));
  inflightStore.set(key, promise);
  return promise;
}
function staleFor(key) {
  const c = cacheStore.get(key);
  return c && Date.now() - c.at < STALE_MAX_MS ? c.data : null;
}
setInterval(() => { const now = Date.now(); for (const [k, c] of cacheStore) if (now - c.at > STALE_MAX_MS) cacheStore.delete(k); }, 60 * 60 * 1000).unref();

// 달력용: 근무자 등 달력에 필요 없는 칸은 빼고 보냄
async function getEvents() {
  const w = kstWindow();
  const key = `cal:${w.from}`;
  return cached(key, async () => {
    const d = await loadFromNotion(w);
    return { ...d, events: d.events.map(({ workers, personalOff, ...e }) => e) };
  });
}

// 근무배치표용: 한 달 (그 달에 걸친 여러 날 일정 포함)
async function getRoster(month) {
  const [y, m] = month.split('-').map(Number);
  const w = { from: ymd(y, m - 1), until: ymd(y, m), queryFrom: ymd(y, m - 3) };
  return cached(`roster:${month}`, async () => {
    const [d, struct] = await Promise.all([
      loadFromNotion(w),
      STRUCT_ENABLED ? loadStructMonth(month).catch((e) => { console.error('구조물 기록 조회 실패:', e.code || e.message); return undefined; }) : null,
    ]);
    return buildRoster(month, d, Date.now(), struct);
  });
}

// ── 요청 처리 ───────────────────────────────────────────────────────
function readJson(req, limit = 8 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new AppError('BAD_REQUEST')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { reject(new AppError('BAD_REQUEST')); } });
    req.on('error', () => reject(new AppError('BAD_REQUEST')));
  });
}

async function handle(req, res) {
  setSecurityHeaders(res);
  const url = new URL(req.url, 'http://x');
  const ip = clientIp(req);

  if (req.method === 'GET' && ['/', '/index.html', '/calendar', '/calendar.html'].includes(url.pathname)) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
    return res.end(INDEX_HTML);
  }
  if (req.method === 'GET' && url.pathname === '/healthz') return sendJson(res, 200, { ok: true });

  if (req.method === 'POST' && url.pathname === '/api/login') {
    if (limited(`login:${ip}`, 10, 60 * 1000) || limited('login:all', 100, 10 * 60 * 1000)) return sendError(res, 'TOO_MANY');
    if (!AUTH_ENABLED) return sendJson(res, 200, { open: true });
    if (!NOTION_API_KEY) return sendError(res, 'NOT_CONFIGURED');
    const body = await readJson(req);
    if (typeof body.password !== 'string' || !safeEqual(body.password, CALENDAR_PASSWORD)) return sendError(res, 'BAD_PASSWORD');
    return sendJson(res, 200, issueToken());
  }

  if (req.method === 'GET' && ['/clock', '/clock.html'].includes(url.pathname)) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=3600' });
    return res.end(CLOCK_HTML);
  }

  if (req.method === 'GET' && ['/roster', '/roster.html'].includes(url.pathname)) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
    return res.end(ROSTER_HTML);
  }

  // ── 반출장비 ──
  if (req.method === 'GET' && ['/gear', '/gear.html', '/vgear'].includes(url.pathname)) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
    return res.end(GEAR_HTML);
  }
  if (url.pathname.startsWith('/api/gear')) {
    if (limited(`gear:${ip}`, 120, 60 * 1000)) return sendError(res, 'TOO_MANY');
    if (!STRUCT_ENABLED || !NOTION_API_KEY) return sendError(res, 'STRUCT_DISABLED');
    if (AUTH_ENABLED && !verifyToken(req)) return sendError(res, 'AUTH_REQUIRED');
    try {
      if (req.method === 'GET' && url.pathname === '/api/gear/init') {
        const [catalog, cal] = await Promise.all([gear.getCatalog(), getEvents()]);
        const from = new Date(Date.now() + KST_OFFSET_MS - 7 * 864e5).toISOString().slice(0, 10);
        const events = cal.events.filter((e) => e.endDate >= from)
          .map((e) => ({ id: gear.normId(e.id), title: e.title, startDate: e.startDate, endDate: e.endDate, category: e.category && e.category.name }));
        return sendJson(res, 200, { catalog, events });
      }
      if (req.method === 'GET' && url.pathname === '/api/gear/staff') {
        return sendJson(res, 200, { names: NOTIFY_STAFF.map(([n]) => n) });
      }
      const eventId = gear.normId(url.searchParams.get('event'));
      if (!gear.isId(eventId)) return sendError(res, 'BAD_REQUEST');
      if (req.method === 'GET' && url.pathname === '/api/gear') {
        return sendJson(res, 200, { rows: await gear.listRows(eventId) });
      }
      if (req.method === 'POST' && url.pathname === '/api/gear/notify') {
        const body = await readJson(req);
        const screen = body && body.screen === '영상' ? '영상' : '음향';
        const name = String((body && body.name) || '').trim().slice(0, 30);
        if (!NOTIFY_STAFF.some(([n]) => n === name)) return sendError(res, 'BAD_REQUEST');
        const cal = await getEvents();
        const ev = cal.events.find((e) => gear.normId(e.id) === eventId);
        if (!ev) return sendError(res, 'BAD_REQUEST');
        await notifyGear(ev, screen, name, Math.max(0, Math.min(999, Number(body.count) || 0)));
        console.log(`반출목록 알림: ${ev.title} (${screen}) by ${name}`);
        return sendJson(res, 200, { ok: true, names: NOTIFY_STAFF.map(([n]) => n) });
      }
      if (req.method === 'POST' && url.pathname === '/api/gear/reset') {
        const body = await readJson(req, 64 * 1024);
        const n = await gear.resetEvent(eventId, Array.isArray(body.pids) ? body.pids.slice(0, 500) : []);
        console.log(`반출장비 초기화: ${eventId} (${n}줄)`);
        return sendJson(res, 200, { ok: true, removed: n });
      }
      if (req.method === 'POST' && url.pathname === '/api/gear') {
        const cal = await getEvents();
        const ev = cal.events.find((e) => gear.normId(e.id) === eventId);
        if (!ev) return sendError(res, 'BAD_REQUEST');
        const body = await readJson(req);
        const row = await gear.saveRow(eventId, body || {}, `${ev.startDate} ${ev.title}`);
        return sendJson(res, 200, { ok: true, row });
      }
      return sendError(res, 'NOT_FOUND');
    } catch (e) {
      const code = e instanceof AppError ? e.code : 'NOTION_ERROR';
      if (!(e instanceof AppError)) console.error('Unexpected:', e);
      return sendError(res, code);
    }
  }

  // 구조물 체크 저장: { name, date: 'YYYY-MM-DD', checked: true|false }
  if (req.method === 'POST' && url.pathname === '/api/structure') {
    if (limited(`struct:${ip}`, 30, 60 * 1000)) return sendError(res, 'TOO_MANY');
    if (!STRUCT_ENABLED) return sendError(res, 'STRUCT_DISABLED');
    if (AUTH_ENABLED && !verifyToken(req)) return sendError(res, 'AUTH_REQUIRED');
    const body = await readJson(req);
    const name = typeof body.name === 'string' ? body.name : '';
    const date = typeof body.date === 'string' ? body.date : '';
    if (typeof body.checked !== 'boolean' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return sendError(res, 'BAD_REQUEST');
    const month = date.slice(0, 7);
    if (!rosterMonthAllowed(month, Date.now())) return sendError(res, 'STRUCT_NOT_ALLOWED');
    try {
      const roster = await getRoster(month);
      if (!structAllowedFor(roster, name, date, Date.now())) return sendError(res, 'STRUCT_NOT_ALLOWED');
      await setStruct(name, date, body.checked);
      cacheStore.delete(`roster:${month}`);   // 다음 조회 때 바로 반영
      console.log(`구조물 ${body.checked ? '체크' : '해제'}: ${name} ${date}`);
      return sendJson(res, 200, { ok: true, name, date, checked: body.checked });
    } catch (e) {
      const code = e instanceof AppError ? e.code : 'NOTION_ERROR';
      if (!(e instanceof AppError)) console.error('Unexpected:', e);
      return sendError(res, code);
    }
  }

  const isEvents = url.pathname === '/api/events', isRoster = url.pathname === '/api/roster';
  if (req.method === 'GET' && (isEvents || isRoster)) {
    if (limited(`events:${ip}`, 60, 60 * 1000)) return sendError(res, 'TOO_MANY');
    if (!NOTION_API_KEY) return sendError(res, 'NOT_CONFIGURED');
    if (AUTH_ENABLED && !verifyToken(req)) return sendError(res, 'AUTH_REQUIRED');
    let key, load;
    if (isEvents) {
      key = `cal:${kstWindow().from}`; load = getEvents;
    } else {
      const month = String(url.searchParams.get('month') || '');
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return sendError(res, 'BAD_REQUEST');
      if (!rosterMonthAllowed(month, Date.now())) return sendJson(res, 400, { error: `근무배치표는 ${ROSTER_START_MONTH}부터 내년 12월까지 볼 수 있습니다.`, code: 'MONTH_OUT_OF_RANGE' });
      key = `roster:${month}`; load = () => getRoster(month);
    }
    try {
      return sendJson(res, 200, await load());
    } catch (e) {
      const code = e instanceof AppError ? e.code : 'NOTION_ERROR';
      if (!(e instanceof AppError)) console.error('Unexpected:', e);
      // Notion 장애 때는 직전 데이터를 "이전 데이터" 표시와 함께 제공 (화면이 비지 않도록)
      const stale = staleFor(key);
      if (stale) return sendJson(res, 200, { ...stale, stale: true, warning: code, warningMessage: (ERRORS[code] || ERRORS.NOTION_ERROR)[1] });
      return sendError(res, code);
    }
  }
  return sendError(res, 'NOT_FOUND');
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => {
    if (!res.headersSent) sendError(res, e instanceof AppError ? e.code : 'NOTION_ERROR');
    else res.end();
  });
});
// ── 서버 깨워 두기 (Render 무료 요금제는 15분 동안 접속이 없으면 잠듦) ─────
// 10분마다 자기 공개 주소(/healthz)를 한 번 불러서 잠들지 않게 합니다. KEEP_AWAKE=0 이면 끔.
const SELF_URL = process.env.RENDER_EXTERNAL_URL || process.env.SELF_URL || '';
if (SELF_URL && process.env.KEEP_AWAKE !== '0') {
  setInterval(() => {
    fetch(`${SELF_URL.replace(/\/$/, '')}/healthz`, { signal: AbortSignal.timeout(20 * 1000) })
      .catch((e) => console.warn('깨우기 실패:', e.message));
  }, 10 * 60 * 1000).unref();
}

server.listen(PORT, () => {
  console.log(`Yeollin calendar v2 running on :${PORT}`);
  if (!NOTION_API_KEY) console.warn('⚠ NOTION_API_KEY 환경변수가 없습니다.');
  console.log(AUTH_ENABLED ? '암호 사용: 켜짐' : '암호 사용: 꺼짐 (누구나 보기 가능)');
});
