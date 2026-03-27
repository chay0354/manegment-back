/**
 * Lab email attachment: decide if parsed content is complete enough for DB + RAG import.
 * Incomplete → pending + completion email, no file row / no indexing.
 */

/** @param {string} text */
function markdownTableDataRowCount(text) {
  const lines = String(text || '').split('\n');
  let seenSeparator = false;
  let dataRows = 0;
  for (const line of lines) {
    if (!line.includes('|')) continue;
    const trimmed = line.trim();
    if (/^\|?[\s\-:|]+\|?$/.test(trimmed.replace(/\|/g, '')) || /^\|[\s\-:|]+\|/.test(trimmed)) {
      seenSeparator = true;
      continue;
    }
    if (seenSeparator && trimmed.includes('|')) {
      const cells = trimmed.split('|').map((c) => c.trim()).filter(Boolean);
      if (cells.length > 0) dataRows++;
    }
  }
  return dataRows;
}

/**
 * @param {{ text?: string, excelSheets?: { name?: string, rows?: string[][] }[], filename?: string }} parsed
 * @returns {{ ok: true } | { ok: false, status: 'pending', missing: string[] }}
 */
export function assessLabEmailAttachmentImport(parsed) {
  const text = String(parsed?.text || '');
  const sheets = Array.isArray(parsed?.excelSheets) ? parsed.excelSheets : [];
  const filename = String(parsed?.filename || '');

  const missing = [];

  const experimentHint =
    /experiment[\s_]*id|experiment_id|מזהה[\s_]*ניסוי|מזהה\s+ניסוי|EXP[-–]?\w|\bEID\b|#ניסוי/i.test(text) ||
    sheets.some((s) => {
      const r0 = s.rows?.[0] || [];
      return r0.some((cell) => /experiment|ניסוי|^id$/i.test(String(cell)));
    });

  if (!experimentHint) {
    missing.push('חסר מזהה ניסוי (experiment_id / מזהה ניסוי / EXP-...) בטבלה או בטקסט');
  }

  let maxDataRows = 0;
  for (const sh of sheets) {
    const rows = sh.rows || [];
    if (rows.length >= 2) maxDataRows = Math.max(maxDataRows, rows.length - 1);
  }
  const mdRows = markdownTableDataRowCount(text);
  const tableDataRows = Math.max(maxDataRows, mdRows);

  if (tableDataRows < 1) {
    missing.push('חסרה לפחות שורת נתונים אחת בטבלה (מעבר לכותרת)');
  }

  const hasCompositionSignal =
    /%|אחוז|percent|weight|w\/w|material|חומר|פורמול|ingredient/i.test(text) ||
    sheets.some((s) => {
      const r0 = (s.rows?.[0] || []).map((c) => String(c).toLowerCase()).join(' ');
      return /%|percent|material|weight|formula|ingredient|אחוז|חומר/.test(r0);
    });

  if (!hasCompositionSignal) {
    missing.push('חסרה עמודת הרכב / אחוזים / חומרים מזוהה בטבלה');
  }

  if (missing.length === 0) return { ok: true };
  return { ok: false, status: 'pending', missing };
}

/**
 * @returns {boolean}
 */
export function isLabEmailStrictValidationEnabled() {
  const v = String(process.env.LAB_EMAIL_LAB_STRICT_VALIDATION ?? 'true').toLowerCase();
  return v !== 'false' && v !== '0' && v !== 'no';
}
