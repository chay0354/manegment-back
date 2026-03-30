/**
 * Domain overlap + readiness before LLM (management RAG). Env aligned with Matriya where possible.
 */

function tokenizeQuery(text) {
  if (!text || typeof text !== 'string') return [];
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length >= 2)
    .slice(0, 80);
}

const SEMANTIC_RULES = [
  {
    re: /(^|[^\p{L}])(דבק|הדבקה|הידבקות)([^\p{L}]|$)|\badhesion\b|\badhesive\b|\bglue\b|\bbond(?:ing)?\b/ui,
    terms: ['דבק', 'הדבקה', 'adhesion', 'adhesive', 'bond']
  },
  {
    re: /(^|[^\p{L}])(צמיגות)([^\p{L}]|$)|\bviscosity\b|\bviscous\b|\bcp\b|\bcps\b/ui,
    terms: ['צמיגות', 'viscosity', 'viscous', 'cps']
  },
  {
    re: /\bviscometer\b|(^|[^\p{L}])(ויסקומטר|צמיגומטר)([^\p{L}]|$)|\brheometer\b|(^|[^\p{L}])(ראומטר)([^\p{L}]|$)/ui,
    terms: ['viscometer', 'rheometer', 'viscosity', 'צמיגות']
  }
];

function semanticTokensFromQuery(query) {
  const q = String(query || '');
  if (!q.trim()) return [];
  const out = new Set();
  for (const rule of SEMANTIC_RULES) {
    if (!rule.re.test(q)) continue;
    for (const t of rule.terms) out.add(String(t).toLowerCase());
  }
  return [...out].slice(0, 24);
}

export function expandQueryWithSemanticTerms(query) {
  const src = String(query || '').trim();
  if (!src) return src;
  const low = src.toLowerCase();
  const extra = semanticTokensFromQuery(src).filter((t) => !low.includes(t));
  if (!extra.length) return src;
  return `${src}\n\n[semantic-hints: ${extra.join(' | ')}]`;
}

export function getDomainFilterOptions() {
  const minOverlap = parseInt(process.env.MATRIYA_DOMAIN_MIN_QUERY_OVERLAP || '2', 10);
  return {
    minQueryOverlap: Number.isFinite(minOverlap) ? Math.max(0, minOverlap) : 2
  };
}

function overlapScore(textLower, queryToks) {
  let s = 0;
  for (const t of queryToks) {
    if (t.length >= 2 && textLower.includes(t)) s += 2;
  }
  return s;
}

const COMPARISON_QUERY_RE =
  /השוואה|לעומת|\sמול\s|A\s+vs\s+B|דלתא|Δ|הפרש\s+בין|שתי\s+גרסאות|שתי\s+פורמולצ|compare|comparison|versus|vs\.?|delta/i;
const METADATA_ONLY_RE =
  /\b(astm|iso|iec|din|standard|standards|method|methods|test\s+method|procedure|procedures|note|notes|remark|remarks|regulation|compliance|norm|norms)\b|תקן|תקנים|שיטה|שיטות|הערה|הערות|נוהל|פרוצדורה/u;
const PCT_OR_FRACTION_RE = /\b\d{1,3}(?:\.\d+)?\s*%|\b0\.\d{2,8}\b/;
const RANGE_PCT_RE = /\b\d{1,3}(?:\.\d+)?\s*[-–]\s*\d{1,3}(?:\.\d+)?\s*%/;
const TABLE_SEPARATOR_RE = /^\|\s*:?-{3,}.*\|$/;

function comparisonSumTolerance() {
  const v = parseFloat(process.env.MATRIYA_COMPARISON_SUM_TOLERANCE || '0.5');
  return Number.isFinite(v) && v > 0 ? v : 0.5;
}

function textHasPctOrCompositionSignals(text) {
  const t = String(text || '');
  return /%|אחוז|percent|weight|ratio|wt\.?\b|w\/w|פורמול|הרכב|יחס|משקל|ingredient|formula|composition/i.test(t) &&
    PCT_OR_FRACTION_RE.test(t);
}

function textLooksMetadataOnly(text) {
  const t = String(text || '');
  if (!t.trim()) return true;
  const hasMetadata = METADATA_ONLY_RE.test(t);
  const hasPct = PCT_OR_FRACTION_RE.test(t) || textHasPctOrCompositionSignals(t);
  return hasMetadata && !hasPct;
}

function chunkLooksLikeFormulation(row) {
  const text = String(row?.document ?? row?.text ?? '');
  if (!textHasPctOrCompositionSignals(text)) return false;
  if (textLooksMetadataOnly(text)) return false;
  return true;
}

function extractPercentValuesFromLine(line) {
  const src = String(line || '');
  if (!src.trim()) return [];
  if (RANGE_PCT_RE.test(src)) return [];
  const vals = [];
  const pctMatches = src.matchAll(/\b(\d{1,3}(?:\.\d+)?)\s*%/g);
  for (const m of pctMatches) {
    const n = parseFloat(String(m?.[1] || ''));
    if (Number.isFinite(n) && n >= 0 && n <= 100) vals.push(n);
  }
  if (vals.length > 0) return vals;
  if (!textHasPctOrCompositionSignals(src)) return [];
  const fracMatches = src.matchAll(/\b0\.(\d{2,8})\b/g);
  for (const m of fracMatches) {
    const f = parseFloat(`0.${String(m?.[1] || '')}`);
    const n = f * 100;
    if (Number.isFinite(n) && n > 0 && n <= 100) vals.push(n);
  }
  return vals;
}

function extractPercentCandidates(text) {
  const t = String(text || '');
  if (!t.trim()) return [];
  const out = [];
  const lines = t.split(/\r?\n/);
  for (const line of lines) {
    if (!line.trim()) continue;
    if (textLooksMetadataOnly(line)) continue;
    const vals = extractPercentValuesFromLine(line);
    if (vals.length) out.push(...vals);
  }
  return out.slice(0, 120);
}

function hasWindowSummingTo100(values, tolerance) {
  const vals = Array.isArray(values) ? values.filter((x) => Number.isFinite(x) && x >= 0 && x <= 100) : [];
  if (vals.length < 2) return false;
  for (let i = 0; i < vals.length; i++) {
    let s = 0;
    for (let j = i; j < vals.length && j < i + 24; j++) {
      s += vals[j];
      const len = j - i + 1;
      if (len >= 2 && Math.abs(100 - s) <= tolerance) return true;
      if (s > 100 + tolerance) break;
    }
  }
  return false;
}

function fileHasNearHundredComposition(rows) {
  const tol = comparisonSumTolerance();
  const vals = [];
  for (const r of rows) {
    vals.push(...extractPercentCandidates(String(r?.document ?? r?.text ?? '')));
  }
  return hasWindowSummingTo100(vals, tol);
}

function isMarkdownTableOnly(answer) {
  const lines = String(answer || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length < 2) return false;
  if (!lines.every((l) => l.startsWith('|') && l.endsWith('|'))) return false;
  if (!lines.some((l) => TABLE_SEPARATOR_RE.test(l))) return false;
  return true;
}

export function evaluateComparisonInputPreconditions(query, chunks) {
  if (!COMPARISON_QUERY_RE.test(String(query || ''))) return { required: false, ok: true };
  const arr = Array.isArray(chunks) ? chunks : [];
  if (!arr.length) return { required: true, ok: false, code: 'INVALID_COMPARISON_INPUT' };
  const formulationRows = arr.filter((r) => chunkLooksLikeFormulation(r));
  const uniqueFiles = new Set(
    formulationRows
      .map((r) => String(r?.metadata?.filename || '').trim().toLowerCase())
      .filter(Boolean)
  );
  if (formulationRows.length < 2 || uniqueFiles.size < 2) {
    return { required: true, ok: false, code: 'INVALID_COMPARISON_INPUT' };
  }
  const validCompositionFiles = new Set();
  for (const f of uniqueFiles) {
    const rowsForFile = formulationRows.filter(
      (r) => String(r?.metadata?.filename || '').trim().toLowerCase() === f
    );
    if (fileHasNearHundredComposition(rowsForFile)) validCompositionFiles.add(f);
  }
  if (validCompositionFiles.size < 2) {
    return { required: true, ok: false, code: 'INVALID_COMPARISON_INPUT' };
  }
  return { required: true, ok: true };
}

export function evaluateComparisonOutputMode(query, answer) {
  if (!COMPARISON_QUERY_RE.test(String(query || ''))) return { required: false, ok: true };
  const out = String(answer || '').trim();
  if (!out) return { required: true, ok: false, code: 'INVALID_COMPARISON_INPUT' };
  if (/^INVALID\b/i.test(out)) return { required: true, ok: false, code: 'INVALID_COMPARISON_INPUT' };
  if (!isMarkdownTableOnly(out)) return { required: true, ok: false, code: 'INVALID_COMPARISON_INPUT' };
  return { required: true, ok: true };
}

export function filterRetrievalRowsByQueryDomain(query, rows) {
  const { minQueryOverlap } = getDomainFilterOptions();
  const arr = Array.isArray(rows) ? rows : [];
  if (minQueryOverlap <= 0) return arr;

  const qt = [...tokenizeQuery(query), ...semanticTokensFromQuery(query)].slice(0, 80);
  if (qt.length === 0) return arr;

  const scored = arr.map((r) => {
    const low = String(r.document ?? r.text ?? '').toLowerCase();
    return { r, overlap: overlapScore(low, qt) };
  });
  const maxO = Math.max(0, ...scored.map((x) => x.overlap));
  if (maxO === 0) return [];

  return scored.filter((x) => x.overlap >= minQueryOverlap).map((x) => x.r);
}

function retrievalSimilarityForRow(hit) {
  if (!hit || typeof hit !== 'object') return 0;
  const doc = String(hit.document ?? hit.text ?? '').trim();
  if (doc.length < 12) return 0;
  const d = hit.distance;
  if (typeof d === 'number' && !Number.isNaN(d) && d >= 0 && d <= 1.0001) {
    return Math.min(1, Math.max(0, d));
  }
  return 0;
}

export function getRetrievalSimilarityThreshold() {
  const t = parseFloat(
    process.env.MANAGEMENT_RETRIEVAL_SIMILARITY_THRESHOLD ||
      process.env.MATRIYA_RETRIEVAL_SIMILARITY_THRESHOLD ||
      '0.7'
  );
  return Number.isFinite(t) ? Math.min(1, Math.max(0, t)) : 0.7;
}

export function getGenerationReadinessOptions() {
  const minChunks = Math.max(1, parseInt(process.env.MATRIYA_GENERATION_MIN_CHUNKS || '1', 10) || 1);
  const minTopKSum = parseFloat(process.env.MATRIYA_GENERATION_MIN_TOPK_SIMILARITY_SUM || '0');
  return {
    minChunks,
    minTopKSimilaritySum: Number.isFinite(minTopKSum) && minTopKSum > 0 ? minTopKSum : 0,
    topKForSum: Math.max(1, Math.min(5, parseInt(process.env.MATRIYA_GENERATION_TOPK_SUM_K || '3', 10) || 3))
  };
}

export function evaluateConclusionBeforeGeneration(query, chunks) {
  const { minChunks, minTopKSimilaritySum, topKForSum } = getGenerationReadinessOptions();
  const arr = Array.isArray(chunks) ? chunks : [];
  if (arr.length < minChunks) {
    return { ok: false, code: 'INSUFFICIENT_EVIDENCE' };
  }

  const cmpGate = evaluateComparisonInputPreconditions(query, arr);
  if (cmpGate.required && !cmpGate.ok) {
    return { ok: false, code: cmpGate.code || 'INVALID_COMPARISON_INPUT' };
  }

  const thr = getRetrievalSimilarityThreshold();
  const sorted = [...arr].sort((a, b) => retrievalSimilarityForRow(b) - retrievalSimilarityForRow(a));
  if (retrievalSimilarityForRow(sorted[0]) < thr) {
    return { ok: false, code: 'INSUFFICIENT_EVIDENCE' };
  }

  if (minTopKSimilaritySum > 0) {
    const k = Math.min(topKForSum, sorted.length);
    const sum = sorted.slice(0, k).reduce((acc, c) => acc + retrievalSimilarityForRow(c), 0);
    if (sum < minTopKSimilaritySum) {
      return { ok: false, code: 'INSUFFICIENT_EVIDENCE' };
    }
  }

  return { ok: true };
}
