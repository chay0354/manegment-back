/**
 * Lab experiment file parsing (Excel/CSV/TXT/JSON/PDF) — same behavior as POST /lab/parse-experiment-file.
 * Kept in a standalone module for automated verification without starting the HTTP server.
 */
import axios from 'axios';
import * as XLSX from 'xlsx';

const LAB_EXCEL_MD_MAX_COLS = Math.min(60, Math.max(4, parseInt(process.env.LAB_EXCEL_MD_MAX_COLS || '40', 10) || 40));
const LAB_EXCEL_MD_MAX_ROWS = Math.min(2000, Math.max(20, parseInt(process.env.LAB_EXCEL_MD_MAX_ROWS || '500', 10) || 500));

function escapeMarkdownTableCell(value) {
  let s = String(value ?? '').trim();
  s = s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  s = s.replace(/\n/g, ' ');
  s = s.replace(/\|/g, '\\|');
  return s.length ? s : ' ';
}

/** Trim trailing empty cells per row; drop completely empty rows. */
function normalizeExcelRowsAsArrays(rows) {
  if (!Array.isArray(rows)) return [];
  const out = [];
  for (const r of rows) {
    if (!Array.isArray(r)) continue;
    const cells = r.map((c) => String(c ?? '').trim());
    const trimmed = [...cells];
    while (trimmed.length && !String(trimmed[trimmed.length - 1] ?? '').trim()) trimmed.pop();
    if (trimmed.some((c) => c.length > 0)) out.push(trimmed);
  }
  return out;
}

/**
 * Normalized rectangular matrix for Excel → UI grid and Markdown (same row/col caps).
 * @returns {{ paddedRows: string[][], colCount: number } | null}
 */
export function labExcelPaddedMatrix(sourceRows) {
  const normalized = normalizeExcelRowsAsArrays(sourceRows).slice(0, LAB_EXCEL_MD_MAX_ROWS);
  if (normalized.length === 0) return null;
  let maxCols = 0;
  for (const r of normalized) maxCols = Math.max(maxCols, r.length);
  const colCount = Math.min(maxCols, LAB_EXCEL_MD_MAX_COLS);
  if (colCount === 0) return null;
  const pad = (r) => {
    const a = r.slice(0, colCount).map((c) => String(c ?? ''));
    while (a.length < colCount) a.push('');
    return a;
  };
  return { paddedRows: normalized.map(pad), colCount };
}

/**
 * Build a GitHub-flavored Markdown table from 2D cell arrays (header = first row).
 */
export function excelRowsToMarkdownTable(rows) {
  const m = labExcelPaddedMatrix(rows);
  if (!m) return '';
  const { paddedRows, colCount } = m;
  if (paddedRows.length === 1) {
    const headers = Array.from({ length: colCount }, (_, i) => `עמודה ${i + 1}`);
    const data = paddedRows[0];
    const headerLine = '| ' + headers.map(escapeMarkdownTableCell).join(' | ') + ' |';
    const sepLine = '| ' + headers.map(() => '---').join(' | ') + ' |';
    const dataLine = '| ' + data.map(escapeMarkdownTableCell).join(' | ') + ' |';
    return `${headerLine}\n${sepLine}\n${dataLine}`;
  }
  const headerCells = paddedRows[0];
  const bodyRows = paddedRows.slice(1);
  const headerLine = '| ' + headerCells.map(escapeMarkdownTableCell).join(' | ') + ' |';
  const sepLine = '| ' + headerCells.map(() => '---').join(' | ') + ' |';
  const bodyLines = bodyRows.map((row) => '| ' + row.map(escapeMarkdownTableCell).join(' | ') + ' |');
  return [headerLine, sepLine, ...bodyLines].join('\n');
}

/**
 * @param {Buffer} buffer
 * @param {string} originalName
 * @returns {Promise<{ text: string, excelSheets?: { name: string, rows: string[][] }[] }>}
 */
export async function parseExperimentBufferToText(buffer, originalName) {
  const openaiKey = (process.env.OPENAI_API_KEY || '').trim();
  if (!buffer || !Buffer.isBuffer(buffer)) {
    const e = new Error('No file uploaded. Send multipart form with field "file".');
    e.statusCode = 400;
    throw e;
  }
  const name = (originalName || '').toLowerCase();
  if (name.endsWith('.xlsx') || name.endsWith('.xls')) {
    try {
      const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });
      const intro =
        'הנתונים הופקו מקובץ Excel. כל גיליון מוצג כטבלת Markdown (עמודות בשורת כותרת, שורות נתונים מתחת). ' +
        'יש לנתח לפי מבנה העמודות והשורות.\n\n';
      const parts = [intro];
      /** @type {{ name: string, rows: string[][] }[]} */
      const excelSheets = [];
      for (const sheetName of wb.SheetNames || []) {
        const ws = wb.Sheets[sheetName];
        if (!ws) continue;
        const rows = XLSX.utils.sheet_to_json(ws, { defval: '', raw: false, header: 1 });
        const safeName = String(sheetName || 'Sheet').replace(/#/g, ' ');
        const matrix = labExcelPaddedMatrix(rows);
        if (matrix && matrix.paddedRows.length > 0) {
          excelSheets.push({ name: safeName, rows: matrix.paddedRows });
        }
        const md = excelRowsToMarkdownTable(rows);
        if (md) {
          parts.push(`### גיליון: ${safeName}`);
          parts.push(md);
          parts.push('');
        }
      }
      const text = parts.join('\n').trim() || 'הקובץ ריק או ללא נתונים ניתנים לקריאה.';
      return { text, excelSheets };
    } catch (err) {
      if (err.message && /corrupt|invalid|xlsx|workbook|unsupported zip/i.test(err.message)) {
        const e = new Error('קובץ Excel פגום או בפורמט לא נתמך.');
        e.statusCode = 400;
        throw e;
      }
      throw err;
    }
  }
  if (name.endsWith('.csv') || name.endsWith('.txt') || name.endsWith('.json')) {
    const raw = buffer.toString('utf-8');
    const text = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim() || 'הקובץ ריק.';
    return { text };
  }
  if (name.endsWith('.pdf')) {
    try {
      let fromParse = '';
      try {
        const pdfParse = (await import('pdf-parse')).default;
        const data = await pdfParse(buffer);
        fromParse = String(data?.text || '')
          .replace(/\r\n/g, '\n')
          .trim();
      } catch (_) {}
      const significantChars = fromParse.replace(/\s/g, '').length;
      const PDF_TEXT_ENOUGH = 99;
      if (significantChars >= PDF_TEXT_ENOUGH) {
        return { text: fromParse };
      }

      if (process.env.VERCEL) {
        return {
          text:
            fromParse ||
            'לא נמצא טקסט בשכבת הטקסט של ה־PDF (ייתכן שזה סריקה בתמונה). נסה מקומית או המר ל־PDF עם טקסט.'
        };
      }

      if (!openaiKey) {
        if (significantChars > 0) {
          return { text: fromParse };
        }
        const e = new Error('OPENAI_API_KEY לא מוגדר. הגדר את המפתח ב־.env לחילוץ טקסט מ־PDF באמצעות AI (שימוש בתמונות עמוד).');
        e.statusCode = 503;
        throw e;
      }
      const { pdf } = await import('pdf-to-img');
      const dataUrl = `data:application/pdf;base64,${buffer.toString('base64')}`;
      const document = await pdf(dataUrl, { scale: 2 });
      const parts = [];
      let pageNum = 0;
      const maxPages = 50;
      for await (const image of document) {
        pageNum++;
        if (pageNum > maxPages) break;
        const b64 = image.toString('base64');
        const visionResp = await axios.post(
          'https://api.openai.com/v1/chat/completions',
          {
            model: 'gpt-4o-mini',
            messages: [
              {
                role: 'user',
                content: [
                  {
                    type: 'text',
                    text: 'Extract all text from this document page. Preserve order, structure, and original language (e.g. Hebrew or English). Output only the extracted text, no commentary.'
                  },
                  { type: 'image_url', image_url: { url: `data:image/png;base64,${b64}` } }
                ]
              }
            ],
            max_tokens: 4096,
            temperature: 0
          },
          { headers: { Authorization: `Bearer ${openaiKey}`, 'Content-Type': 'application/json' }, timeout: 60000 }
        );
        const pageText = (visionResp.data?.choices?.[0]?.message?.content || '').trim();
        if (pageText) parts.push(pageText);
      }
      const text = parts.join('\n\n').trim() || 'הקובץ ריק או ללא טקסט.';
      return { text };
    } catch (pdfErr) {
      const msg = pdfErr.response?.data?.error?.message || pdfErr.message || '';
      const e = new Error('לא ניתן לחלץ טקסט מקובץ ה־PDF באמצעות AI. ייתכן שהקובץ פגום או ש־OPENAI_API_KEY חסר/לא תקין. ' + msg);
      e.statusCode = 400;
      throw e;
    }
  }
  const e = new Error('סוג קובץ לא נתמך. השתמש ב־PDF, XLSX, XLS, CSV, TXT או JSON.');
  e.statusCode = 400;
  throw e;
}
