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

export function filterRetrievalRowsByQueryDomain(query, rows) {
  const { minQueryOverlap } = getDomainFilterOptions();
  const arr = Array.isArray(rows) ? rows : [];
  if (minQueryOverlap <= 0) return arr;

  const qt = tokenizeQuery(query);
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
