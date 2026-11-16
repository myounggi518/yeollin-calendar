'use strict';
/*
 * 반출목록 재고 제한 — 「열린기획 장비리스트 > 음향장비 재고현황」 페이지의 표를 읽어
 * 반출목록 품목마다 보유 수량을 정하고, 기간이 겹치는 일정에서 이미 적은 수량을 뺀 만큼만 적게 합니다.
 *  - 스피커(메인·모니터): 「스피커」 페이지 표의 가장 최근 연도 수량
 *  - 무선: 「무선 시스템」 페이지 「세트현황」 표 (세트마다 1개)
 *  - 유선마이크: 「유선마이크 · DI」 페이지 표의 가장 최근 연도 수량
 *  - 앰프·DI 등 그 밖의 분류, 재고현황에 없는 품목은 제한 없음
 * 노션 재고현황 페이지는 읽기만 합니다.
 */
const PAGES = {
  spk: process.env.STOCK_SPEAKER_PAGE || '413d2f7f513181e88823ff43b026da51',
  wl: process.env.STOCK_WIRELESS_PAGE || '413d2f7f513181e9b474cf47fb2a1b1b',
  mic: process.env.STOCK_MIC_PAGE || '413d2f7f513181468ec5c067e3fe6907',
};
const CAT_PAGE = { '메인': 'spk', '모니터': 'spk', '무선': 'wl', '마이크': 'mic' };
const SET_ONLY = { wl: true };   // 무선은 「세트현황」 표만 봄 (채널·핸드 수량표는 쓰지 않음)
// 반출목록 이름 → 재고현황 표 이름 (이름이 다른 것만)
const ALIAS = {
  'V25': 'V25-Ⅱ', 'PRX715': '715', 'PRX615': '615', 'PRX612': '612',
  'MKE2(beige)': 'mke2 베이지', 'MKE2(BK)': 'mke2 블랙', 'SM58': 'SM58 (S 포함)',
  'BETA98 H/C(WL)': 'BETA98 H/C (무선용)',
};
const CACHE_MS = 10 * 60 * 1000;
const norm = (s) => String(s || '').toLowerCase().replace(/[\s\-()/·]/g, '');

// 칸 글자 → 수량. 「?」·빈칸 = 모름(null), 「–」 = 0, 「🆕 32」·「1세트」 → 숫자
function cellNum(s) {
  const t = String(s || '').trim();
  if (!t || /^[?？]+$/.test(t)) return null;
  if (/^[–\-—]+$/.test(t)) return 0;
  const m = /(\d+)/.exec(t);
  return m ? Number(m[1]) : null;
}

// 표(행 배열) → { 정규화이름: 수량 }
function parseTable(rows, setOnly) {
  if (rows.length < 2) return {};
  const head = rows[0].map((x) => x.trim());
  const out = {};
  const qIdx = head.indexOf('수량');
  const sIdx = head.indexOf('세트');
  if (setOnly && (qIdx < 0 || sIdx < 0)) return {};
  let nameCol = 0, valCols;
  if (qIdx >= 0) { nameCol = sIdx >= 0 ? sIdx : 0; valCols = [qIdx]; }
  else valCols = head.map((h, i) => (/^\d{4}년$/.test(h) ? i : -1)).filter((i) => i >= 0);
  if (!valCols.length) return {};
  for (const r of rows.slice(1)) {
    const name = norm(r[nameCol]);
    if (!name) continue;
    let v = null;
    for (let i = valCols.length - 1; i >= 0 && v === null; i--) v = cellNum(r[valCols[i]]);   // 최근 연도부터, 「?」면 그 전 해
    if (v !== null && !(name in out)) out[name] = v;
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
  async function readPage(pk, key) {
    const blocks = await children(PAGES[pk], key);
    const map = {};
    for (const b of blocks.filter((x) => x.type === 'table')) {
      const rows = (await children(b.id, key)).filter((x) => x.type === 'table_row').map((x) => x.table_row.cells.map(plain));
      for (const [k, v] of Object.entries(parseTable(rows, SET_ONLY[pk]))) if (!(k in map)) map[k] = v;
    }
    return map;
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

  // 반출목록 품목 → { key, stock } (제한 없는 품목은 빠짐)
  async function limits(catalog) {
    const t = await tables();
    const out = {};
    for (const g of catalog) {
      const pk = CAT_PAGE[g.cat];
      if (!pk || !t[pk]) continue;
      const nm = norm(ALIAS[g.name] || g.name);
      if (nm in t[pk]) out[g.id] = { key: `${pk}:${nm}`, stock: t[pk][nm] };
    }
    return out;
  }

  return { limits, tables, _parseTable: parseTable, _cellNum: cellNum };
};
