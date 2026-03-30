/**
 * Phase B — document classification + light field extraction (Excel / text).
 */

export const DOC_CLASSES = ['formulation', 'experiment_result', 'qc_data', 'unknown'];

const FORMULATION_RE = /פורמול|formulation|הרכב|recipe|materials?|percentages?|אחוז|חומרים/i;
const EXPERIMENT_RE = /ניסוי|experiment|viscosity|צמיגות|results?|תוצא|ph\b|cps|rpm|מדידה|measurement/i;
const QC_RE = /\bqc\b|בקרת איכות|quality|spec(ification)?|COA|certificate|תקן/i;

/**
 * @param {string} filename
 * @param {string} textSample first ~8k chars
 * @returns {'formulation'|'experiment_result'|'qc_data'|'unknown'}
 */
export function classifyLabDocument(filename, textSample) {
  const name = String(filename || '').toLowerCase();
  const text = String(textSample || '').slice(0, 12000);
  let score = { formulation: 0, experiment_result: 0, qc_data: 0 };
  if (/formulation|formula|recipe|פורמול/i.test(name)) score.formulation += 3;
  if (/result|experiment|lab|ניסוי|מעבדה/i.test(name)) score.experiment_result += 2;
  if (/qc|coa|spec|certificate/i.test(name)) score.qc_data += 3;
  if (FORMULATION_RE.test(text)) score.formulation += 2;
  if (EXPERIMENT_RE.test(text)) score.experiment_result += 2;
  if (QC_RE.test(text)) score.qc_data += 2;
  const best = Object.entries(score).sort((a, b) => b[1] - a[1])[0];
  if (best[1] < 2) return 'unknown';
  return /** @type {any} */ (best[0]);
}

/**
 * Extract viscosity / pH style fields from free text or markdown tables (best-effort).
 * @param {string} text
 * @returns {{ viscosity: number|null, ph: number|null, rpm: number|null, hints: string[] }}
 */
export function extractExperimentFieldsFromText(text) {
  const t = String(text || '');
  const hints = [];
  let viscosity = null;
  let ph = null;
  let rpm = null;

  let vm = t.match(/(?:viscosity|צמיגות|visc\.?)\s*[:=]?\s*(\d+(?:\.\d+)?)/i);
  if (!vm) vm = t.match(/(\d+(?:\.\d+)?)\s*cps\b/i);
  if (vm) {
    const n = parseFloat(vm[1]);
    if (Number.isFinite(n)) viscosity = n;
  }
  if (viscosity == null) {
    const pipe = t.match(/\|\s*[^|]*visc[^|]*\|\s*(\d+(?:\.\d+)?)\s*\|/i);
    if (pipe) {
      const n = parseFloat(pipe[1]);
      if (Number.isFinite(n)) viscosity = n;
    }
  }

  const phM = t.match(/\bpH\b\s*[:=]?\s*(\d+(?:\.\d+)?)/i) || t.match(/\|\s*ph\s*\|\s*(\d+(?:\.\d+)?)\s*\|/i);
  if (phM) {
    const n = parseFloat(phM[1]);
    if (Number.isFinite(n) && n >= 0 && n <= 14) ph = n;
  }

  const rpmM = t.match(/(\d+(?:\.\d+)?)\s*rpm/i);
  if (rpmM) {
    const n = parseFloat(rpmM[1]);
    if (Number.isFinite(n)) rpm = n;
  }

  if (viscosity != null) hints.push(`viscosity≈${viscosity}`);
  if (ph != null) hints.push(`pH≈${ph}`);
  if (rpm != null) hints.push(`rpm≈${rpm}`);

  return { viscosity, ph, rpm, hints };
}

/**
 * Build measurements array from extracted fields (for merging into lab_experiments).
 */
export function measurementsFromExtractedFields(ex) {
  const arr = [];
  if (ex.viscosity != null) {
    arr.push({
      type: 'viscosity',
      value: ex.viscosity,
      unit: 'cps',
      rpm: ex.rpm,
      temp: null
    });
  }
  if (ex.ph != null) {
    arr.push({ type: 'ph', value: ex.ph, unit: 'ph', rpm: null, temp: null });
  }
  return arr;
}
