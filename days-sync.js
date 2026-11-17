'use strict';
/*
 * 기간 행사 → 날짜별 근무 칸 자동 동기화 (1분마다)
 * - 시작~종료일 일정(구분이 「일일근무」가 아닌 것)이 있으면 날짜마다 「일일근무」 줄을 만들고 행사의 근무자·출근시간·차량을 기본값으로 채웁니다.
 * - 사람이 직접 고친 근무 줄(마지막 수정자가 사람)은 그대로 둡니다. 아무도 손대지 않은 줄은 행사 기본값이 바뀌면 함께 바꿉니다.
 * - 기간이 줄었거나 행사가 하루 일정·휴지통이 되면, 오늘 이후의 남는 근무 줄은 휴지통으로 옮깁니다(복구 가능). 지난 날짜는 건드리지 않습니다.
 * - 처음 근무 줄을 만들 때 행사 페이지 맨 위에 「👷 날짜별 근무」 토글을 붙입니다.
 * 쓰기는 근무 줄 만들기·고치기·휴지통, 행사 페이지 토글 붙이기뿐이며 행사(원본 일정)의 속성은 바꾸지 않습니다.
 */
const TITLE = '일정명 / Tasks', DATE = '날짜', KIND = '구분', PARENT = '상위 행사';
const WORKERS = '근무자', TIME = '출근시간', CARS = '이용 차량', CAT = '업무속성', PLACE = '장소', OFF = '개인휴무';
const KIND_DAY = '일일근무';
const LOOKBACK_DAYS = 62;
const CREATED_MEMO_MS = 10 * 60 * 1000;   // 방금 만든 줄이 조회에 늦게 잡혀도 두 번 만들지 않게

const plain = (arr) => (arr || []).map((x) => x.plain_text).join('').trim();
const kstDate = (ms = Date.now()) => new Date(ms + 9 * 3600e3).toISOString().slice(0, 10);
const addDays = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);
const toDate = (s) => (!s ? null : s.length === 10 ? s : kstDate(Date.parse(s)));
const norm = (s) => String(s || '').replace(/-/g, '').toLowerCase();
const datesBetween = (a, b) => { const out = []; for (let d = a; d <= b && out.length < 62; d = addDays(d, 1)) out.push(d); return out; };

function readPage(p) {
  const pr = p.properties || {};
  const d = pr[DATE] && pr[DATE].date;
  const start = d && toDate(d.start);
  const end = d && (d.end ? toDate(d.end) : start);
  return {
    id: p.id, title: plain(pr[TITLE] && pr[TITLE].title),
    start, end,
    kind: (pr[KIND] && pr[KIND].select && pr[KIND].select.name) || '',
    parent: (pr[PARENT] && pr[PARENT].relation && pr[PARENT].relation[0] && pr[PARENT].relation[0].id) || null,
    workers: ((pr[WORKERS] && pr[WORKERS].multi_select) || []).map((o) => o.name),
    cars: ((pr[CARS] && pr[CARS].multi_select) || []).map((o) => o.name),
    time: plain(pr[TIME] && pr[TIME].rich_text),
    place: plain(pr[PLACE] && pr[PLACE].rich_text),
    cat: (pr[CAT] && pr[CAT].select && pr[CAT].select.name) || '',
    off: (pr[OFF] && pr[OFF].select && pr[OFF].select.name) || '',
    editor: p.last_edited_by && p.last_edited_by.id,
    trashed: !!(p.in_trash || p.archived),
  };
}
const isRangeEvent = (e) => e.kind !== KIND_DAY && e.start && e.end && e.end > e.start && !e.title.includes('휴무') && !e.off;

module.exports = function createDaySync({ notionRequest, writeKey, sources, baseUrl, onChange, log = console }) {
  let botId = null;
  const created = new Map();   // `${parent}:${date}` → 만든 시각
  let running = null;

  async function me() {
    if (!botId) botId = (await notionRequest('GET', '/v1/users/me', null, writeKey)).id;
    return botId;
  }
  async function queryAll(ds, filter) {
    const out = []; let cursor;
    for (let i = 0; i < 20; i++) {
      const b = { page_size: 100, filter }; if (cursor) b.start_cursor = cursor;
      const d = await notionRequest('POST', `/v1/data_sources/${ds}/query`, b, writeKey);
      out.push(...(d.results || []));
      if (!d.has_more) break;
      cursor = d.next_cursor;
    }
    return out;
  }
  const rt = (s) => (s ? [{ type: 'text', text: { content: String(s).slice(0, 1900) } }] : []);
  const defaults = (ev) => ({
    [TITLE]: { title: rt(ev.title || '제목 없음') },
    [WORKERS]: { multi_select: ev.workers.map((name) => ({ name })) },
    [CARS]: { multi_select: ev.cars.map((name) => ({ name })) },
    [TIME]: { rich_text: rt(ev.time) },
    [PLACE]: { rich_text: rt(ev.place) },
    [CAT]: { select: ev.cat ? { name: ev.cat } : null },
  });
  const same = (a, b) => a.title === b.title && a.time === b.time && a.place === b.place && a.cat === b.cat
    && [...a.workers].sort().join('|') === [...b.workers].sort().join('|') && [...a.cars].sort().join('|') === [...b.cars].sort().join('|');

  async function attachToggle(ev) {
    const kids = await notionRequest('GET', `/v1/blocks/${ev.id}/children?page_size=20`, null, writeKey);
    const has = (kids.results || []).some((b) => b.type === 'toggle' && plain(b.toggle && b.toggle.rich_text).includes('날짜별 근무'));
    if (has) return;
    const block = { type: 'toggle', toggle: { rich_text: rt('👷 날짜별 근무'), children: [{ type: 'embed', embed: { url: `${baseUrl}/days?event=${norm(ev.id)}` } }] } };
    try { await notionRequest('PATCH', `/v1/blocks/${ev.id}/children`, { children: [block], position: { type: 'start' } }, writeKey); }
    catch { await notionRequest('PATCH', `/v1/blocks/${ev.id}/children`, { children: [block] }, writeKey); }   // 맨 위 넣기를 못 하면 맨 아래에
  }

  // 행사 하나를 근무 줄과 맞춤. rows = 이 행사에 연결된 근무 줄. 바뀐 게 있으면 true
  async function syncEvent(ds, ev, rows, today) {
    const bot = await me();
    let changed = false;
    const range = isRangeEvent(ev) && !ev.trashed ? datesBetween(ev.start, ev.end) : [];
    const byDate = new Map();
    for (const r of rows) { if (!byDate.has(r.start)) byDate.set(r.start, []); byDate.get(r.start).push(r); }
    // 1) 빠진 날짜 만들기
    let made = 0;
    for (const date of range) {
      if (byDate.has(date)) continue;
      const k = `${norm(ev.id)}:${date}`;
      if (Date.now() - (created.get(k) || 0) < CREATED_MEMO_MS) continue;
      created.set(k, Date.now());
      await notionRequest('POST', '/v1/pages', { parent: { data_source_id: ds }, properties: {
        ...defaults(ev), [DATE]: { date: { start: date } }, [KIND]: { select: { name: KIND_DAY } }, [PARENT]: { relation: [{ id: ev.id }] },
      } }, writeKey);
      made++; changed = true;
    }
    if (made && rows.length === 0) await attachToggle(ev).catch((e) => log.error('토글 붙이기 실패:', ev.title, e.code || e.message));
    // 2) 손대지 않은 줄(마지막 수정자 = 이 연결)은 행사 기본값과 맞춤 — 오늘 이후만
    for (const r of rows) {
      if (!range.includes(r.start) || r.start < today || r.editor !== bot || same(r, ev)) continue;
      await notionRequest('PATCH', `/v1/pages/${r.id}`, { properties: defaults(ev) }, writeKey);
      changed = true;
    }
    // 3) 오늘 이후 날짜만: 기간 밖이 된 줄은 휴지통으로, 같은 날 줄이 여럿이면 하나만 남김(사람이 고친 줄 우선)
    const trash = async (r) => { await notionRequest('PATCH', `/v1/pages/${r.id}`, { in_trash: true }, writeKey); changed = true; };
    for (const [date, rs] of byDate) {
      if (date < today) continue;
      if (!range.includes(date)) { for (const r of rs) await trash(r); continue; }
      if (rs.length > 1) {
        const keep = rs.find((r) => r.editor !== bot) || rs[0];
        for (const r of rs) if (r !== keep && r.editor === bot) await trash(r);
      }
    }
    if (made) log.log(`날짜별 근무 자동 생성: ${ev.title} (${made}일)`);
    return changed;
  }

  async function syncSource(ds) {
    const today = kstDate();
    const from = addDays(today, -LOOKBACK_DAYS);
    const pages = await queryAll(ds, { property: DATE, date: { on_or_after: from } });
    const all = pages.map(readPage);
    const rows = all.filter((p) => p.kind === KIND_DAY && p.parent);
    const rowsByParent = new Map();
    for (const r of rows) { const k = norm(r.parent); if (!rowsByParent.has(k)) rowsByParent.set(k, []); rowsByParent.get(k).push(r); }
    const events = new Map(all.filter((e) => isRangeEvent(e) && e.end >= today).map((e) => [norm(e.id), e]));
    let changed = false;
    for (const [k, ev] of events) changed = (await syncEvent(ds, ev, rowsByParent.get(k) || [], today)) || changed;
    // 근무 줄은 있는데 행사가 목록에 없음(하루 일정으로 바뀜·휴지통·종료) → 오늘 이후 줄만 정리
    for (const [k, rs] of rowsByParent) {
      if (events.has(k) || !rs.some((r) => r.start >= today)) continue;
      let ev;
      try { ev = readPage(await notionRequest('GET', `/v1/pages/${rs[0].parent}`, null, writeKey)); }
      catch { continue; }   // 못 읽으면 건드리지 않음
      if (isRangeEvent(ev) && !ev.trashed && ev.end >= today) continue;
      changed = (await syncEvent(ds, ev, rs, today)) || changed;
    }
    return changed;
  }

  async function syncAll() {
    if (running) return running;
    running = (async () => {
      let changed = false;
      for (const ds of sources) {
        try { changed = (await syncSource(ds)) || changed; }
        catch (e) { log.error('날짜별 근무 동기화 실패:', ds.slice(0, 8), e.code || e.message); }
      }
      if (changed && onChange) onChange();
      for (const [k, t] of created) if (Date.now() - t > CREATED_MEMO_MS) created.delete(k);
      return changed;
    })().finally(() => { running = null; });
    return running;
  }

  function start(intervalMs = 60 * 1000) {
    setTimeout(() => syncAll().catch(() => {}), 5 * 1000).unref();
    setInterval(() => syncAll().catch(() => {}), intervalMs).unref();
  }
  return { syncAll, start, isRangeEvent, readPage };
};
