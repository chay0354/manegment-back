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

/**
 * By default do not block the HTTP handler on OpenAI batch "completed" — indexing continues in the background.
 * Set MANEGER_GPT_RAG_WAIT_FOR_INDEXING=true only if you need the old blocking behaviour (slow UI).
 */
function shouldSkipManagerGptRagIndexWait() {
  if (process.env.MANEGER_GPT_RAG_WAIT_FOR_INDEXING === 'true' || process.env.MANEGER_GPT_RAG_WAIT_FOR_INDEXING === '1') {
    return false;
  }
  return true;
}

function jsonHeaders(openaiApiKey) {
  return { Authorization: `Bearer ${openaiApiKey}`, 'Content-Type': 'application/json' };
}

/** Vector store + file_batches endpoints expect Assistants v2 beta (listing may otherwise be empty). */
function openAiVectorHeaders(openaiApiKey) {
  return {
    Authorization: `Bearer ${openaiApiKey}`,
    'Content-Type': 'application/json',
    'OpenAI-Beta': 'assistants=v2'
  };
}

async function pollVectorStoreBatchComplete(openaiBase, openaiApiKey, vectorStoreId, batchId) {
  const url = `${openaiBase}/vector_stores/${vectorStoreId}/file_batches/${batchId}`;
  const maxIters = Math.max(90, parseInt(String(process.env.MANEGER_GPT_RAG_BATCH_POLL_MAX || '120'), 10) || 120);
  for (let i = 0; i < maxIters; i++) {
    const r = await axios.get(url, { headers: openAiVectorHeaders(openaiApiKey), timeout: 60000 });
    const st = r.data?.status;
    if (st === 'completed') return { ok: true, data: r.data };
    if (st === 'failed' || st === 'cancelled') return { ok: false, error: r.data?.errors || r.data || st };
    await sleepMs(2000);
  }
  return { ok: false, error: 'Vector store indexing timed out' };
}

async function detachOpenAiFileFromVectorStore(openaiBase, openaiApiKey, vsId, fileId) {
  await axios.delete(`${openaiBase}/vector_stores/${vsId}/files/${fileId}`, {
    headers: openAiVectorHeaders(openaiApiKey),
    timeout: 30000
  });
}

async function deleteOpenAiUploadedFile(openaiBase, openaiApiKey, fileId) {
  await axios.delete(`${openaiBase}/files/${fileId}`, {
    headers: jsonHeaders(openaiApiKey),
    timeout: 30000
  });
}

async function listCompletedOpenAiFileIdsInVectorStore(openaiBase, openaiApiKey, vsId) {
  const set = new Set();
  let after;
  for (let page = 0; page < 50; page++) {
    const params = { limit: 100, filter: 'completed' };
    if (after) params.after = after;
    const r = await axios.get(`${openaiBase}/vector_stores/${vsId}/files`, {
      headers: openAiVectorHeaders(openaiApiKey),
      params,
      timeout: 60000
    });
    const data = r.data?.data || [];
    for (const it of data) {
      if (it.status && it.status !== 'completed') continue;
      let fid = it.file_id;
      if (!fid) {
        try {
          const d = await axios.get(`${openaiBase}/vector_stores/${vsId}/files/${it.id}`, {
            headers: openAiVectorHeaders(openaiApiKey),
            timeout: 30000
          });
          fid = d.data?.file_id;
        } catch (_) {}
      }
      if (fid) set.add(fid);
    }
    if (!r.data?.has_more) break;
    after = r.data?.last_id;
  }
  return set;
}

/**
 * OpenAI upload filenames we might see for this row (detach + snippet filter).
 * @param {object} row project_files-shaped
 * @returns {Set<string>}
 */
export function collectOpenAiFilenameTargetsForProjectRow(row) {
  const display = gptRagDisplayFilename(row);
  const targets = new Set();
  if (display) {
    targets.add(display);
    targets.add(path.basename(String(display).replace(/\\/g, '/')));
  }
  try {
    const { filename } = openAiUploadFilenameAndMime(row, null);
    if (filename) targets.add(filename);
  } catch (_) {}
  const baseForOpenAI = path.basename(String(display).replace(/[/\\]/g, '_')) || '';
  if (baseForOpenAI) targets.add(baseForOpenAI);
  const stem = baseForOpenAI.replace(/\.[^.]+$/, '') || '';
  if (stem) targets.add(`${stem}_from_index.txt`);
  return targets;
}

/**
 * Drop file_search snippets that are not backed by current project_files (same idea as matriya-back).
 * @param {{ filename?: string, text?: string }[]} snippets
 * @param {object[]} catalogRows rows from project_files (original_name, storage_path, …)
 */
export function filterProjectGptSnippetsToIndex(snippets, catalogRows) {
  const v = process.env.MANEGER_GPT_SNIPPET_INDEX_FILTER;
  if (v === '0' || v === 'false') {
    return Array.isArray(snippets) ? snippets : [];
  }
  const rows = Array.isArray(catalogRows) ? catalogRows : [];
  const eligible = rows.filter(isProjectFileGptRagEligible);
  if (eligible.length === 0) return [];

  const allowed = new Set();
  for (const row of eligible) {
    collectOpenAiFilenameTargetsForProjectRow(row).forEach((x) => allowed.add(x));
  }

  const arr = Array.isArray(snippets) ? snippets : [];
  return arr.filter((s) => {
    const fn = String(s?.filename ?? '').trim();
    if (!fn) return false;
    if (allowed.has(fn)) return true;
    const bn = path.basename(fn.replace(/\\/g, '/'));
    for (const row of eligible) {
      const d = gptRagDisplayFilename(row);
      if (!d) continue;
      if (fn === d) return true;
      if (path.basename(String(d).replace(/\\/g, '/')) === bn) return true;
    }
    return false;
  });
}

/**
 * Incremental upload decision uses DB only. Do not require OpenAI "list files" (often empty without
 * OpenAI-Beta header or flaky); trusting openai_file_id + timestamps avoids re-uploading all 50 every sync.
 */
function projectRowNeedsGptUpload(row) {
  const fid = row.openai_file_id;
  if (fid == null || String(fid).trim() === '') return true;
  const synced = row.openai_synced_at ? new Date(row.openai_synced_at).getTime() : 0;
  if (!synced) return true;
  const updated = row.updated_at ? new Date(row.updated_at).getTime() : 0;
  return updated > synced;
}

async function uploadProjectFileToOpenAI(openaiBase, openaiApiKey, supabase, row) {
  const { bucket, storagePath } = resolveBucketAndPath(row.storage_path);
  const { data: blob, error: dlErr } = await supabase.storage.from(bucket).download(storagePath);
  if (dlErr || !blob) {
    return { ok: false, error: dlErr?.message || 'download failed' };
  }
  const buffer = Buffer.from(await blob.arrayBuffer());
  if (buffer.length > GPT_RAG_MAX_FILE_BYTES) {
    return { ok: false, error: 'File too large for OpenAI upload' };
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
  if (!fid) return { ok: false, error: 'OpenAI file upload missing id' };
  return { ok: true, project_file_id: row.id, openai_file_id: fid, name: filename };
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} projectId
 * @param {{
 *   openaiApiKey: string,
 *   openaiBase?: string,
 *   onLog?: (msg: string) => void,
 *   onlyProjectFileIds?: string[]
 * }} opts
 * When onlyProjectFileIds is set and the vector store exists, only those rows are considered for upload (per-file auto-sync).
 * @returns {Promise<
 *   | { ok: true; vector_store_id: string; uploaded: number; incremental?: boolean; skipped?: unknown[]; batch_status?: string; indexing_pending?: boolean; batch_id?: string }
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
    .select('id, original_name, storage_path, updated_at, openai_file_id, openai_synced_at')
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
  let vsValid = false;
  if (oldVsId) {
    try {
      await axios.get(`${openaiBase}/vector_stores/${oldVsId}`, {
        headers: openAiVectorHeaders(openaiApiKey),
        timeout: 30000
      });
      vsValid = true;
    } catch (e) {
      if (e.response?.status === 404) {
        log('stored vector store missing on OpenAI; full sync with a new store');
      } else {
        return { ok: false, status: 502, error: e.response?.data?.error?.message || e.message };
      }
    }
  }

  if (vsValid && oldVsId) {
    const idSet =
      opts.onlyProjectFileIds && opts.onlyProjectFileIds.length > 0
        ? new Set(opts.onlyProjectFileIds.map((x) => String(x)))
        : null;
    const syncPool = idSet ? candidates.filter((row) => idSet.has(String(row.id))) : candidates;

    const toUpload = syncPool.filter((row) => projectRowNeedsGptUpload(row));
    if (toUpload.length === 0) {
      return {
        ok: true,
        vector_store_id: oldVsId,
        uploaded: 0,
        incremental: true,
        batch_status: 'completed'
      };
    }

    const vsId = oldVsId;
    for (const row of toUpload) {
      const oldFid = row.openai_file_id;
      if (oldFid && String(oldFid).trim()) {
        try {
          await detachOpenAiFileFromVectorStore(openaiBase, openaiApiKey, vsId, oldFid);
          await deleteOpenAiUploadedFile(openaiBase, openaiApiKey, oldFid).catch(() => {});
        } catch (e) {
          log(`warn: could not remove old OpenAI file for ${row.original_name}: ${e.message}`);
        }
      }
    }

    const uploaded = [];
    const skipped = [];
    for (const row of toUpload) {
      try {
        const r = await uploadProjectFileToOpenAI(openaiBase, openaiApiKey, supabase, row);
        if (!r.ok) {
          skipped.push({ id: row.id, name: row.original_name, error: r.error });
          continue;
        }
        uploaded.push(r);
        log(`uploaded (incremental) ${uploaded.length}/${toUpload.length}: ${r.name}`);
      } catch (e) {
        skipped.push({
          id: row.id,
          name: row.original_name,
          error: e.response?.data?.error?.message || e.message
        });
      }
    }

    if (uploaded.length === 0) {
      return { ok: false, status: 502, error: 'Could not upload any new files to OpenAI', skipped };
    }

    const fileIds = uploaded.map((u) => u.openai_file_id);
    log(`attach ${fileIds.length} new/changed files to vector store, wait for indexing…`);
    const batchRes = await axios.post(
      `${openaiBase}/vector_stores/${vsId}/file_batches`,
      { file_ids: fileIds },
      { headers: openAiVectorHeaders(openaiApiKey), timeout: 120000 }
    );
    const batchId = batchRes.data?.id;
    if (!batchId) {
      return { ok: false, status: 500, error: 'OpenAI file batch missing id' };
    }

    const skipWait = shouldSkipManagerGptRagIndexWait();
    let polled;
    if (skipWait) {
      log(`batch ${batchId}: skip wait for vector indexing (OpenAI finishes in background).`);
      polled = { ok: true, data: { status: 'in_progress' }, indexingPending: true };
    } else {
      polled = await pollVectorStoreBatchComplete(openaiBase, openaiApiKey, vsId, batchId);
    }
    if (!polled.ok) {
      return {
        ok: false,
        status: 502,
        error: polled.error || 'Vector indexing failed',
        uploaded: uploaded.length,
        batch_id: batchId
      };
    }

    const nowIso = new Date().toISOString();
    for (const u of uploaded) {
      const { error: uErr } = await supabase
        .from('project_files')
        .update({ openai_file_id: u.openai_file_id, openai_synced_at: nowIso })
        .eq('id', u.project_file_id);
      if (uErr) {
        log(`warn: could not save openai_file_id for row ${u.project_file_id}: ${uErr.message}`);
      }
    }

    return {
      ok: true,
      vector_store_id: vsId,
      uploaded: uploaded.length,
      incremental: true,
      skipped: skipped.length ? skipped : undefined,
      batch_status: polled.data?.status || 'completed',
      indexing_pending: Boolean(polled.indexingPending),
      batch_id: batchId
    };
  }

  /* ——— Full sync ——— */
  await supabase
    .from('project_files')
    .update({ openai_file_id: null, openai_synced_at: null })
    .eq('project_id', projectId);

  const vsName = `pm-${projectId}`.slice(0, 48);
  log(`create vector store "${vsName}"…`);
  const vsRes = await axios.post(
    `${openaiBase}/vector_stores`,
    { name: vsName, metadata: { project_id: projectId } },
    { headers: openAiVectorHeaders(openaiApiKey), timeout: 60000 }
  );
  const newVsId = vsRes.data?.id;
  if (!newVsId) {
    return { ok: false, status: 500, error: 'OpenAI did not return vector_store id' };
  }

  const uploaded = [];
  const skipped = [];
  for (const row of candidates) {
    try {
      const r = await uploadProjectFileToOpenAI(openaiBase, openaiApiKey, supabase, row);
      if (!r.ok) {
        skipped.push({ id: row.id, name: row.original_name, error: r.error });
        continue;
      }
      uploaded.push(r);
      log(`uploaded ${uploaded.length}/${candidates.length}: ${r.name}`);
    } catch (e) {
      skipped.push({
        id: row.id,
        name: row.original_name,
        error: e.response?.data?.error?.message || e.message
      });
    }
  }

  if (uploaded.length === 0) {
    try {
      await axios.delete(`${openaiBase}/vector_stores/${newVsId}`, { headers: openAiVectorHeaders(openaiApiKey), timeout: 30000 });
    } catch (_) {}
    return { ok: false, status: 502, error: 'Could not upload any files to OpenAI', skipped };
  }

  const fileIds = uploaded.map((u) => u.openai_file_id);
  log(`attach ${fileIds.length} files to vector store, wait for indexing…`);
  const batchRes = await axios.post(
    `${openaiBase}/vector_stores/${newVsId}/file_batches`,
    { file_ids: fileIds },
    { headers: openAiVectorHeaders(openaiApiKey), timeout: 120000 }
  );
  const batchId = batchRes.data?.id;
  if (!batchId) {
    try {
      await axios.delete(`${openaiBase}/vector_stores/${newVsId}`, { headers: openAiVectorHeaders(openaiApiKey), timeout: 30000 });
    } catch (_) {}
    return { ok: false, status: 500, error: 'OpenAI file batch missing id' };
  }

  const skipWaitFull = shouldSkipManagerGptRagIndexWait();
  let polledFull;
  if (skipWaitFull) {
    log(`batch ${batchId} (full sync): skip wait for vector indexing (OpenAI finishes in background).`);
    polledFull = { ok: true, data: { status: 'in_progress' }, indexingPending: true };
  } else {
    polledFull = await pollVectorStoreBatchComplete(openaiBase, openaiApiKey, newVsId, batchId);
  }
  if (!polledFull.ok) {
    return {
      ok: false,
      status: 502,
      error: polledFull.error || 'Vector indexing failed',
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

  const nowIso = new Date().toISOString();
  for (const u of uploaded) {
    await supabase
      .from('project_files')
      .update({ openai_file_id: u.openai_file_id, openai_synced_at: nowIso })
      .eq('id', u.project_file_id);
  }

  if (oldVsId && oldVsId !== newVsId) {
    axios.delete(`${openaiBase}/vector_stores/${oldVsId}`, { headers: openAiVectorHeaders(openaiApiKey), timeout: 30000 }).catch(() => {});
  }

  return {
    ok: true,
    vector_store_id: newVsId,
    uploaded: uploaded.length,
    incremental: false,
    skipped: skipped.length ? skipped : undefined,
    batch_status: polledFull.data?.status || 'completed',
    indexing_pending: Boolean(polledFull.indexingPending),
    batch_id: batchId
  };
}

/**
 * After deleting a project_files row: detach OpenAI file from the project vector store (so GPT search cannot cite it).
 * Uses openai_file_id when set; otherwise scans the vector store for a matching upload filename.
 */
export async function removeProjectFileFromGptRagAndOpenAi(supabase, projectId, row, opts) {
  const openaiApiKey = (opts.openaiApiKey || '').trim();
  const openaiBase = (opts.openaiBase || 'https://api.openai.com/v1').replace(/\/$/, '');
  const log = typeof opts.onLog === 'function' ? opts.onLog : () => {};

  const { data: project } = await supabase
    .from('projects')
    .select('openai_vector_store_id')
    .eq('id', projectId)
    .single();
  const vsId = project?.openai_vector_store_id;
  if (!vsId || !openaiApiKey) return { openai_detached: false };

  const fid = row?.openai_file_id != null ? String(row.openai_file_id).trim() : '';

  if (fid) {
    try {
      await detachOpenAiFileFromVectorStore(openaiBase, openaiApiKey, vsId, fid);
      await deleteOpenAiUploadedFile(openaiBase, openaiApiKey, fid).catch(() => {});
      log(`detached OpenAI file by id for ${gptRagDisplayFilename(row)}`);
      return { openai_detached: true, via: 'file_id' };
    } catch (e) {
      log(`detach by openai_file_id failed: ${e.response?.data?.error?.message || e.message}`);
    }
  }

  const targets = collectOpenAiFilenameTargetsForProjectRow(row);
  if (targets.size === 0) return { openai_detached: false, reason: 'no_filename_targets' };

  try {
    const ids = await listCompletedOpenAiFileIdsInVectorStore(openaiBase, openaiApiKey, vsId);
    for (const fileId of ids) {
      let uploadFname;
      try {
        const r = await axios.get(`${openaiBase}/files/${fileId}`, {
          headers: jsonHeaders(openaiApiKey),
          timeout: 30000
        });
        uploadFname = r.data?.filename;
      } catch (_) {
        continue;
      }
      if (!uploadFname || !targets.has(uploadFname)) continue;
      try {
        await detachOpenAiFileFromVectorStore(openaiBase, openaiApiKey, vsId, fileId);
        await deleteOpenAiUploadedFile(openaiBase, openaiApiKey, fileId).catch(() => {});
        log(`detached OpenAI file by scan: "${uploadFname}"`);
        return { openai_detached: true, via: 'scan' };
      } catch (e) {
        log(`scan detach failed: ${e.message}`);
      }
    }
  } catch (e) {
    log(`list vector store files failed: ${e.message}`);
  }

  return { openai_detached: false };
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
    '\n\n[System — project document index. For broad questions (e.g. what the document is about), combine several file_search quotes into a source-based overview/summary; still no facts beyond the quotes. Otherwise: shorten/organize quotes only.]\n' +
    unique.map((n) => `· ${n}`).join('\n') +
    '\n'
  );
}
