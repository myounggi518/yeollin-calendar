'use strict';
/*
 * 열린기획 월간 일정표 — Notion 읽기 전용 서버 (v2)
 * - 외부 패키지 없이 Node.js 20+ 기본 기능만 사용합니다.
 * - Notion에는 "조회(query)" 요청만 보냅니다. 쓰기/수정/삭제 코드는 없습니다.
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
const NOTION_VERSION = '2025-09-03';
const TITLE_PROP = '일정명 / Tasks';
const DATE_PROP = '날짜';
const CATEGORY_PROP = '업무속성'; // 일정 색 구분 기준 (노션 선택지 색을 그대로 사용)
const WORKERS_PROP = '근무자';
const PERSONAL_OFF_PROP = '개인휴무';
const { buildRoster, rosterMonthAllowed, ROSTER_START_MONTH } = require('./roster');

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
  res.setHeader('Content-Security-Policy',
    "frame-ancestors 'self' https://www.notion.so https://notion.so https://*.notion.site https://*.notion.com https://notion.com");
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

// ── Notion 조회 (읽기 전용) ─────────────────────────────────────────
async function notionQuery(body, attempt = 0) {
  let res;
  try {
    res = await fetch(`${NOTION_API_BASE}/v1/data_sources/${encodeURIComponent(DATA_SOURCE_ID)}/query`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${NOTION_API_KEY}`,
        'Notion-Version': NOTION_VERSION,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(NOTION_TIMEOUT_MS),
    });
  } catch (e) {
    throw new AppError(e && (e.name === 'TimeoutError' || e.name === 'AbortError') ? 'NOTION_TIMEOUT' : 'NOTION_NETWORK');
  }
  if (res.status === 429 && attempt < 1) {                // 한도 초과 시 1회만, 짧게 기다렸다 재시도
    const wait = Math.min(Number(res.headers.get('retry-after')) || 1, 3);
    await sleep(wait * 1000);
    return notionQuery(body, attempt + 1);
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
  if (!data || !Array.isArray(data.results)) throw new AppError('NOTION_ERROR');
  return data;
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
  return cached(`roster:${month}`, async () => buildRoster(month, await loadFromNotion(w)));
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

  if (req.method === 'GET' && ['/roster', '/roster.html'].includes(url.pathname)) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
    return res.end(ROSTER_HTML);
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
server.listen(PORT, () => {
  console.log(`Yeollin calendar v2 running on :${PORT}`);
  if (!NOTION_API_KEY) console.warn('⚠ NOTION_API_KEY 환경변수가 없습니다.');
  console.log(AUTH_ENABLED ? '암호 사용: 켜짐' : '암호 사용: 꺼짐 (누구나 보기 가능)');
});
