'use strict';
/*
 * 사전미팅·현장사진 페이지 제목에 파일 개수 표시 (2분마다)
 * - 오늘 이후에 끝나는 일정 페이지에서 제목이 「사전미팅」·「행사현장사진」으로 시작하는 하위 페이지를 찾습니다.
 * - 그 안의 사진·파일·PDF·영상·음성 블록 수를 세어 제목을 바꿉니다.
 *   사전미팅 → "사전미팅및자료파일 첨부 · 3개" (없으면 "사전미팅및자료파일 첨부")
 *   현장사진 → "행사현장사진 · 12장" (없으면 "행사현장사진")
 * - 하위 페이지가 마지막으로 고쳐진 시각이 그대로면 다시 세지 않습니다(요청 수 절약).
 * 쓰기는 이 두 하위 페이지의 제목뿐입니다. 행사(원본 일정)와 페이지 내용은 건드리지 않습니다.
 */
const TITLE = '일정명 / Tasks', DATE = '날짜', KIND = '구분';
const KIND_DAY = '일일근무';
const LOOKBACK_DAYS = 62;
const FILE_TYPES = new Set(['image', 'file', 'pdf', 'video', 'audio']);
const KINDS = [
  { prefix: '사전미팅', base: '사전미팅및자료파일 첨부', unit: '개' },
  { prefix: '행사현장사진', base: '행사현장사진', unit: '장' },
];

const plain = (arr) => (arr || []).map((x) => x.plain_text).join('').trim();
const kstDate = (ms = Date.now()) => new Date(ms + 9 * 3600e3).toISOString().slice(0, 10);
const addDays = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);
const toDate = (s) => (!s ? null : s.length === 10 ? s : kstDate(Date.parse(s)));
const titleFor = (k, n) => (n > 0 ? `${k.base} · ${n}${k.unit}` : k.base);

module.exports = function createFileCount({ notionRequest, key, sources, log = console }) {
  const subsByEvent = new Map();   // 행사 id → { edited, subs: [{ id, kind }] }
  const seen = new Map();          // 하위 페이지 id → 마지막으로 센 때의 last_edited_time
  let running = null;

  async function children(id) {
    const out = []; let cursor;
    for (let i = 0; i < 20; i++) {
      const q = cursor ? `&start_cursor=${cursor}` : '';
      const d = await notionRequest('GET', `/v1/blocks/${id}/children?page_size=100${q}`, null, key);
      out.push(...(d.results || []));
      if (!d.has_more) break;
      cursor = d.next_cursor;
    }
    return out;
  }
  // 하위 페이지 안의 파일 블록 수 (그 안의 또 다른 하위 페이지는 세지 않음, 3단계 깊이까지)
  async function countFiles(id, depth = 0) {
    let n = 0;
    for (const b of await children(id)) {
      if (FILE_TYPES.has(b.type)) n++;
      else if (b.has_children && b.type !== 'child_page' && b.type !== 'child_database' && depth < 2) n += await countFiles(b.id, depth + 1);
    }
    return n;
  }
  async function queryEvents(ds) {
    const out = []; let cursor;
    const filter = { property: DATE, date: { on_or_after: addDays(kstDate(), -LOOKBACK_DAYS) } };
    for (let i = 0; i < 20; i++) {
      const b = { page_size: 100, filter }; if (cursor) b.start_cursor = cursor;
      const d = await notionRequest('POST', `/v1/data_sources/${ds}/query`, b, key);
      out.push(...(d.results || []));
      if (!d.has_more) break;
      cursor = d.next_cursor;
    }
    const today = kstDate();
    return out.filter((p) => {
      const pr = p.properties || {};
      const d = pr[DATE] && pr[DATE].date;
      const end = d && toDate(d.end || d.start);
      const title = plain(pr[TITLE] && pr[TITLE].title);
      const kind = (pr[KIND] && pr[KIND].select && pr[KIND].select.name) || '';
      return end && end >= today && title && kind !== KIND_DAY && !title.includes('휴무') && !title.includes('검사');
    });
  }
  async function subsOf(ev) {
    const c = subsByEvent.get(ev.id);
    if (c && c.edited === ev.last_edited_time) return c.subs;
    const subs = [];
    for (const b of (await children(ev.id)).slice(0, 30)) {
      if (b.type !== 'child_page') continue;
      const t = (b.child_page && b.child_page.title) || '';
      const kind = KINDS.find((k) => t.startsWith(k.prefix));
      if (kind) subs.push({ id: b.id, kind });
    }
    subsByEvent.set(ev.id, { edited: ev.last_edited_time, subs });
    return subs;
  }
  async function syncSub(s) {
    const p = await notionRequest('GET', `/v1/pages/${s.id}`, null, key);
    if (p.in_trash || p.archived) return false;
    if (seen.get(s.id) === p.last_edited_time) return false;
    const now = plain(p.properties && p.properties.title && p.properties.title.title);
    const want = titleFor(s.kind, await countFiles(s.id));
    let changed = false;
    if (now !== want) {
      const r = await notionRequest('PATCH', `/v1/pages/${s.id}`, { properties: { title: { title: [{ type: 'text', text: { content: want } }] } } }, key);
      log.log(`파일 개수 표시: ${now} → ${want}`);
      seen.set(s.id, r.last_edited_time);
      changed = true;
    } else seen.set(s.id, p.last_edited_time);
    return changed;
  }

  async function syncAll() {
    if (running) return running;
    running = (async () => {
      let n = 0;
      const alive = new Set();
      for (const ds of sources) {
        let events;
        try { events = await queryEvents(ds); }
        catch (e) { log.error('파일 개수: 일정 조회 실패:', ds.slice(0, 8), e.code || e.message); continue; }
        for (const ev of events) {
          alive.add(ev.id);
          try { for (const s of await subsOf(ev)) if (await syncSub(s)) n++; }
          catch (e) { log.error('파일 개수 표시 실패:', ev.id, e.code || e.message); }
        }
      }
      for (const id of subsByEvent.keys()) if (!alive.has(id)) subsByEvent.delete(id);
      if (seen.size > 2000) seen.clear();
      return n;
    })().finally(() => { running = null; });
    return running;
  }

  function start(intervalMs = 2 * 60 * 1000) {
    setTimeout(() => syncAll().catch(() => {}), 20 * 1000).unref();
    setInterval(() => syncAll().catch(() => {}), intervalMs).unref();
  }
  return { syncAll, start, titleFor };
};
