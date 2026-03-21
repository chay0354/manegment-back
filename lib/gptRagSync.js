/**
 * Sync one project's project_files (Supabase storage) into a dedicated OpenAI vector store.
 * Used by POST /api/projects/:id/gpt-rag/sync and scripts/sync-all-gpt-rag.js.
 */
import axios from 'axios';
import FormData from 'form-data';
import path from 'path';

const SHAREPOINT_BUCKET = 'sharepoint-files';
const MANUAL_BUCKET = 'manually-uploaded-sharepoint-files';
const MANUAL_PREFIX = 'manual';
const MANUAL_TYPO_BUCKET = 'manualy-uploded-sharepoint-files';

export const GPT_RAG_FILE_RE = /\.(pdf|docx|doc|txt|xlsx|xls|pptx|csv|json|md|html|htm)$/i;
export const GPT_RAG_MAX_FILE_BYTES = 32 * 1024 * 1024;
export const GPT_RAG_MAX_FILES = 50;

/** Row has storage + extension match on original_name or on the storage path basename (ASCII bucket paths). */
export function isProjectFileGptRagEligible(f) {
  if (!f?.storage_path || !String(f.storage_path).trim()) return false;
  const orig = String(f.original_name || '').trim();
  const fromPath = path.basename(String(f.storage_path).replace(/\\/g, '/')) || '';
  const base = orig || fromPath;
  return Boolean(base) && GPT_RAG_FILE_RE.test(base);
}

export function gptRagDisplayFilename(row) {
  const o = String(row?.original_name || '').trim();
  if (o) return o;
  return path.basename(String(row?.storage_path || '').replace(/\\/g, '/')) || 'file';
}

function resolveBucketAndPath(storagePath) {
  const p = String(storagePath || '');
  if (p.startsWith(MANUAL_PREFIX + '/')) {
    return { bucket: MANUAL_BUCKET, storagePath: p.slice(MANUAL_PREFIX.length + 1) };
  }
  if (p.startsWith('manual2/')) {
    return { bucket: MANUAL_TYPO_BUCKET, storagePath: p.slice(8) };
  }
  return { bucket: SHAREPOINT_BUCKET, storagePath: p };
}

function bufferLooksLikeUtf8Text(buf) {
  if (!buf || !Buffer.isBuffer(buf) || buf.length < 8) return false;
  if (buf.subarray(0, 4).toString('ascii') === '%PDF') return false;
  if (buf[0] === 0x50 && buf[1] === 0x4b) return false; // ZIP / Office
  const sample = buf.subarray(0, Math.min(4096, buf.length));
  let printable = 0;
  for (let i = 0; i < sample.length; i++) {
    const b = sample[i];
    if (b === 9 || b === 10 || b === 13 || (b >= 32 && b <= 126) || b >= 0x7f) printable++;
  }
  return printable / sample.length > 0.9;
}

/**
 * OpenAI upload: if DB says .pdf but bytes are plain text (e.g. repaired from RAG), use .txt + text/plain.
 */
export function openAiUploadFilenameAndMime(row, buffer) {
  const display = gptRagDisplayFilename(row);
  const baseForOpenAI = path.basename(String(display).replace(/[/\\]/g, '_')) || 'file';
  const ext = path.extname(baseForOpenAI).toLowerCase();
  const treatAsBinary = ['.pdf', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.zip', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx'].includes(ext);
  if (treatAsBinary && buffer && Buffer.isBuffer(buffer) && bufferLooksLikeUtf8Text(buffer)) {
    const stem = baseForOpenAI.replace(/\.[^.]+$/, '') || 'document';
    return { filename: `${stem}_from_index.txt`, contentType: 'text/plain; charset=utf-8' };
  }
  return { filename: baseForOpenAI, contentType: guessMimeFromFilename(display) };
}

function guessMimeFromFilename(name) {
  const ext = String(name || '').split('.').pop()?.toLowerCase() || '';
  const map = {
    pdf: 'application/pdf',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    txt: 'text/plain',
    html: 'text/html',
    htm: 'text/html',
    csv: 'text/csv',
    json: 'application/json',
    xml: 'application/xml',
    doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ppt: 'application/vnd.ms-powerpoint',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    zip: 'application/zip',
    '7z': 'application/x-7z-compressed',
    rar: 'application/vnd.rar'
  };
  return map[ext] || 'application/octet-stream';
}

function sleepMs(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function jsonHeaders(openaiApiKey) {
  return { Authorization: `Bearer ${openaiApiKey}`, 'Content-Type': 'application/json' };
}

async function pollVectorStoreBatchComplete(openaiBase, openaiApiKey, vectorStoreId, batchId) {
  const url = `${openaiBase}/vector_stores/${vectorStoreId}/file_batches/${batchId}`;
  for (let i = 0; i < 90; i++) {
    const r = await axios.get(url, { headers: jsonHeaders(openaiApiKey), timeout: 60000 });
    const st = r.data?.status;
    if (st === 'completed') return { ok: true, data: r.data };
    if (st === 'failed' || st === 'cancelled') return { ok: false, error: r.data?.errors || r.data || st };
    await sleepMs(2000);
  }
  return { ok: false, error: 'Vector store indexing timed out' };
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} projectId
 * @param {{ openaiApiKey: string, openaiBase?: string, onLog?: (msg: string) => void }} opts
 * @returns {Promise<
 *   | { ok: true; vector_store_id: string; uploaded: number; skipped?: unknown[]; batch_status?: string }
 *   | { ok: false; status: number; error: string; skipped?: unknown[]; uploaded?: number; batch_id?: string }
 * >}
 */
export async function syncProjectGptRagToOpenAI(supabase, projectId, opts) {
  const openaiApiKey = (opts.openaiApiKey || '').trim();
  const openaiBase = (opts.openaiBase || 'https://api.openai.com/v1').replace(/\/$/, '');
  const log = opts.onLog || (() => {});

  if (!openaiApiKey) {
    return { ok: false, status: 503, error: 'OPENAI_API_KEY not set' };
  }

  const { data: project, error: pErr } = await supabase
    .from('projects')
    .select('id, name, openai_vector_store_id')
    .eq('id', projectId)
    .single();
  if (pErr || !project) {
    return { ok: false, status: 404, error: 'Project not found' };
  }

  const { data: files, error: fErr } = await supabase
    .from('project_files')
    .select('id, original_name, storage_path')
    .eq('project_id', projectId)
    .order('created_at', { ascending: false });
  if (fErr) {
    return { ok: false, status: 500, error: fErr.message || 'Failed to list project files' };
  }

  const candidates = (files || []).filter(isProjectFileGptRagEligible).slice(0, GPT_RAG_MAX_FILES);

  if (candidates.length === 0) {
    return {
      ok: false,
      status: 400,
      error:
        'No OpenAI-searchable documents in storage (e.g. PDF, DOCX, TXT, XLSX). Other file types in the project are ignored for GPT search.'
    };
  }

  const oldVsId = project.openai_vector_store_id || null;
  const vsName = `pm-${projectId}`.slice(0, 48);
  log(`create vector store "${vsName}"…`);
  const vsRes = await axios.post(
    `${openaiBase}/vector_stores`,
    { name: vsName, metadata: { project_id: projectId } },
    { headers: jsonHeaders(openaiApiKey), timeout: 60000 }
  );
  const newVsId = vsRes.data?.id;
  if (!newVsId) {
    return { ok: false, status: 500, error: 'OpenAI did not return vector_store id' };
  }

  const uploaded = [];
  const skipped = [];
  for (const row of candidates) {
    try {
      const { bucket, storagePath } = resolveBucketAndPath(row.storage_path);
      const { data: blob, error: dlErr } = await supabase.storage.from(bucket).download(storagePath);
      if (dlErr || !blob) {
        skipped.push({ id: row.id, name: row.original_name, error: dlErr?.message || 'download failed' });
        continue;
      }
      const buffer = Buffer.from(await blob.arrayBuffer());
      if (buffer.length > GPT_RAG_MAX_FILE_BYTES) {
        skipped.push({ id: row.id, name: row.original_name, error: 'File too large for OpenAI upload' });
        continue;
      }
      const filename = gptRagDisplayFilename(row);
      const { filename: openAiFileName, contentType } = openAiUploadFilenameAndMime(row, buffer);
      const form = new FormData();
      form.append('purpose', 'assistants');
      form.append('file', buffer, {
        filename: openAiFileName,
        contentType
      });

      const up = await axios.post(`${openaiBase}/files`, form, {
        headers: { ...form.getHeaders(), Authorization: `Bearer ${openaiApiKey}` },
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
        timeout: 120000
      });
      const fid = up.data?.id;
      if (!fid) throw new Error('OpenAI file upload missing id');
      uploaded.push({ project_file_id: row.id, openai_file_id: fid, name: filename });
      log(`uploaded ${uploaded.length}/${candidates.length}: ${filename}`);
    } catch (e) {
      skipped.push({ id: row.id, name: row.original_name, error: e.response?.data?.error?.message || e.message });
    }
  }

  if (uploaded.length === 0) {
    try {
      await axios.delete(`${openaiBase}/vector_stores/${newVsId}`, { headers: jsonHeaders(openaiApiKey), timeout: 30000 });
    } catch (_) {}
    return { ok: false, status: 502, error: 'Could not upload any files to OpenAI', skipped };
  }

  const fileIds = uploaded.map((u) => u.openai_file_id);
  log(`attach ${fileIds.length} files to vector store, wait for indexing…`);
  const batchRes = await axios.post(
    `${openaiBase}/vector_stores/${newVsId}/file_batches`,
    { file_ids: fileIds },
    { headers: jsonHeaders(openaiApiKey), timeout: 120000 }
  );
  const batchId = batchRes.data?.id;
  if (!batchId) {
    try {
      await axios.delete(`${openaiBase}/vector_stores/${newVsId}`, { headers: jsonHeaders(openaiApiKey), timeout: 30000 });
    } catch (_) {}
    return { ok: false, status: 500, error: 'OpenAI file batch missing id' };
  }

  const polled = await pollVectorStoreBatchComplete(openaiBase, openaiApiKey, newVsId, batchId);
  if (!polled.ok) {
    return {
      ok: false,
      status: 502,
      error: polled.error || 'Vector indexing failed',
      uploaded: uploaded.length,
      batch_id: batchId
    };
  }

  const { error: upErr } = await supabase
    .from('projects')
    .update({ openai_vector_store_id: newVsId, updated_at: new Date().toISOString() })
    .eq('id', projectId);
  if (upErr) {
    return { ok: false, status: 500, error: upErr.message || 'Failed to save vector_store_id' };
  }

  if (oldVsId && oldVsId !== newVsId) {
    axios.delete(`${openaiBase}/vector_stores/${oldVsId}`, { headers: jsonHeaders(openaiApiKey), timeout: 30000 }).catch(() => {});
  }

  return {
    ok: true,
    vector_store_id: newVsId,
    uploaded: uploaded.length,
    skipped: skipped.length ? skipped : undefined,
    batch_status: polled.data?.status
  };
}

/**
 * Appended to the user query so the model knows real project file names (scoping + citations).
 * Does not replace file_search — every claim must still be supported by retrieved snippets.
 */
export function buildProjectFileCatalogAppendix(rows) {
  const names = (rows || [])
    .filter(isProjectFileGptRagEligible)
    .map((row) => gptRagDisplayFilename(row))
    .filter(Boolean);
  const unique = [...new Set(names)];
  if (!unique.length) return '';
  return (
    '\n\n[System — project document index (names in this project only). Map the user\'s question to these files when they ask about a specific document. Every factual statement must still be supported only by file_search results; do not use general knowledge.]\n' +
    unique.map((n) => `· ${n}`).join('\n') +
    '\n'
  );
}
