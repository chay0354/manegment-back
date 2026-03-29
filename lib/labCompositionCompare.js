/**
 * Deterministic A vs B composition comparison (material → %) with Δ for Lab "השוואה עם אחוזים".
 * Parses a single GitHub-flavored Markdown table or falls back to lines "name<TAB>50%".
 */

const MATERIAL_HEADER_RE = /(material|חומר|רכיב|מרכיב|name|סוג|component|item)/i;
const PERCENT_HEADER_RE = /(%|אחוז|percent|ratio|weight|משקל|wt)/i;

function normalizeMatKey(s) {
  return String(s ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function splitMdRow(line) {
  const t = String(line || '').trim();
  if (!t.includes('|')) return null;
  const inner = t.replace(/^\|/, '').replace(/\|$/g, '');
  return inner.split('|').map((c) => c.replace(/\\\|/g, '|').trim());
}

/** @returns {{ headers: string[], rows: string[][] } | null} */
export function extractFirstMarkdownTable(text) {
  const lines = String(text || '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const headerCells = splitMdRow(lines[i]);
    if (!headerCells || headerCells.length < 2) continue;
    const sepLine = lines[i + 1];
    if (sepLine == null) continue;
    const sepCells = splitMdRow(sepLine);
    if (!sepCells || sepCells.length < 2) continue;
    const isSep = sepCells.every((c) => /^:?-{2,}:?$/.test((c || '').trim()));
    if (!isSep) continue;
    const rows = [];
    for (let j = i + 2; j < lines.length; j++) {
      const cells = splitMdRow(lines[j]);
      if (!cells || cells.length < 2) break;
      if (!lines[j].trim().includes('|')) break;
      rows.push(cells);
    }
    if (rows.length === 0) continue;
    return { headers: headerCells, rows };
  }
  return null;
}

/**
 * Parse a cell as percent: 50, 50%, 0.5 (treated as 50 if <=1 and header hints fraction).
 * @param {string} raw
 * @param {{ treatFraction01?: boolean }} opts
 */
export function parsePercentCell(raw, opts = {}) {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  const pctMatch = s.match(/^(-?\d+(?:\.\d+)?)\s*%$/);
  if (pctMatch) return parseFloat(pctMatch[1]);
  const n = parseFloat(s.replace(/,/g, ''));
  if (Number.isNaN(n)) return null;
  if (opts.treatFraction01 && n > 0 && n <= 1 && !s.includes('%')) return n * 100;
  return n;
}

/**
 * @param {string[][]} headers
 * @param {string[][]} rows
 * @returns {Map<string, { display: string, percent: number }>}
 */
export function tableToCompositionMap(headers, rows) {
  const h = headers.map((x) => String(x || '').trim());
  let matIdx = -1;
  let pctIdx = -1;
  for (let c = 0; c < h.length; c++) {
    const name = h[c] || '';
    if (MATERIAL_HEADER_RE.test(name) && matIdx < 0) matIdx = c;
    if (PERCENT_HEADER_RE.test(name) && pctIdx < 0) pctIdx = c;
  }
  if (matIdx < 0) matIdx = 0;
  if (pctIdx < 0) {
    for (let c = h.length - 1; c >= 0; c--) {
      if (c === matIdx) continue;
      const sample = rows.find((r) => r && r[c] != null && String(r[c]).trim());
      if (sample && parsePercentCell(sample[c], { treatFraction01: true }) != null) {
        pctIdx = c;
        break;
      }
    }
  }
  if (pctIdx < 0) return new Map();

  const map = new Map();
  const fractionHint = /0\s*[-–]?\s*1|שבר|fraction|ratio/i.test(h.join(' '));
  for (const row of rows) {
    if (!row || row.length <= Math.max(matIdx, pctIdx)) continue;
    const display = String(row[matIdx] ?? '').trim();
    if (!display) continue;
    const p = parsePercentCell(row[pctIdx], { treatFraction01: fractionHint });
    if (p == null) continue;
    const key = normalizeMatKey(display);
    if (!key) continue;
    if (!map.has(key)) map.set(key, { display, percent: p });
  }
  return { map };
}

/**
 * Single table with two percent columns (A vs B).
 * @returns {Map<string, { display: string, pctA: number, pctB: number }> | null}
 */
export function parseSingleTableTwoPercentColumns(text) {
  const t = extractFirstMarkdownTable(text);
  if (!t) return null;
  const h = t.headers.map((x) => String(x || '').trim());
  const pctCols = [];
  for (let c = 0; c < h.length; c++) {
    if (PERCENT_HEADER_RE.test(h[c])) pctCols.push(c);
  }
  if (pctCols.length < 2) return null;
  let matIdx = -1;
  for (let c = 0; c < h.length; c++) {
    if (MATERIAL_HEADER_RE.test(h[c])) {
      matIdx = c;
      break;
    }
  }
  if (matIdx < 0) matIdx = 0;
  const cA = pctCols[0];
  const cB = pctCols[1];
  const fractionHint = /0\s*[-–]?\s*1|שבר|fraction|ratio/i.test(h.join(' '));
  const out = new Map();
  for (const row of t.rows) {
    const display = String(row[matIdx] ?? '').trim();
    if (!display) continue;
    const pa = parsePercentCell(row[cA], { treatFraction01: fractionHint });
    const pb = parsePercentCell(row[cB], { treatFraction01: fractionHint });
    if (pa == null && pb == null) continue;
    const key = normalizeMatKey(display);
    if (!key) continue;
    out.set(key, {
      display,
      pctA: pa != null ? pa : 0,
      pctB: pb != null ? pb : 0
    });
  }
  return out.size ? out : null;
}

/**
 * @param {string} text
 * @returns {Map<string, { display: string, percent: number }>}
 */
export function parseCompositionFromText(text) {
  const raw = String(text || '').trim();
  if (!raw) return new Map();
  const tab = extractFirstMarkdownTable(raw);
  if (tab) {
    const { map } = tableToCompositionMap(tab.headers, tab.rows);
    if (map && map.size > 0) return map;
  }
  const lines = raw.split(/\r?\n/);
  const map = new Map();
  for (const line of lines) {
    const parts = line.split(/\t/).map((x) => x.trim());
    if (parts.length >= 2) {
      const display = parts[0];
      const p = parsePercentCell(parts[1], { treatFraction01: true });
      if (display && p != null) {
        const key = normalizeMatKey(display);
        if (key && !map.has(key)) map.set(key, { display, percent: p });
      }
    }
  }
  return map;
}

function round4(n) {
  return Math.round(n * 10000) / 10000;
}

/**
 * @param {Map<string, { display: string, percent: number }>} mapA
 * @param {Map<string, { display: string, percent: number }>} mapB
 * @param {string} labelA
 * @param {string} labelB
 */
export function compareCompositionMaps(mapA, mapB, labelA, labelB) {
  const keys = new Set([...mapA.keys(), ...mapB.keys()]);
  const rows = [];
  for (const k of keys) {
    const a = mapA.get(k);
    const b = mapB.get(k);
    const display = (a && a.display) || (b && b.display) || k;
    const pctA = a ? a.percent : null;
    const pctB = b ? b.percent : null;
    const delta = pctA != null && pctB != null ? round4(pctB - pctA) : null;
    rows.push({
      material: display,
      pctA,
      pctB,
      delta,
      key: k
    });
  }
  rows.sort((x, y) => x.material.localeCompare(y.material, 'he', { sensitivity: 'base' }));
  const sumA = round4([...mapA.values()].reduce((s, v) => s + v.percent, 0));
  const sumB = round4([...mapB.values()].reduce((s, v) => s + v.percent, 0));
  const warnings = [];
  if (mapA.size && Math.abs(sumA - 100) > 0.15) {
    warnings.push(`סכום אחוזים ב־${labelA} ≈ ${sumA}% (צפוי ~100%).`);
  }
  if (mapB.size && Math.abs(sumB - 100) > 0.15) {
    warnings.push(`סכום אחוזים ב־${labelB} ≈ ${sumB}% (צפוי ~100%).`);
  }
  if (mapA.size === 0) warnings.push(`לא זוהו רכיבים ב־${labelA} — הדביקו טבלת Markdown עם עמודת חומר ועמודת %.`);
  if (mapB.size === 0) warnings.push(`לא זוהו רכיבים ב־${labelB} — הדביקו טבלת Markdown עם עמודת חומר ועמודת %.`);

  const esc = (c) => String(c ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
  const h1 = esc(labelA);
  const h2 = esc(labelB);
  const header = `| רכיב | % (${h1}) | % (${h2}) | Δ (${h2}−${h1}) |`;
  const sep = '| --- | ---: | ---: | ---: |';
  const body = rows.map((r) => {
    const a = r.pctA != null ? `${round4(r.pctA)}` : '—';
    const b = r.pctB != null ? `${round4(r.pctB)}` : '—';
    const d = r.delta != null ? `${r.delta > 0 ? '+' : ''}${r.delta}` : '—';
    return `| ${esc(r.material)} | ${a} | ${b} | ${d} |`;
  });
  const markdownTable = [header, sep, ...body].join('\n');
  return { rows, sumA, sumB, warnings, markdownTable };
}

/**
 * One pasted block: table with two % columns → direct comparison.
 */
export function compareFromSingleTwoColumnTable(text, labelA, labelB) {
  const dual = parseSingleTableTwoPercentColumns(text);
  if (!dual) return null;
  const rows = [];
  for (const [, v] of dual) {
    rows.push({
      material: v.display,
      pctA: v.pctA,
      pctB: v.pctB,
      delta: round4(v.pctB - v.pctA),
      key: normalizeMatKey(v.display)
    });
  }
  rows.sort((x, y) => x.material.localeCompare(y.material, 'he', { sensitivity: 'base' }));
  const sumA = round4(rows.reduce((s, r) => s + r.pctA, 0));
  const sumB = round4(rows.reduce((s, r) => s + r.pctB, 0));
  const warnings = [];
  if (Math.abs(sumA - 100) > 0.15) warnings.push(`סכום עמודת ${labelA} ≈ ${sumA}%.`);
  if (Math.abs(sumB - 100) > 0.15) warnings.push(`סכום עמודת ${labelB} ≈ ${sumB}%.`);
  const esc = (c) => String(c ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
  const h1 = esc(labelA);
  const h2 = esc(labelB);
  const markdownTable = [
    `| רכיב | % (${h1}) | % (${h2}) | Δ (${h2}−${h1}) |`,
    '| --- | ---: | ---: | ---: |',
    ...rows.map((r) => {
      const d = r.delta != null ? `${r.delta > 0 ? '+' : ''}${r.delta}` : '—';
      return `| ${esc(r.material)} | ${round4(r.pctA)} | ${round4(r.pctB)} | ${d} |`;
    })
  ].join('\n');
  return { rows, sumA, sumB, warnings, markdownTable };
}

export function percentagesObjectToMap(percentages) {
  const map = new Map();
  if (!percentages || typeof percentages !== 'object') return map;
  for (const [k, v] of Object.entries(percentages)) {
    const display = String(k).trim();
    const key = normalizeMatKey(display);
    if (!key) continue;
    const num = parseFloat(v);
    if (Number.isNaN(num)) continue;
    map.set(key, { display, percent: num });
  }
  return map;
}
