'use strict';
/*
 * 반출목록 재고 제한 — 「열린기획 장비리스트」의 음향·영상장비 재고현황 페이지 표를 읽어
 * 반출목록 품목마다 보유 수량을 정하고, 기간이 겹치는 일정에서 이미 적은 수량을 뺀 만큼만 적게 합니다.
 *  - 음향: 스피커(메인·모니터) · 무선·인이어 「세트현황」 · 유선마이크·DI. 앰프 등은 제한 없음
 *  - 영상: LED(판·박스 따로) · 콘솔 · 프로세서 · OPTI · 케이블·파워팩 · ETC · 노트북 · MONITOR · TV
 *  - 표의 가장 최근 연도 칸 기준(「?」면 그 전 해). 재고현황 표에 없는 품목은 제한 없음
 * 노션 재고현황 페이지는 읽기만 합니다.
 */
const PAGES = {
  spk: '413d2f7f513181e88823ff43b026da51', wl: '413d2f7f513181e9b474cf47fb2a1b1b', mic: '413d2f7f513181468ec5c067e3fe6907',
  vled: '414d2f7f5131816fb522ef768accfa8e', vcon: '414d2f7f513181428a94ebfa4eada6b7', vproc: '414d2f7f513181b98650e3b754a22d38',
  vcab: '414d2f7f513181719823dd43522bc47a', vetc: '414d2f7f51318110953cd857f73b778c',
  cab: '413d2f7f5131819bb505dd3ff7e8032e',
};
// 표가 토글 제목 안에 들어 있는 페이지 (토글 안 표까지 읽음. 토글 안 굵은 소제목이 있으면 그걸 표 제목으로)
const NESTED = new Set(['cab']);
// 반출목록 분류 → { page: 재고현황 페이지, head: 표 바로 위 제목이 이 글자로 시작하는 표만, joinHead: 「제목 + 이름」으로 찾기 }
const CAT = {
  '메인': { page: 'spk' }, '모니터': { page: 'spk' }, '무선': { page: 'wl', setOnly: true }, '인이어': { page: 'wl', setOnly: true }, '마이크': { page: 'mic' }, 'DI': { page: 'mic' },
  'LED': { page: 'vled', joinHead: true },
  '영상콘솔': { page: 'vcon' },
  'PROCESSOR': { page: 'vproc', head: '프로세서' }, 'OPTI': { page: 'vproc', head: 'OPTI' },
  'Gloshine power': { page: 'vcab', head: 'Gloshine power' }, 'Dicolor power': { page: 'vcab', head: 'Dicolor power' },
  'Gloshine VA': { page: 'vcab', head: 'Gloshine VA' }, 'POWER PACK': { page: 'vcab', head: 'POWER PACK' },
  'LAN': { page: 'vcab', head: 'LAN' }, 'OPTI CABLE': { page: 'vcab', head: 'OPTI CABLE' },
  'HDMI': { page: 'vcab', head: 'HDMI' }, 'SDI': { page: 'vcab', head: 'SDI' },
  '영상ETC': { page: 'vetc', head: 'ETC' }, '노트북': { page: 'vetc', head: '노트북' },
  'MONITOR': { page: 'vetc', head: 'MONITOR' }, 'TV': { page: 'vetc', head: 'TV' },
  'XLR': { page: 'cab', sum: true },
};
// 합산형: 반출목록 이름 → [표 제목에 들어간 글자, 표 줄 이름]... 을 모두 더한 값 (하나라도 숫자가 없으면 제한 없음)
// XLR 표: 3m·10m·20m은 Belden만, 5m은 Canare 5m (명기님 요청 2026-11-24)
const SUM = {
  XLR: {
    '3m': [['XLR (Mic Line)', 'Belden 3m']], '5m': [['XLR (Mic Line)', 'Canare 5m']], '10m': [['XLR (Mic Line)', 'Belden 10m']], '20m': [['XLR (Mic Line)', 'Belden 20m']],
    '3.5-XLR': [['XLR (Mic Line)', '3.5 ↔ XLR']],
    // 2ch는 세지 않음 (명기님 요청)
    '4ch': [['라인', '4ch 5m'], ['라인', '4ch 3m']],
    '55(mono)': [['라인', '55 cable']], '55(stereo)': [['라인', '55 cable (ST)']],
    'aes/ebu 3m': [['라인', 'AES/EBU 3m']], 'aes/ebu 10m': [['라인', 'AES/EBU 10m']],
    '16patch': [['멀티 패치', '16patch (5m)']], '20patch': [['멀티 패치', '20patch (8m)']],
    // UTP·8ch·3.5-Ctype는 세지 않음 (명기님 요청)
  },
};
// 반출목록 이름 → 재고현황 표 이름 (이름이 다른 것만)
const ALIAS = {
  'V25': 'V25-Ⅱ', 'PRX715': '715', 'PRX615': '615', 'PRX612': '612',
  'MKE2(beige)': 'mke2 베이지', 'MKE2(BK)': 'mke2 블랙', 'SM58': 'SM58 (S 포함)',
  'BETA98 H/C(WL)': 'BETA98 H/C (무선용)',
};
const CACHE_MS = 10 * 60 * 1000;
const norm = (s) => String(s || '').toLowerCase().replace(/[*×]/g, 'x').replace(/[\s\-()/·"″'”]/g, '');
const normHead = (s) => norm(String(s || '').replace(/\(.*?\)/g, ''));

// 칸 글자 → 수량. 「?」·빈칸 = 모름(null), 「—」·처분·고장·판매 = 0, 「🆕 32」·「1세트」·「2 (비고…)」 → 앞 숫자
function cellNum(s) {
  const t = String(s || '').trim();
  if (!t || /^[?？]+$/.test(t)) return null;
  if (/^[–\-—]+$/.test(t) || /처분|고장|판매/.test(t)) return 0;
  const m = /(\d+)/.exec(t);
  return m ? Number(m[1]) : null;
}

// 표(행 배열) → { 정규화이름: { qty, box? } }
//  - 「세트 / 수량」 표, 「2026년」·「2026년 3월」 연도 칸 표, LED 「2026년 판 / 2026년 박스」 표
function parseTable(rows, setOnly, prefix) {
  if (rows.length < 2) return {};
  const head = rows[0].map((x) => x.trim());
  const out = {};
  const qIdx = head.indexOf('수량');
  const sIdx = head.indexOf('세트');
  if (setOnly && (qIdx < 0 || sIdx < 0)) return {};
  let nameCol = 0, qtyCols = [], boxCols = [];
  if (qIdx >= 0) { nameCol = sIdx >= 0 ? sIdx : 0; qtyCols = [qIdx]; }
  else head.forEach((h, i) => {
    if (!/^\d{4}년/.test(h)) return;
    if (/박스|box/i.test(h)) boxCols.push(i); else qtyCols.push(i);   // 「판」·「EA」·연도만 → 수량
  });
  if (!qtyCols.length) return {};
  // 열 위치와 상관없이 머리글 연도(·월)가 큰 칸부터 → 표를 최신순(왼쪽)·오래된순 어느 쪽으로 놓아도 같음
  const ym = (h) => { const m = /^(\d{4})년(?:\s*(\d{1,2})월)?/.exec(h); return m ? Number(m[1]) * 100 + Number(m[2] || 0) : 0; };
  const byNew = (cols) => cols.slice().sort((a, b) => ym(head[b]) - ym(head[a]) || b - a);
  qtyCols = byNew(qtyCols); boxCols = byNew(boxCols);
  const latest = (r, cols) => { let v = null; for (let i = 0; i < cols.length && v === null; i++) v = cellNum(r[cols[i]]); return v; };
  for (const r of rows.slice(1)) {
    const name = norm((prefix ? prefix + ' ' : '') + String(r[nameCol] || '').replace(/\(비고[^)]*\)/g, ''));
    if (!name || name in out) continue;
    const qty = latest(r, qtyCols);
    if (qty === null) continue;
    const v = { qty };
    if (boxCols.length) { const b = latest(r, boxCols); if (b !== null) v.box = b; }
    out[name] = v;
  }
  return out;
}

module.exports = function createStock({ notionRequest, keys, AppError }) {
  const plain = (arr) => (arr || []).map((x) => x.plain_text).join('');
  async function children(id, key) {
    const out = []; let cursor;
    for (let i = 0; i < 10; i++) {
      const d = await notionRequest('GET', `/v1/blocks/${id}/children?page_size=100${cursor ? '&start_cursor=' + cursor : ''}`, null, key);
      out.push(...(d.results || []));
      if (!d.has_more) break;
      cursor = d.next_cursor;
    }
    return out;
  }
  // 페이지 → [{ head: 표 위 제목, rows: [[칸...]] }]
  async function readPage(pk, key) {
    const blocks = await children(PAGES[pk], key);
    const tables = []; let head = '';
    const tableRows = async (b) => (await children(b.id, key)).filter((x) => x.type === 'table_row').map((x) => x.table_row.cells.map(plain));
    for (const b of blocks) {
      if (/^heading_[123]$/.test(b.type)) {
        head = plain(b[b.type].rich_text);
        if (NESTED.has(pk) && b.has_children) {   // 토글 제목 안의 표
          let sub = head;
          for (const c of await children(b.id, key)) {
            if (c.type === 'paragraph') { const t = plain(c.paragraph.rich_text).trim(); if (t) sub = t; continue; }
            if (c.type === 'table') tables.push({ head: sub, rows: await tableRows(c) });
          }
        }
        continue;
      }
      if (b.type !== 'table') continue;
      tables.push({ head, rows: await tableRows(b) });
    }
    return tables;
  }
  // 읽기 키 → 쓰기 키 순서로 시도 (재고현황 페이지에 연결된 쪽으로)
  async function readAll() {
    let lastErr;
    for (const key of keys.filter(Boolean)) {
      try {
        const res = {};
        for (const pk of Object.keys(PAGES)) res[pk] = await readPage(pk, key);
        return res;
      } catch (e) { lastErr = e; }
    }
    throw lastErr || new AppError('NOTION_ERROR');
  }
  let data = null, at = 0, inflight = null;
  async function tables(fresh) {
    if (!fresh && data && Date.now() - at < CACHE_MS) return data;
    if (inflight) return inflight;
    inflight = readAll().then((d) => { data = d; at = Date.now(); return d; })
      .catch((e) => { if (data) return data; throw e; })   // 노션 오류 땐 직전 값 사용
      .finally(() => { inflight = null; });
    return inflight;
  }

  // 분류별로 쓸 표들을 합친 { 정규화이름: {qty, box?} } (캐시)
  let mapsFor = null, mapsAt = 0;
  function catMap(t, cat) {
    if (mapsAt !== at) { mapsFor = {}; mapsAt = at; }
    if (mapsFor[cat]) return mapsFor[cat];
    const spec = CAT[cat], out = {};
    for (const tb of t[spec.page] || []) {
      if (spec.head && !normHead(tb.head).startsWith(norm(spec.head))) continue;
      const m = parseTable(tb.rows, spec.setOnly, spec.joinHead ? tb.head : '');
      for (const [k, v] of Object.entries(m)) if (!(k in out)) out[k] = v;
    }
    return (mapsFor[cat] = out);
  }

  // 반출목록 품목 → { key, stock, box? } (제한 없는 품목은 빠짐)
  async function limits(catalog) {
    const t = await tables();
    const out = {};
    for (const g of catalog) {
      const spec = CAT[g.cat];
      if (!spec) continue;
      if (spec.sum) {
        const parts = (SUM[g.cat] || {})[g.name];
        if (!parts) continue;
        let total = 0, ok = true;
        for (const [h, row] of parts) {
          let v = null;
          for (const tb of t[spec.page] || []) {
            if (!normHead(tb.head).includes(normHead(h))) continue;
            const m = parseTable(tb.rows, false, '');
            if (norm(row) in m) { v = m[norm(row)].qty; break; }
          }
          if (v === null) { ok = false; break; }
          total += v;
        }
        if (ok) out[g.id] = { key: `${spec.page}:${norm(g.name)}`, stock: total };
        continue;
      }
      const m = catMap(t, g.cat);
      const nm = norm(ALIAS[g.name] || g.name);
      if (!(nm in m)) continue;
      // 같은 페이지라도 표(제목)가 다르면 다른 장비 (예: LAN 10m ≠ HDMI 10m). 스피커는 메인·모니터가 같은 재고를 씀
      const it = { key: `${spec.page}:${spec.head ? norm(spec.head) + ':' : ''}${nm}`, stock: m[nm].qty };
      if (typeof m[nm].box === 'number') it.box = m[nm].box;
      out[g.id] = it;
    }
    return out;
  }

  return { limits, tables, _parseTable: parseTable, _cellNum: cellNum };
};
