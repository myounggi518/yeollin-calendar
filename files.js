'use strict';
/*
 * 행사 자료 모아 보기 — /files?event=<행사 또는 날별 근무 줄 id>
 * - 날별 근무 줄이면 「상위 행사」로 바꿔서 읽습니다 (자료는 행사 한 곳에만 있으므로).
 * - 행사 페이지 본문의 게시물(사진·파일·PDF·영상·음성)과
 *   하위 페이지 「사전미팅…」「행사현장사진…」 안의 파일을 한 화면에 보여 줍니다.
 * 읽기만 합니다. 노션에 쓰지 않습니다.
 */
const FILE_TYPES = new Set(['image', 'file', 'pdf', 'video', 'audio']);
const PARENT = '상위 행사', TITLE = '일정명 / Tasks', DATE = '날짜';
const CACHE_MS = 60 * 1000;

const plain = (arr) => (arr || []).map((x) => x.plain_text).join('').trim();
const norm = (s) => String(s || '').replace(/-/g, '').toLowerCase();

module.exports = function createFiles({ notionRequest, keys }) {
  const cache = new Map();   // 행사 id → { at, data }

  // 읽기 키부터 차례로 시도 (읽기 통합이 하위 페이지에 연결이 안 돼 있을 때 대비)
  async function get(path) {
    let last;
    for (const k of keys.filter(Boolean)) {
      try { return await notionRequest('GET', path, null, k); } catch (e) { last = e; }
    }
    throw last;
  }
  async function children(id) {
    const out = []; let cursor;
    for (let i = 0; i < 10; i++) {
      const d = await get(`/v1/blocks/${id}/children?page_size=100${cursor ? `&start_cursor=${cursor}` : ''}`);
      out.push(...(d.results || []));
      if (!d.has_more) break;
      cursor = d.next_cursor;
    }
    return out;
  }
  function item(b) {
    const o = b[b.type] || {};
    const url = (o.file && o.file.url) || (o.external && o.external.url) || '';
    if (!url) return null;
    let name = o.name || plain(o.caption);
    if (!name) { try { name = decodeURIComponent(new URL(url).pathname.split('/').pop() || ''); } catch { name = ''; } }
    return { type: b.type, url, name: (name || '파일').normalize('NFC'), caption: plain(o.caption) };
  }
  // 블록 목록에서 파일만 (토글 등 안쪽 2단계까지, 하위 페이지는 따로)
  async function filesIn(blocks, depth = 0) {
    const out = [];
    for (const b of blocks) {
      if (FILE_TYPES.has(b.type)) { const it = item(b); if (it) out.push(it); }
      else if (b.has_children && b.type !== 'child_page' && b.type !== 'child_database' && depth < 2) out.push(...await filesIn(await children(b.id), depth + 1));
    }
    return out;
  }

  async function load(eventId) {
    let p = await get(`/v1/pages/${eventId}`);
    const rel = p.properties && p.properties[PARENT] && p.properties[PARENT].relation;
    if (rel && rel[0] && rel[0].id) p = await get(`/v1/pages/${rel[0].id}`);   // 날별 근무 줄 → 상위 행사
    const id = norm(p.id);
    const c = cache.get(id);
    if (c && Date.now() - c.at < CACHE_MS) return c.data;

    const d = p.properties && p.properties[DATE] && p.properties[DATE].date;
    const top = await children(p.id);
    const groups = [];
    const subs = top.filter((b) => b.type === 'child_page');
    const pick = (prefix) => subs.find((b) => ((b.child_page && b.child_page.title) || '').startsWith(prefix));
    for (const [prefix, label] of [['사전미팅', '📋 사전미팅및자료파일'], ['행사현장사진', '📷 행사현장사진']]) {
      const s = pick(prefix);
      if (!s) continue;
      groups.push({ key: prefix, label, url: `https://www.notion.so/${norm(s.id)}`, items: await filesIn(await children(s.id)) });
    }
    // 본문 게시물: 페이지에 바로 올린 파일 (반출목록 토글 안의 화면은 파일이 아니므로 자동으로 빠짐)
    groups.splice(1, 0, { key: 'posts', label: '📎 게시물', url: null, items: await filesIn(top.filter((b) => b.type !== 'child_page')) });

    const data = {
      event: { id, title: plain(p.properties && p.properties[TITLE] && p.properties[TITLE].title) || '제목 없음', url: `https://www.notion.so/${id}`, start: d && d.start, end: d && d.end },
      groups,
    };
    cache.set(id, { at: Date.now(), data });
    if (cache.size > 300) cache.clear();
    return data;
  }
  return { load };
};
