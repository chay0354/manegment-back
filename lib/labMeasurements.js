/**
 * Phase B — measurements schema: { type, value, unit?, rpm?, temp? }
 * Normalization: viscosity in cps scaled to reference RPM for cross-run comparison (simplified).
 */

export const MEASUREMENT_REFERENCE_RPM = 6;

const ALLOWED_TYPES = new Set([
  'viscosity',
  'visc',
  'ph',
  'density',
  'cps',
  'torque',
  'generic'
]);

/**
 * @param {unknown} m
 * @returns {{ ok: boolean, error?: string, value?: object }}
 */
export function validateMeasurement(m) {
  if (!m || typeof m !== 'object') return { ok: false, error: 'measurement must be an object' };
  const type = String(m.type || '').trim().toLowerCase();
  if (!type) return { ok: false, error: 'type is required' };
  const v = m.value;
  const num = typeof v === 'number' ? v : parseFloat(v);
  if (!Number.isFinite(num)) return { ok: false, error: 'value must be a number' };
  const unit = m.unit != null ? String(m.unit).trim().toLowerCase() : '';
  const rpm = m.rpm != null && m.rpm !== '' ? parseFloat(m.rpm) : null;
  const temp = m.temp != null && m.temp !== '' ? parseFloat(m.temp) : null;
  if (rpm != null && !Number.isFinite(rpm)) return { ok: false, error: 'rpm invalid' };
  if (temp != null && !Number.isFinite(temp)) return { ok: false, error: 'temp invalid' };
  return {
    ok: true,
    value: {
      type: ALLOWED_TYPES.has(type) ? type : 'generic',
      value: num,
      unit: unit || inferDefaultUnit(type),
      rpm: rpm != null && Number.isFinite(rpm) ? rpm : null,
      temp: temp != null && Number.isFinite(temp) ? temp : null
    }
  };
}

function inferDefaultUnit(type) {
  if (type === 'viscosity' || type === 'visc' || type === 'cps') return 'cps';
  if (type === 'ph') return 'ph';
  return '';
}

/**
 * @param {unknown} arr
 * @returns {{ ok: boolean, measurements?: object[], errors?: string[] }}
 */
export function validateMeasurementsArray(arr) {
  if (!Array.isArray(arr)) return { ok: false, errors: ['measurements must be an array'] };
  const out = [];
  const errors = [];
  for (let i = 0; i < arr.length; i++) {
    const r = validateMeasurement(arr[i]);
    if (!r.ok) errors.push(`[${i}] ${r.error}`);
    else out.push(r.value);
  }
  if (errors.length) return { ok: false, errors };
  return { ok: true, measurements: out };
}

/**
 * Normalized "cps-equivalent" for viscosity-like rows (linear RPM correction vs reference).
 * If rpm missing, returns raw value (assumed comparable at same implicit conditions).
 * @param {object} m validated measurement
 * @returns {number|null}
 */
export function normalizedViscosityCps(m) {
  if (!m || typeof m !== 'object') return null;
  const t = String(m.type || '').toLowerCase();
  const u0 = String(m.unit || '').toLowerCase();
  const viscosityLike = t === 'viscosity' || t === 'visc' || t === 'cps' || u0 === 'cps';
  if (!viscosityLike) return null;
  const val = Number(m.value);
  if (!Number.isFinite(val)) return null;
  const u = u0;
  let cps = val;
  if (u === 'pa.s' || u === 'pas') cps = val * 1000;
  const rpm = m.rpm != null && Number.isFinite(m.rpm) && m.rpm > 0 ? m.rpm : null;
  if (rpm && rpm !== MEASUREMENT_REFERENCE_RPM) {
    cps = cps * (MEASUREMENT_REFERENCE_RPM / rpm);
  }
  return Math.round(cps * 10000) / 10000;
}

/**
 * Compare two experiments' viscosity (highest normalized cps wins).
 * @param {object[]} measurementsA
 * @param {object[]} measurementsB
 * @returns {'A'|'B'|'tie'|'unknown'}
 */
export function compareViscosityExperiments(measurementsA, measurementsB) {
  const a = pickBestViscosityNorm(measurementsA);
  const b = pickBestViscosityNorm(measurementsB);
  if (a == null && b == null) return 'unknown';
  if (a == null) return 'B';
  if (b == null) return 'A';
  if (Math.abs(a - b) < 1e-6) return 'tie';
  return a > b ? 'A' : 'B';
}

function pickBestViscosityNorm(list) {
  if (!Array.isArray(list)) return null;
  let best = null;
  for (const raw of list) {
    const v = validateMeasurement(raw);
    if (!v.ok) continue;
    const n = normalizedViscosityCps(v.value);
    if (n == null) continue;
    if (best == null || n > best) best = n;
  }
  return best;
}

/**
 * @param {string} query
 * @returns {{ wantsMeasurement: boolean, viscosityKeyword: boolean, targetNumber: number|null, rpm: number|null }}
 */
export function parseMeasurementQuestion(query) {
  const q = String(query || '');
  const lower = q.toLowerCase();
  const viscosityKeyword = /viscosity|צמיגות|visc|cps|rpm|צמיגות/i.test(q);
  const phKeyword = /\bph\b|חומציות/i.test(lower);
  const wantsMeasurement = viscosityKeyword || phKeyword || /ניסוי|experiment|מדידה|measurement/i.test(q);
  let targetNumber = null;
  const m = q.match(/\b(\d{3,6})\b/);
  if (m) targetNumber = parseInt(m[1], 10);
  const rpmM = q.match(/(\d+(?:\.\d+)?)\s*rpm/i);
  const rpm = rpmM ? parseFloat(rpmM[1]) : null;
  return { wantsMeasurement, viscosityKeyword, phKeyword, targetNumber, rpm };
}

/**
 * Format experiments with measurements for RAG preface (Hebrew).
 * @param {Array<{ experiment_id: string, measurements?: unknown, results?: string|null }>} rows
 * @param {{ targetNumber?: number|null, rpm?: number|null, viscosityKeyword?: boolean }} ctx
 */
export function selectExperimentsForRagPreface(rows, ctx = {}) {
  const { targetNumber, rpm, viscosityKeyword, phKeyword } = ctx;
  const scored = [];
  for (const row of rows || []) {
    const mets = coerceMeasurements(row);
    if (!mets.length) continue;
    let score = 2;
    for (const m of mets) {
      const v = validateMeasurement(m);
      if (!v.ok) continue;
      const mv = v.value;
      if (viscosityKeyword || targetNumber != null) {
        if (/visc|viscosity|cps/i.test(mv.type) || String(mv.unit).toLowerCase() === 'cps') {
          score += 5;
          if (targetNumber != null && Math.abs(mv.value - targetNumber) < 0.5) score += 20;
          if (targetNumber != null && Math.abs(mv.value - targetNumber) < 50) score += 5;
          if (rpm != null && mv.rpm != null && Math.abs(mv.rpm - rpm) < 1) score += 8;
        }
      }
      if (phKeyword && mv.type === 'ph') score += 4;
    }
    if (score >= 2) scored.push({ row, mets, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, 8);
}

export function coerceMeasurements(row) {
  if (!row || typeof row !== 'object') return [];
  if (Array.isArray(row.measurements)) return row.measurements;
  if (row.results != null && String(row.results).trim().startsWith('[')) {
    try {
      const p = JSON.parse(row.results);
      if (Array.isArray(p)) return p;
    } catch (_) {}
  }
  return [];
}

/**
 * Build measurements[] from Excel row keys (viscosity, ph, rpm, …) or JSON column "measurements".
 * @param {Record<string, unknown>} row
 * @param {(obj: object, ...keys: string[]) => unknown} col
 * @returns {object[]|null}
 */
export function measurementsFromExcelRow(row, col) {
  const rawJson = col(row, 'measurements', 'measurement_json', 'measurements_json');
  if (rawJson != null && String(rawJson).trim()) {
    try {
      const p = typeof rawJson === 'string' ? JSON.parse(rawJson) : rawJson;
      if (Array.isArray(p)) {
        const v = validateMeasurementsArray(p);
        if (v.ok && v.measurements.length) return v.measurements;
      }
    } catch (_) {}
  }
  const arr = [];
  const vis = col(row, 'viscosity', 'visc', 'cps', 'viscosity_cps');
  const ph = col(row, 'ph', 'pH', 'PH');
  const rpm = col(row, 'rpm', 'shear_rpm', 'shear');
  const temp = col(row, 'temp', 'temperature', 't_c', 'T');
  if (vis != null && String(vis).trim() !== '') {
    const v = parseFloat(String(vis).replace(/,/g, ''));
    if (Number.isFinite(v)) {
      const rp = rpm != null && String(rpm).trim() !== '' ? parseFloat(String(rpm).replace(/,/g, '')) : null;
      const tm = temp != null && String(temp).trim() !== '' ? parseFloat(String(temp).replace(/,/g, '')) : null;
      arr.push({
        type: 'viscosity',
        value: v,
        unit: 'cps',
        rpm: rp != null && Number.isFinite(rp) ? rp : null,
        temp: tm != null && Number.isFinite(tm) ? tm : null
      });
    }
  }
  if (ph != null && String(ph).trim() !== '') {
    const v = parseFloat(String(ph).replace(/,/g, ''));
    if (Number.isFinite(v)) arr.push({ type: 'ph', value: v, unit: 'ph', rpm: null, temp: null });
  }
  return arr.length ? arr : null;
}

export function buildExperimentDataPrefaceHebrew(selected) {
  if (!selected.length) return '';
  const lines = [
    '[נתוני ניסויים מובנים — יש להעדיף על פני מסמכים כלליים כשהשאלה נוגעת למדידות אלה]',
    ''
  ];
  for (const { row, mets } of selected) {
    const id = row.experiment_id || row.id || '?';
    lines.push(`ניסוי ${id}:`);
    for (const m of mets) {
      const v = validateMeasurement(m);
      if (!v.ok) continue;
      const x = v.value;
      const norm = normalizedViscosityCps(x);
      const normStr = norm != null ? ` (מנורמל ל-y≈${MEASUREMENT_REFERENCE_RPM} rpm: ~${norm} cps)` : '';
      lines.push(
        `  • סוג: ${x.type}, ערך: ${x.value}${x.unit ? ' ' + x.unit : ''}${x.rpm != null ? `, rpm: ${x.rpm}` : ''}${x.temp != null ? `, temp: ${x.temp}` : ''}${normStr}`
      );
    }
    lines.push('');
  }
  return lines.join('\n').trim();
}
