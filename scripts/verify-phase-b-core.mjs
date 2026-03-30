/**
 * Phase B core — proves all three deliverables:
 *  (1) Measurements schema + normalization + selection for RAG
 *  (2) GPT RAG query path: DB experiment preface + synthetic snippet + experiment_rag_used
 *  (3) Document classification + viscosity/pH extraction + parse-experiment-file API shape
 *
 * Run from repo: npm run verify:phase-b
 */
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  validateMeasurement,
  normalizedViscosityCps,
  compareViscosityExperiments,
  parseMeasurementQuestion,
  selectExperimentsForRagPreface,
  buildExperimentDataPrefaceHebrew,
  measurementsFromExcelRow,
  MEASUREMENT_REFERENCE_RPM
} from '../lib/labMeasurements.js';
import {
  classifyLabDocument,
  extractExperimentFieldsFromText,
  measurementsFromExtractedFields,
  DOC_CLASSES
} from '../lib/labDocumentClassify.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const serverPath = join(root, 'server.js');
const sqlPath = join(root, 'sql', 'alter_lab_experiments_measurements.sql');

function section(title) {
  console.log(`\n=== ${title} ===`);
}

console.log('Phase B core verification (maneger-back)\n');

// —— (1) Measurements schema ——
section('1) Measurements schema (JSON rows, cps @ ref RPM, comparison, Excel row)');

const vm = validateMeasurement({ type: 'viscosity', value: 100, unit: 'cps', rpm: 12, temp: 25 });
assert.ok(vm.ok, 'validateMeasurement accepts viscosity row');
const normAt12 = normalizedViscosityCps(vm.value);
const expectedNorm = Math.round(100 * (MEASUREMENT_REFERENCE_RPM / 12) * 10000) / 10000;
assert.equal(normAt12, expectedNorm, 'viscosity normalizes linearly vs reference RPM');
console.log(`  normalizedViscosityCps: 100 cps @ 12 rpm → ~${normAt12} cps-equiv @ ${MEASUREMENT_REFERENCE_RPM} rpm (expected ${expectedNorm})`);

const cmp = compareViscosityExperiments(
  [{ type: 'viscosity', value: 2000, unit: 'cps', rpm: 6 }],
  [{ type: 'viscosity', value: 1000, unit: 'cps', rpm: 6 }]
);
assert.equal(cmp, 'A', 'compareViscosityExperiments picks higher normalized viscosity');
console.log('  compareViscosityExperiments: A vs B →', cmp);

const mq = parseMeasurementQuestion('מה הצמיגות של ניסוי 7777?');
assert.equal(mq.wantsMeasurement, true, 'Hebrew viscosity question triggers measurement mode');
assert.equal(mq.targetNumber, 7777, 'target number 7777 extracted');
console.log('  parseMeasurementQuestion:', { wantsMeasurement: mq.wantsMeasurement, targetNumber: mq.targetNumber });

function col(obj, ...keys) {
  for (const k of keys) {
    if (obj[k] != null && String(obj[k]).trim() !== '') return obj[k];
  }
  return undefined;
}
const fromExcel = measurementsFromExcelRow({ viscosity: 7777, rpm: 6, ph: 7.2 }, col);
assert.ok(fromExcel && fromExcel.length >= 2, 'Excel row yields viscosity + ph measurements');
const visRow = fromExcel.find((m) => m.type === 'viscosity');
assert.equal(visRow.value, 7777, 'Excel viscosity column maps to value 7777');
console.log('  measurementsFromExcelRow: viscosity', visRow.value, 'cps, rpm', visRow.rpm);

const mockRows = [
  { experiment_id: 'EXP-LOW', measurements: [{ type: 'viscosity', value: 1000, unit: 'cps', rpm: 6 }] },
  { experiment_id: 'EXP-MATCH', measurements: [{ type: 'viscosity', value: 7777, unit: 'cps', rpm: 6 }] }
];
const selected = selectExperimentsForRagPreface(mockRows, {
  wantsMeasurement: true,
  viscosityKeyword: true,
  targetNumber: 7777,
  rpm: null
});
assert.ok(selected.length >= 1, 'preface selection returns rows');
assert.equal(selected[0].row.experiment_id, 'EXP-MATCH', 'row matching target viscosity ranks first');
const preface = buildExperimentDataPrefaceHebrew(selected);
assert.match(preface, /נתוני ניסויים מובנים/, 'Hebrew preface marker present');
assert.match(preface, /7777/, 'preface includes target measurement');
console.log('  selectExperimentsForRagPreface: top experiment', selected[0].row.experiment_id);
console.log('  buildExperimentDataPrefaceHebrew: length', preface.length, 'chars');

// —— (2) RAG connection in server ——
section('2) RAG: gpt-rag/query uses DB measurements before synthesis');

assert.ok(existsSync(serverPath), 'server.js exists');
const serverSrc = readFileSync(serverPath, 'utf8');
const ragMarkers = [
  "app.post('/api/projects/:projectId/gpt-rag/query'",
  'parseMeasurementQuestion(q)',
  'getLabExperimentsForMeasurementRag(projectId)',
  'selectExperimentsForRagPreface(expRows, mq)',
  'buildExperimentDataPrefaceHebrew(selected)',
  'inputWithExperiments',
  "filename: 'ניסויים (מסד נתונים)'",
  'mergedSnippets',
  'projectGptGroundedSynthesisFromSnippets(q + catalogAppendix, mergedSnippets)',
  'experiment_rag_used:',
  'STRUCTURED EXPERIMENT DATA (Phase B)',
  '[נתוני ניסויים מובנים'
];
for (const m of ragMarkers) {
  assert.ok(serverSrc.includes(m), `server.js must contain: ${m.slice(0, 60)}…`);
  console.log('  found:', m.length > 70 ? m.slice(0, 70) + '…' : m);
}

assert.ok(existsSync(sqlPath), 'alter_lab_experiments_measurements.sql exists');
const sql = readFileSync(sqlPath, 'utf8');
assert.match(sql, /measurements\s+JSONB/i, 'SQL adds measurements JSONB column');
console.log('  migration file:', sqlPath.replace(root + '\\', '').replace(root + '/', ''));

// —— (3) Document classification ——
section('3) Document classification + field extraction + API wiring');

assert.ok(DOC_CLASSES.includes('experiment_result'), 'DOC_CLASSES includes experiment_result');
const docClass = classifyLabDocument('lab_run_12.xlsx', 'Viscosity: 4500 cps at 6 rpm. pH 8.1.');
assert.equal(docClass, 'experiment_result', 'sample text classified as experiment_result');
console.log('  classifyLabDocument →', docClass);

const extracted = extractExperimentFieldsFromText('צמיגות: 7777 cps, 10 rpm');
assert.equal(extracted.viscosity, 7777, 'Hebrew label extracts viscosity 7777');
assert.equal(extracted.rpm, 10, 'rpm extracted');
const sugg = measurementsFromExtractedFields(extracted);
assert.ok(sugg.some((m) => m.type === 'viscosity' && m.value === 7777), 'measurementsFromExtractedFields includes viscosity');
console.log('  extractExperimentFieldsFromText + measurementsFromExtractedFields:', sugg);

const parseMarkers = [
  "app.post('/api/projects/:projectId/lab/parse-experiment-file'",
  'document_classification:',
  'suggested_measurements'
];
for (const m of parseMarkers) {
  assert.ok(serverSrc.includes(m), `parse-experiment-file response must wire ${m}`);
  console.log('  parse-experiment-file:', m);
}

console.log('\n✓ Phase B core: all three areas verified.\n');
