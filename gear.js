'use strict';
/*
 * 반출장비 (일정별로 가져갈 장비) — 「📦 일정별 반출장비」 DB에 줄 단위로 저장합니다.
 * 장비 종류는 「🧰 장비 목록」 DB에서 읽습니다. 두 DB 모두 쓰기 키(NOTION_WRITE_KEY) 통합이 연결되어 있어야 합니다.
 * 원본 월간일정표에는 쓰지도, 연결하지도 않습니다. 어떤 일정인지는 「일정ID」(일정 페이지 ID)·「일정명」 글자로 기록합니다.
 */
const GEAR_DS = process.env.GEAR_DATA_SOURCE_ID || '9dcadfff-d941-4595-9ae7-ae1b0ed6acfc';
const CATALOG_DS = process.env.CATALOG_DATA_SOURCE_ID || '6d0dcc9e-4baf-4c1b-93b9-322a11609cf1';
const CATALOG_CACHE_MS = 10 * 60 * 1000;
const ID_RE = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;
const normId = (s) => String(s || '').replace(/-/g, '').toLowerCase();

module.exports = function createGear({ notionRequest, key, AppError }) {
  async function queryAll(ds, body) {
    const out = []; let cursor;
    for (let i = 0; i < 20; i++) {
      const b = { page_size: 100, ...body }; if (cursor) b.start_cursor = cursor;
      const d = await notionRequest('POST', `/v1/data_sources/${ds}/query`, b, key);
      out.push(...(d.results || []));
      if (!d.has_more) break;
      cursor = d.next_cursor;
    }
    return out;
  }
  const plain = (arr) => (arr || []).map((x) => x.plain_text).join('').trim();

  let catalog = null, catalogAt = 0, catalogInflight = null;
  async function getCatalog() {
    if (catalog && Date.now() - catalogAt < CATALOG_CACHE_MS) return catalog;
    if (catalogInflight) return catalogInflight;
    catalogInflight = (async () => {
      const rows = await queryAll(CATALOG_DS, { sorts: [{ timestamp: 'created_time', direction: 'ascending' }] });
      catalog = rows.map((p) => {
        const cat = p.properties?.['분류']?.select?.name || '';
        const full = plain(p.properties?.['장비명']?.title);
        const name = cat && full.startsWith(cat + ' ') ? full.slice(cat.length + 1) : full;
        return { id: normId(p.id), cat, name, full };
      }).filter((g) => g.cat && g.name);
      catalogAt = Date.now();
      return catalog;
    })().finally(() => { catalogInflight = null; });
    return catalogInflight;
  }

  const rowOf = (p) => {
    const pr = p.properties || {};
    const title = plain(pr['직접입력']?.title);
    const gear = normId(pr['장비']?.relation?.[0]?.id);
    let block = '', text = '';
    if (!gear) { const m = /^\[([a-z0-9]+)\]\s*(.*)$/.exec(title); if (m) { block = m[1]; text = m[2]; } else text = title; }
    return {
      pid: normId(p.id), gear: gear || null, block, text,
      qty: typeof pr['수량']?.number === 'number' ? pr['수량'].number : 0,
      box: typeof pr['BOX']?.number === 'number' ? pr['BOX'].number : 0,
      checked: !!pr['챙김']?.checkbox,
      note: plain(pr['note']?.rich_text),
      screen: pr['구분']?.select?.name === '영상' ? '영상' : '음향',   // 비어 있는 예전 줄은 음향
      ev: normId(plain(pr['일정ID']?.rich_text)),
    };
  };

  async function listRows(eventId) {
    const rows = await queryAll(GEAR_DS, { filter: { property: '일정ID', rich_text: { equals: eventId } } });
    return rows.map(rowOf);
  }

  // 여러 일정의 줄을 한 번에 (재고 계산용). 노션 묶음 조건 한도에 맞춰 40개씩
  async function listRowsFor(eventIds) {
    const ids = [...new Set(eventIds.map(normId))].filter((x) => ID_RE.test(x));
    const out = [];
    for (let i = 0; i < ids.length; i += 40) {
      const part = ids.slice(i, i + 40);
      const rows = await queryAll(GEAR_DS, { filter: { or: part.map((id) => ({ property: '일정ID', rich_text: { equals: id } })) } });
      out.push(...rows.map(rowOf));
    }
    return out;
  }

  // 반출목록이 적힌 일정들 (화면별, 1분 캐시)
  let srcCache = null, srcAt = 0;
  async function sourceCounts() {
    if (srcCache && Date.now() - srcAt < 60 * 1000) return srcCache;
    const rows = (await queryAll(GEAR_DS, {})).map(rowOf);
    const out = { '음향': {}, '영상': {} };   // 화면별 { 일정ID: 품목 수 }
    for (const r of rows) {
      if (!r.ev || !(r.qty > 0 || r.box > 0)) continue;
      out[r.screen][r.ev] = (out[r.screen][r.ev] || 0) + 1;
    }
    srcCache = out; srcAt = Date.now();
    return out;
  }

  // 검색형 불러오기: 반출장비 DB의 「일정명」(YYYY-MM-DD 행사명)으로 찾음 → 일정별로 묶어 품목 수 셈
  //  q 없으면 일정명 내림차순(날짜 늦은 순) 최근 limit개, q 있으면 기간 상관없이 행사명에 q가 들어간 일정
  const recentCache = new Map();
  async function searchSources(screen, q, limit) {
    const ck = `${screen}|${q}`;
    const hit = recentCache.get(ck);
    if (hit && Date.now() - hit.at < 30 * 1000) return hit.list;
    const body = { sorts: [{ property: '일정명', direction: 'descending' }] };
    if (q) body.filter = { property: '일정명', rich_text: { contains: q } };
    const byEv = new Map();
    let cursor;
    for (let i = 0; i < 20; i++) {   // 최대 2,000줄
      const b = { page_size: 100, ...body }; if (cursor) b.start_cursor = cursor;
      const d = await notionRequest('POST', `/v1/data_sources/${GEAR_DS}/query`, b, key);
      for (const p of d.results || []) {
        const r = rowOf(p);
        if (r.screen !== screen || !r.ev || !(r.qty > 0 || r.box > 0)) continue;
        let e = byEv.get(r.ev);
        if (!e) {
          if (byEv.size >= limit) continue;
          const name = plain(p.properties?.['일정명']?.rich_text);
          const m = /^(\d{4}-\d{2}-\d{2})\s*(.*)$/.exec(name);
          e = { id: r.ev, date: m ? m[1] : '', title: m ? m[2] : name, count: 0 };
          byEv.set(r.ev, e);
        }
        e.count++;
      }
      // 일정명 순서로 오므로, 목록이 다 찼고 마지막 일정의 줄을 다 센 뒤면 멈춤
      if (!d.has_more) break;
      if (byEv.size >= limit) {
        const last = [...byEv.values()].pop();
        const tail = (d.results || []).slice(-1)[0];
        if (tail && normId(plain(tail.properties?.['일정ID']?.rich_text)) !== last.id) break;
      }
      cursor = d.next_cursor;
    }
    const list = [...byEv.values()];
    recentCache.set(ck, { at: Date.now(), list });
    if (recentCache.size > 200) recentCache.clear();
    return list;
  }

  // 같은 일정에 대한 저장은 한 줄로 세워서 처리(동시에 두 사람이 눌러도 같은 장비가 두 줄 생기지 않게)
  const locks = new Map();
  async function withLock(k, fn) {
    while (locks.has(k)) await locks.get(k).catch(() => {});
    const job = fn(); locks.set(k, job);
    try { return await job; } finally { if (locks.get(k) === job) locks.delete(k); }
  }

  // r = { pid?, gear?, block?, text?, qty, checked, note }  → 저장 후 줄 반환(수량 0이면 삭제 → null)
  async function saveRow(eventId, r, eventTitle) {
    return withLock(eventId, async () => {
      const cat = await getCatalog();
      const g = r.gear ? cat.find((x) => x.id === normId(r.gear)) : null;
      if (r.gear && !g) throw new AppError('BAD_REQUEST');
      const existing = await listRows(eventId);
      let target = r.pid ? existing.find((x) => x.pid === normId(r.pid)) : null;
      if (r.pid && !target) target = null;                       // 이미 지워진 줄이면 새로 만듦
      const screen = r.screen === '영상' ? '영상' : '음향';
      if (target && target.screen !== screen) target = null;      // 다른 화면(음향/영상)의 줄은 건드리지 않음
      if (!target && g) target = existing.find((x) => x.gear === g.id && x.screen === screen) || null; // 같은 화면·같은 장비는 한 줄로
      const qty = Math.max(0, Math.min(9999, Math.round(Number(r.qty) || 0)));
      const note = String(r.note || '').slice(0, 300);
      const box = Math.max(0, Math.min(9999, Math.round(Number(r.box) || 0)));
      const text = String(r.text || '').trim().slice(0, 100);
      const block = /^[a-z0-9]{1,12}$/.test(r.block || '') ? r.block : 'etc';
      if (!g && !text) { if (target) await notionRequest('PATCH', `/v1/pages/${target.pid}`, { in_trash: true }, key); return null; }
      if (qty === 0 && box === 0 && !note && !r.checked) {
        if (target) await notionRequest('PATCH', `/v1/pages/${target.pid}`, { in_trash: true }, key);
        return null;
      }
      const properties = {
        '직접입력': { title: [{ text: { content: g ? g.full : `[${block}] ${text}` } }] },
        '장비': { relation: g ? [{ id: g.id }] : [] },
        '수량': { number: qty },
        'BOX': { number: box },
        '챙김': { checkbox: !!r.checked },
        'note': { rich_text: note ? [{ text: { content: note } }] : [] },
        '구분': { select: { name: screen } },
      };
      let page;
      if (target) page = await notionRequest('PATCH', `/v1/pages/${target.pid}`, { properties }, key);
      else page = await notionRequest('POST', '/v1/pages', {
        parent: { type: 'data_source_id', data_source_id: GEAR_DS },
        properties: { ...properties, '일정ID': { rich_text: [{ text: { content: eventId } }] }, '일정명': { rich_text: [{ text: { content: String(eventTitle || '').slice(0, 200) } }] } },
      }, key);
      return rowOf(page);
    });
  }

  // 이 일정의 줄을 모두 휴지통으로 (초기화)
  // 이 일정의 줄 중 화면이 보낸 것(pids)만 지움 → 음향 초기화가 영상 기록을 지우지 않음
  async function resetEvent(eventId, pids) {
    const want = new Set((pids || []).map(normId));
    return withLock(eventId, async () => {
      const rows = (await listRows(eventId)).filter((r) => want.has(r.pid));
      // 노션 한도(초당 약 3건) 안에서 3줄씩 동시에 지움
      let i = 0;
      const worker = async () => { while (i < rows.length) { const r = rows[i++]; await notionRequest('PATCH', `/v1/pages/${r.pid}`, { in_trash: true }, key); } };
      await Promise.all([worker(), worker(), worker()]);
      return rows.length;
    });
  }

  return { getCatalog, listRows, listRowsFor, sourceCounts, searchSources, saveRow, resetEvent, isId: (s) => ID_RE.test(String(s || '')), normId };
};
