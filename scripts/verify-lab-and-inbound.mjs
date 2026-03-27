/**
 * Offline proof for inbound email routing + Lab file parsing (email attachment path uses the same parser).
 * Does not require Supabase, HTTP, or OPENAI_API_KEY (PDF vision branch not exercised here).
 */
import assert from 'node:assert/strict';
import * as XLSX from 'xlsx';
import {
  extractProjectIdFromInboundPayload,
  parseEmailOnly
} from '../lib/inboundProjectRouting.js';
import {
  parseExperimentBufferToText,
  excelRowsToMarkdownTable
} from '../lib/labExperimentParse.js';
import { assessLabEmailAttachmentImport } from '../lib/labEmailImportValidation.js';

const SAMPLE_UUID = 'a1b2c3d4-e5f6-4178-a9b0-123456789abc';

function assert400HebrewOrReThrown(e, hint) {
  if (e && e.statusCode === 400 && /פגום|לא נתמך|No file/.test(String(e.message))) return;
  throw new Error(`${hint}: unexpected error: ${e?.message || e}`);
}

parseEmailOnly('Team <x@y.com>');
assert.equal(parseEmailOnly('Team <x@y.com>'), 'x@y.com');

assert.equal(
  extractProjectIdFromInboundPayload({ to: [`${SAMPLE_UUID}@inbound.example.com`] }, {}),
  SAMPLE_UUID
);
assert.equal(
  extractProjectIdFromInboundPayload({ subject: `ref ${SAMPLE_UUID} done` }, {}),
  SAMPLE_UUID
);
assert.equal(extractProjectIdFromInboundPayload({}, { project_id: SAMPLE_UUID }), SAMPLE_UUID);
assert.equal(
  extractProjectIdFromInboundPayload(
    { headers: { 'X-Thread': `t-${SAMPLE_UUID}` } },
    {}
  ),
  SAMPLE_UUID
);

const wb = XLSX.utils.book_new();
const ws = XLSX.utils.aoa_to_sheet([
  ['experiment_id', 'materials'],
  ['EXP-001', 'A, B']
]);
XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
const xlsxBuf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

const parsed = await parseExperimentBufferToText(xlsxBuf, 'test.xlsx');
assert.match(parsed.text, /EXP-001/);
assert.match(parsed.text, /### גיליון:/);
assert.ok(Array.isArray(parsed.excelSheets) && parsed.excelSheets.length >= 1);
assert.ok(parsed.excelSheets.some((s) => s.rows?.some((r) => r.includes('EXP-001'))));

const csv = await parseExperimentBufferToText(Buffer.from('a,b\n1,2', 'utf8'), 'f.csv');
assert.match(csv.text, /1/);

try {
  // ZIP signature too short — SheetJS throws "Unsupported ZIP file" (not UTF-8 mistaken for a sheet).
  await parseExperimentBufferToText(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00]), 'bad.xlsx');
  assert.fail('expected invalid xlsx to throw');
} catch (e) {
  assert400HebrewOrReThrown(e, 'invalid xlsx');
}

try {
  await parseExperimentBufferToText(Buffer.alloc(0), 'x.doc');
  assert.fail('expected unsupported extension');
} catch (e) {
  assert.equal(e.statusCode, 400);
  assert.match(String(e.message), /לא נתמך/);
}

try {
  await parseExperimentBufferToText(null, 'x.xlsx');
  assert.fail('expected null buffer');
} catch (e) {
  assert.equal(e.statusCode, 400);
}

const md = excelRowsToMarkdownTable([['only_cell']]);
assert.match(md, /עמודה 1/);

const fullAss = assessLabEmailAttachmentImport({
  text: parsed.text,
  excelSheets: parsed.excelSheets,
  filename: 'test.xlsx'
});
assert.equal(fullAss.ok, true, 'full xlsx should pass lab email completeness gate');

const partialAss = assessLabEmailAttachmentImport({
  text: 'שלום זה מייל בלי טבלה',
  excelSheets: [],
  filename: 'note.txt'
});
assert.equal(partialAss.ok, false);
assert.equal(partialAss.status, 'pending');

const mdTable = `### גיליון\n| experiment_id | חומר | % |\n| --- | --- | --- |\n| EXP-9 | water | 50 |\n`;
const mdAss = assessLabEmailAttachmentImport({ text: mdTable, excelSheets: null, filename: 't.md' });
assert.equal(mdAss.ok, true, 'markdown table with experiment + % should pass');

console.log('verify-lab-and-inbound: OK');
