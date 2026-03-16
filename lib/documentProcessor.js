/**
 * Document processing for RAG – extract text from PDF, DOCX, TXT, XLSX.
 */
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import pdfParse from 'pdf-parse';
import mammoth from 'mammoth';

const require = createRequire(import.meta.url);
const XLSX = require('xlsx');

function sanitize(s) {
  if (s == null) return '';
  return String(s).replace(/\0/g, '');
}

export default class DocumentProcessor {
  constructor() {
    this.supportedFormats = {
      '.pdf': this._processPdf.bind(this),
      '.docx': this._processDocx.bind(this),
      '.doc': this._processDocx.bind(this),
      '.txt': this._processTxt.bind(this),
      '.xlsx': this._processExcel.bind(this),
      '.xls': this._processExcel.bind(this),
    };
  }

  async processFile(filePath) {
    const resolved = path.resolve(filePath);
    if (!fs.existsSync(resolved)) {
      return { success: false, error: `File not found: ${filePath}`, text: '', metadata: {} };
    }
    const ext = path.extname(resolved).toLowerCase();
    if (!this.supportedFormats[ext]) {
      return { success: false, error: `Unsupported format: ${ext}`, text: '', metadata: {} };
    }
    try {
      const text = await this.supportedFormats[ext](resolved);
      const stats = fs.statSync(resolved);
      const metadata = {
        filename: sanitize(path.basename(resolved)),
        file_path: resolved,
        file_size: stats.size,
        file_type: ext,
      };
      return { success: true, text, metadata, error: null };
    } catch (e) {
      console.error('[RAG] documentProcessor:', e.message);
      return { success: false, error: e.message, text: '', metadata: {} };
    }
  }

  async _processPdf(filePath) {
    const buf = fs.readFileSync(filePath);
    const data = await pdfParse(buf);
    return sanitize((data.text || '').trim());
  }

  async _processDocx(filePath) {
    const result = await mammoth.extractRawText({ path: filePath });
    return sanitize((result.value || '').trim());
  }

  _processTxt(filePath) {
    try {
      return sanitize(fs.readFileSync(filePath, 'utf-8').trim());
    } catch {
      return sanitize(fs.readFileSync(filePath, 'latin1').trim());
    }
  }

  _processExcel(filePath) {
    const wb = XLSX.readFile(filePath);
    const parts = [];
    for (const name of wb.SheetNames || []) {
      const sheet = wb.Sheets[name];
      parts.push(`Sheet: ${sanitize(name)}\n`);
      const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
      for (const row of rows) {
        const line = row.map(c => sanitize(String(c ?? ''))).join('\t');
        if (line.trim()) parts.push(line);
      }
      parts.push('\n');
    }
    return sanitize(parts.join('\n').trim());
  }
}
