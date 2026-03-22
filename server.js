/**
 * Project Manager API – Express + Supabase.
 * Features: projects, tasks, milestones, documents, notes, file upload, RAG (local management_vector in management DB).
 */
import 'dotenv/config';
import crypto from 'crypto';
import express from 'express';
import path from 'path';
import rateLimit from 'express-rate-limit';
import multer from 'multer';
import { createClient } from '@supabase/supabase-js';
import axios from 'axios';
import FormData from 'form-data';
import { z } from 'zod';
import * as XLSX from 'xlsx';
import { syncProjectGptRagToOpenAI, buildProjectFileCatalogAppendix } from './lib/gptRagSync.js';
/** Do not static-import pdf-to-img: it loads pdfjs-dist which needs canvas/DOM and crashes Vercel cold start. */

const PORT = parseInt(process.env.PORT, 10) || 8001;
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const MATRIYA_BACK_URL = (process.env.MATRIYA_BACK_URL || '').replace(/\/$/, '');
const SHAREPOINT_TENANT_ID = process.env.SHAREPOINT_TENANT_ID || '';
const SHAREPOINT_CLIENT_ID = process.env.SHAREPOINT_CLIENT_ID || '';
const SHAREPOINT_CLIENT_SECRET = process.env.SHAREPOINT_CLIENT_SECRET || '';
const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || '').trim();
const OPENAI_API_BASE = 'https://api.openai.com/v1';
/** Model for GPT RAG (Responses API + file_search). */
const OPENAI_RAG_MODEL = (process.env.OPENAI_RAG_MODEL || 'gpt-4o-mini').trim();
/** Grounded Q&A: only file_search; answer = transformation of quotes (shorten/organize OK; no new facts or inference). */
const GPT_RAG_QUERY_INSTRUCTIONS = `You are the project document Q&A engine.

חוקי תשובה (חובה — עברית למשתמש אלא אם ביקשו אחרת):
מותר: לקחת כמה ציטוטים מתוצאות file_search; לקצר אותם; לארגן אותם למשפטים ברורים.
אסור: להוסיף מידע שלא מופיע בציטוטים; להשלים פערים; להסיק מעבר למה שכתוב בציטוטים.
כלומר: התשובה = טרנספורמציה של הציטוטים בלבד — בלי עובדות שלא ניתן לקשר ישירות לטקסט שמוצג כציטוט.

English (same contract): You may take several excerpts from file_search, shorten them, and arrange into clear sentences. You must NOT add information absent from those excerpts, fill gaps, or infer beyond what the quoted text actually states. Every factual claim must trace to quoted retrieval text.

STRICT GROUNDING:
- Use ONLY content from file_search for this project's vector store for factual claims.
- Do NOT use general knowledge, training data, or the web for facts (products, materials, formulas, regulations, etc.).

FILE NAMES: List may include indexed names — prioritize a named file when the user asks about it. Cite source filenames for excerpts.

LANGUAGE: Hebrew (עברית) for the answer unless the user explicitly asks otherwise.

The vector store is exclusively this user's current project — never treat content as coming from elsewhere.`;
const RESEND_API_KEY = (process.env.RESEND_API_KEY || '').trim();
/** Verified-domain sender in Resend. Set RESEND_FROM_EMAIL (e.g. noreply@yourdomain.com). Default is sandbox only. */
const RESEND_FROM_EMAIL = (process.env.RESEND_FROM_EMAIL || 'onboarding@resend.dev').trim();
/** Optional: require ?secret= or Authorization: Bearer for POST /api/webhooks/resend-inbound */
const RESEND_INBOUND_WEBHOOK_SECRET = (process.env.RESEND_INBOUND_WEBHOOK_SECRET || '').trim();
/** Domain for Reply-To addresses: `<project_uuid>@DOMAIN` so replies route to the right project (Receiving must accept this address). */
const RESEND_REPLY_DOMAIN = (process.env.RESEND_REPLY_DOMAIN || '').trim() || (RESEND_FROM_EMAIL.includes('@') ? RESEND_FROM_EMAIL.split('@').pop().trim() : '');
/** Public base URL of this API (for inbound docs). e.g. https://your-api.vercel.app */
const PUBLIC_API_BASE = (process.env.PUBLIC_API_BASE_URL || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : '') || '').replace(/\/$/, '');
/** folder_display_name for files imported from email into “Lab” */
const LAB_EMAIL_IMPORT_FOLDER = 'Lab · email import';

const UUID_IN_TEXT_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})/i;

/** Parse "Name <email@x.com>" or "email@x.com" → email@x.com */
function parseEmailOnly(raw) {
  if (!raw || typeof raw !== 'string') return '';
  const m = raw.match(/<([^>]+)>/);
  return (m ? m[1] : raw).trim();
}

/** Find project UUID embedded in any recipient (e.g. ec9e94e5-...@inbound.domain.com). */
function extractProjectIdFromAddresses(addresses) {
  if (!Array.isArray(addresses)) return null;
  for (const a of addresses) {
    const email = parseEmailOnly(String(a)).toLowerCase();
    const hit = email.match(UUID_IN_TEXT_RE);
    if (hit) return hit[1];
    const local = email.split('@')[0] || '';
    const hit2 = local.match(UUID_IN_TEXT_RE);
    if (hit2) return hit2[1];
  }
  return null;
}

/** Resolve project UUID from inbound email: webhook ?project_id=..., To/Cc/Bcc, headers, or subject. */
function extractProjectIdFromInboundPayload(full, query) {
  const rawQ = query && query.project_id != null ? String(query.project_id).trim() : '';
  if (rawQ) {
    const m = rawQ.match(UUID_IN_TEXT_RE);
    if (m) return m[1].toLowerCase();
  }
  const toList = [];
  const push = (arr) => {
    if (!Array.isArray(arr)) return;
    for (const x of arr) toList.push(typeof x === 'string' ? x : (x && String(x)));
  };
  push(full.to);
  push(full.cc);
  push(full.bcc);
  let pid = extractProjectIdFromAddresses(toList);
  if (pid) return pid.toLowerCase();
  const headers = full.headers;
  if (headers && typeof headers === 'object') {
    try {
      const blob = JSON.stringify(headers);
      const m = blob.match(UUID_IN_TEXT_RE);
      if (m) return m[1].toLowerCase();
    } catch (_) {}
  }
  const subj = String(full.subject || '');
  const m2 = subj.match(UUID_IN_TEXT_RE);
  if (m2) return m2[1].toLowerCase();
  return null;
}

function replyToAddressForProject(projectId) {
  if (!projectId || !RESEND_REPLY_DOMAIN || RESEND_REPLY_DOMAIN.includes('resend.dev')) return null;
  const id = String(projectId).trim().toLowerCase();
  if (!UUID_IN_TEXT_RE.test(id)) return null;
  return `${id}@${RESEND_REPLY_DOMAIN}`;
}

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

function hasLocalRag() {
  return !!(process.env.POSTGRES_URL || process.env.DATABASE_URL);
}

let _ragServicePromise = null;
async function getLocalRag() {
  if (!hasLocalRag()) return null;
  if (!_ragServicePromise) _ragServicePromise = import('./lib/ragService.js').then(m => m.getRagService());
  return _ragServicePromise;
}

/** After new files land in storage, rebuild this project’s OpenAI vector store (debounced per project). */
const GPT_RAG_AUTO_SYNC_DEBOUNCE_MS = Math.max(
  5000,
  parseInt(String(process.env.GPT_RAG_AUTO_SYNC_DEBOUNCE_MS || '60000'), 10) || 60000
);
const gptRagAutoSyncTimers = new Map();

function scheduleOpenAiVectorSyncForProject(projectId, hint = '') {
  if (!OPENAI_API_KEY || !projectId) return;
  const id = String(projectId);
  const prev = gptRagAutoSyncTimers.get(id);
  if (prev) clearTimeout(prev);
  const t = setTimeout(() => {
    gptRagAutoSyncTimers.delete(id);
    syncProjectGptRagToOpenAI(supabase, id, {
      openaiApiKey: OPENAI_API_KEY,
      openaiBase: OPENAI_API_BASE,
      onLog: (msg) => console.log('[gpt-rag auto-sync]', hint || id, msg)
    })
      .then((r) => {
        if (r.ok) console.log('[gpt-rag auto-sync] done', id, 'uploaded=', r.uploaded, hint || '');
        else if (r.status === 400 && String(r.error || '').toLowerCase().includes('no supported')) {
          console.log('[gpt-rag auto-sync] skip (no eligible files)', id, hint || '');
        } else console.warn('[gpt-rag auto-sync]', id, r.status, r.error, hint || '');
      })
      .catch((e) => console.warn('[gpt-rag auto-sync] exception', id, e.message, hint || ''));
  }, GPT_RAG_AUTO_SYNC_DEBOUNCE_MS);
  gptRagAutoSyncTimers.set(id, t);
}

const app = express();
app.set('trust proxy', 1); // Vercel sends X-Forwarded-For; required for express-rate-limit to identify clients correctly

/** Comma-separated list in CORS_ORIGINS (Vercel env). Default includes production frontend + local dev. */
const DEFAULT_CORS_ORIGINS = [
  'https://manegment-front.vercel.app',
  'http://localhost:5173',
  'http://localhost:3000',
  'http://localhost:3001',
  'http://127.0.0.1:5173',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:3001'
];

function getAllowedOrigins() {
  const raw = process.env.CORS_ORIGINS;
  if (raw && String(raw).trim()) {
    return String(raw)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return DEFAULT_CORS_ORIGINS;
}

function isOriginAllowed(origin, allowedList) {
  if (!origin || typeof origin !== 'string') return false;
  if (allowedList.includes(origin)) return true;
  if (process.env.CORS_ALLOW_VERCEL_PREVIEWS === '1' || process.env.CORS_ALLOW_VERCEL_PREVIEWS === 'true') {
    try {
      const u = new URL(origin);
      return u.protocol === 'https:' && u.hostname.endsWith('.vercel.app');
    } catch (_) {
      return false;
    }
  }
  return false;
}

// CORS first: credentialed cross-origin requires an explicit allowlist (echo matching Origin only).
function corsHeaders(req, res, next) {
  const origin = req.headers.origin;
  const allowedList = getAllowedOrigins();
  const ok = isOriginAllowed(origin, allowedList);

  if (ok && origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Vary', 'Origin');
  }

  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, Authorization, X-Upload-ID, X-Request-ID, Accept'
  );
  res.setHeader('Access-Control-Max-Age', '86400');

  if (req.method === 'OPTIONS') {
    if (ok && origin) return res.sendStatus(204);
    return res.sendStatus(403);
  }
  next();
}
app.use(corsHeaders);
app.use(express.json({ limit: '1mb' }));

// Request ID for audit (actor, entity, action, before/after, request_id)
app.use((req, res, next) => {
  req.requestId = req.headers['x-request-id'] || crypto.randomUUID();
  next();
});

// Login/signup only — NOT shared with /api/auth/me. Disable locally: DISABLE_AUTH_RATE_LIMIT=1
const limiterLogin = rateLimit({
  windowMs: 60 * 1000,
  max: Math.min(500, Math.max(10, parseInt(process.env.AUTH_LOGIN_RATE_LIMIT_MAX, 10) || 120)),
  message: { error: 'Too many login attempts. Wait a minute and try again.' },
  standardHeaders: true,
  legacyHeaders: false
});
const skipAuthRateLimit = process.env.DISABLE_AUTH_RATE_LIMIT === '1' || process.env.DISABLE_AUTH_RATE_LIMIT === 'true';
const limiterLoginMw = skipAuthRateLimit ? ((req, res, next) => next()) : limiterLogin;
const limiterUpload = rateLimit({
  windowMs: 60 * 1000,
  max: parseInt(process.env.UPLOAD_RATE_LIMIT_MAX, 10) || 100,
  message: { error: 'Too many uploads' }
});
const limiterSharePoint = rateLimit({ windowMs: 60 * 1000, max: 5, message: { error: 'Too many SharePoint pull requests' } });
const limiterRag = rateLimit({ windowMs: 60 * 1000, max: 30, message: { error: 'Too many RAG requests' } });
const limiterEmail = rateLimit({ windowMs: 60 * 1000, max: 15, message: { error: 'Too many emails. Try again later.' } });
const limiterGeneral = rateLimit({
  windowMs: 60 * 1000,
  max: parseInt(process.env.API_RATE_LIMIT_MAX, 10) || 400,
  message: { error: 'Too many requests' },
  // Auth must not share this bucket — /me + login were competing with all other API traffic (429 on login).
  skip: (req) => {
    if (req.method === 'OPTIONS') return true;
    const p = req.path || '';
    return p.startsWith('/api/auth');
  }
});
app.use('/api/rag', limiterRag);
app.use(limiterGeneral);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 200 * 1024 * 1024 } // 200MB per file
});

// Pagination: ?limit=50&offset=0 (limit 1–100, default 50)
function parsePagination(req) {
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50));
  const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
  return { limit, offset };
}

// Root (for Vercel / health checks)
app.get('/', (req, res) => res.json({ service: 'maneger-back', health: '/health', api: '/api' }));
app.get('/favicon.ico', (req, res) => res.status(204).end());
app.get('/favicon.png', (req, res) => res.status(204).end());

// ---------- Projects ----------
app.get('/api/projects', async (req, res) => {
  try {
    const { limit, offset } = parsePagination(req);
    const { count } = await supabase.from('projects').select('*', { count: 'exact', head: true });
    const { data, error } = await supabase.from('projects').select('*').order('updated_at', { ascending: false }).range(offset, offset + limit - 1);
    if (error) throw error;
    res.json({ projects: data || [], limit, offset, total: count ?? 0 });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/projects', async (req, res) => {
  try {
    const user = await getCurrentUser(req);
    if (!user) {
      return res.status(401).json({
        error: MATRIYA_BACK_URL ? 'Authentication required' : 'MATRIYA_BACK_URL not set. Set it in .env and ensure Matriya back is running for auth.'
      });
    }
    const { name, description } = req.body || {};
    if (!name || !name.trim()) return res.status(400).json({ error: 'name is required' });
    const { data: project, error: errProject } = await supabase.from('projects').insert({
      name: name.trim(),
      description: (description || '').trim() || null
    }).select().single();
    if (errProject) throw errProject;
    await upsertUserCache(user.id, user.username);
    const { error: errMember } = await supabase.from('project_members').insert({
      project_id: project.id,
      user_id: user.id,
      role: 'owner'
    });
    if (errMember) {
      const msg = String(errMember.message || errMember);
      if (msg.includes('does not exist') || msg.includes('relation') || msg.includes('project_members')) {
        return res.status(503).json({
          error: 'Database schema missing. Run the full supabase_schema.sql in Supabase SQL Editor (including project_members and user_cache tables).',
          detail: msg
        });
      }
      throw errMember;
    }
    auditLog(project.id, user.id, user.username, 'create', 'project', project.id, { name: project.name }, req.requestId);
    res.status(201).json(project);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/projects/:id/access', async (req, res) => {
  try {
    const user = await getCurrentUser(req);
    const projectId = req.params.id;
    const { data: project } = await supabase.from('projects').select('id').eq('id', projectId).single();
    if (!project) return res.status(404).json({ error: 'Project not found' });
    let hasMembers = await projectHasMembers(projectId);
    if (!hasMembers) {
      // Project has no members (e.g. created before project_members existed). Treat current user as owner and add them.
      if (user) {
        try {
          await upsertUserCache(user.id, user.username);
          const { error: err } = await supabase.from('project_members').insert({
            project_id: projectId,
            user_id: user.id,
            role: 'owner'
          });
          if (!err) hasMembers = true;
        } catch (_) { /* table may be missing; still return owner below */ }
      }
      return res.json({ canAccess: true, role: user ? 'owner' : null, hasPendingRequest: false });
    }
    const access = await getProjectAccess(projectId, user?.id, user?.username);
    res.json(access);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/projects/:id', async (req, res) => {
  try {
    const user = await getCurrentUser(req);
    const projectId = req.params.id;
    const { data, error } = await supabase.from('projects').select('*').eq('id', projectId).single();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Project not found' });
    const hasMembers = await projectHasMembers(projectId);
    if (!hasMembers) return res.json(data);
    const access = await getProjectAccess(projectId, user?.id, user?.username);
    if (!access.canAccess) return res.status(403).json({ error: 'not_member', canRequest: true });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.patch('/api/projects/:id', async (req, res) => {
  try {
    const user = await getCurrentUser(req);
    if (!user) return res.status(401).json({ error: 'Authentication required' });
    const { data: member } = await supabase.from('project_members').select('role').eq('project_id', req.params.id).eq('user_id', user.id).single();
    if (!member || member.role !== 'owner') return res.status(403).json({ error: 'Only project owner can update' });
    const { name, description } = req.body || {};
    const updates = { updated_at: new Date().toISOString() };
    if (name !== undefined) updates.name = name.trim();
    if (description !== undefined) updates.description = description.trim() || null;
    const { data, error } = await supabase.from('projects').update(updates).eq('id', req.params.id).select().single();
    if (error) throw error;
    auditLog(req.params.id, user.id, user.username, 'update', 'project', data.id, null, req.requestId);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/projects/:id', async (req, res) => {
  try {
    const user = await getCurrentUser(req);
    if (!user) return res.status(401).json({ error: 'Authentication required' });
    const { data: member } = await supabase.from('project_members').select('role').eq('project_id', req.params.id).eq('user_id', user.id).single();
    if (!member || member.role !== 'owner') return res.status(403).json({ error: 'Only project owner can delete' });
    const { error } = await supabase.from('projects').delete().eq('id', req.params.id);
    if (error) throw error;
    auditLog(req.params.id, user.id, user.username, 'delete', 'project', req.params.id, null, req.requestId);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/projects/:id/request', async (req, res) => {
  try {
    const user = await getCurrentUser(req);
    if (!user) return res.status(401).json({ error: 'Authentication required' });
    const projectId = req.params.id;
    const { data: project } = await supabase.from('projects').select('id').eq('id', projectId).single();
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const access = await getProjectAccess(projectId, user.id, user.username);
    if (access.canAccess) return res.status(400).json({ error: 'Already a member' });
    if (access.hasPendingRequest) return res.status(400).json({ error: 'Request already pending' });
    await upsertUserCache(user.id, user.username);
    const { error: err } = await supabase.from('project_join_requests').insert({
      project_id: projectId,
      user_id: user.id,
      username: user.username,
      status: 'pending'
    });
    if (err) throw err;
    res.status(201).json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/projects/:id/requests', async (req, res) => {
  try {
    const user = await getCurrentUser(req);
    if (!user) return res.status(401).json({ error: 'Authentication required' });
    const { data: owner } = await supabase.from('project_members').select('id').eq('project_id', req.params.id).eq('user_id', user.id).eq('role', 'owner').single();
    if (!owner) return res.status(403).json({ error: 'Only project owner can see requests' });
    const { data, error } = await supabase.from('project_join_requests').select('*').eq('project_id', req.params.id).eq('status', 'pending').order('created_at', { ascending: false });
    if (error) throw error;
    res.json({ requests: data || [] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/projects/:id/requests/:requestId/approve', async (req, res) => {
  try {
    const user = await getCurrentUser(req);
    if (!user) return res.status(401).json({ error: 'Authentication required' });
    const { data: owner } = await supabase.from('project_members').select('id').eq('project_id', req.params.id).eq('user_id', user.id).eq('role', 'owner').single();
    if (!owner) return res.status(403).json({ error: 'Only project owner can approve' });
    const { data: reqRow } = await supabase.from('project_join_requests').select('*').eq('id', req.params.requestId).eq('project_id', req.params.id).eq('status', 'pending').single();
    if (!reqRow) return res.status(404).json({ error: 'Request not found' });
    await supabase.from('project_members').insert({ project_id: req.params.id, user_id: reqRow.user_id, role: 'member' });
    await supabase.from('project_join_requests').update({ status: 'approved' }).eq('id', req.params.requestId);
    auditLog(req.params.id, user.id, user.username, 'request_approve', 'project_join_request', req.params.requestId, { username: reqRow.username }, req.requestId);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/projects/:id/requests/:requestId/reject', async (req, res) => {
  try {
    const user = await getCurrentUser(req);
    if (!user) return res.status(401).json({ error: 'Authentication required' });
    const { data: owner } = await supabase.from('project_members').select('id').eq('project_id', req.params.id).eq('user_id', user.id).eq('role', 'owner').single();
    if (!owner) return res.status(403).json({ error: 'Only project owner can reject' });
    await supabase.from('project_join_requests').update({ status: 'rejected' }).eq('id', req.params.requestId).eq('project_id', req.params.id);
    auditLog(req.params.id, user.id, user.username, 'request_reject', 'project_join_request', req.params.requestId, null, req.requestId);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// List users for "add member" dropdown. Fetches from Matriya (same users as auth); optional ?projectId= to exclude current members.
app.get('/api/users', async (req, res) => {
  try {
    const user = await getCurrentUser(req);
    if (!user) return res.status(401).json({ error: 'Authentication required' });
    const projectId = req.query.projectId;
    let excludeUserIds = [];
    if (projectId) {
      const { data: rows } = await supabase.from('project_members').select('user_id').eq('project_id', projectId);
      excludeUserIds = (rows || []).map(r => r.user_id);
    }
    let users = [];
    if (MATRIYA_BACK_URL && req.headers.authorization) {
      try {
        const r = await axios.get(`${MATRIYA_BACK_URL}/auth/users`, {
          headers: { Authorization: req.headers.authorization },
          timeout: 10000
        });
        if (r.data && Array.isArray(r.data.users)) users = r.data.users;
        for (const u of users) await upsertUserCache(u.user_id, u.username);
      } catch (_) { /* fall back to user_cache */ }
    }
    if (users.length === 0) {
      const { data: cache } = await supabase.from('user_cache').select('user_id, username').order('username');
      users = (cache || []).map(c => ({ user_id: c.user_id, username: c.username }));
    }
    if (excludeUserIds.length) users = users.filter(u => !excludeUserIds.includes(u.user_id));
    res.json({ users });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/projects/:id/members', async (req, res) => {
  try {
    const user = await getCurrentUser(req);
    if (!user) return res.status(401).json({ error: 'Authentication required' });
    const { data: myMember } = await supabase.from('project_members').select('role').eq('project_id', req.params.id).eq('user_id', user.id).single();
    if (!myMember) return res.status(403).json({ error: 'Not a project member' });
    const { data: rows } = await supabase.from('project_members').select('user_id, role, created_at').eq('project_id', req.params.id);
    const userIds = [...new Set((rows || []).map(r => r.user_id))];
    const { data: cache } = await supabase.from('user_cache').select('user_id, username').in('user_id', userIds);
    const byId = (cache || []).reduce((acc, c) => { acc[c.user_id] = c.username; return acc; }, {});
    const members = (rows || []).map(r => ({ user_id: r.user_id, username: byId[r.user_id] || String(r.user_id), role: r.role, created_at: r.created_at }));
    res.json({ members });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/projects/:id/members', async (req, res) => {
  try {
    const user = await getCurrentUser(req);
    if (!user) return res.status(401).json({ error: 'Authentication required' });
    const { data: owner } = await supabase.from('project_members').select('id').eq('project_id', req.params.id).eq('user_id', user.id).eq('role', 'owner').single();
    if (!owner) return res.status(403).json({ error: 'Only project owner can add members' });
    const { username } = req.body || {};
    if (!username || !String(username).trim()) return res.status(400).json({ error: 'username is required' });
    const un = String(username).trim();
    const { data: cached } = await supabase.from('user_cache').select('user_id').eq('username', un).single();
    if (!cached) return res.status(404).json({ error: 'User not found. They must log in to the manager at least once.' });
    const { error: err } = await supabase.from('project_members').insert({ project_id: req.params.id, user_id: cached.user_id, role: 'member' }).select();
    if (err) {
      if (err.code === '23505') return res.status(400).json({ error: 'Already a member' });
      throw err;
    }
    auditLog(req.params.id, user.id, user.username, 'member_add', 'project_member', cached.user_id, { username: un }, req.requestId);
    res.status(201).json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/projects/:id/members/:userId', async (req, res) => {
  try {
    const user = await getCurrentUser(req);
    if (!user) return res.status(401).json({ error: 'Authentication required' });
    const { data: owner } = await supabase.from('project_members').select('id').eq('project_id', req.params.id).eq('user_id', user.id).eq('role', 'owner').single();
    if (!owner) return res.status(403).json({ error: 'Only project owner can remove members' });
    const targetUserId = parseInt(req.params.userId, 10);
    if (targetUserId === user.id) return res.status(400).json({ error: 'Cannot remove yourself' });
    const { data: target } = await supabase.from('project_members').select('role').eq('project_id', req.params.id).eq('user_id', targetUserId).single();
    if (!target) return res.status(404).json({ error: 'Member not found' });
    if (target.role === 'owner') return res.status(400).json({ error: 'Cannot remove project owner' });
    const { error } = await supabase.from('project_members').delete().eq('project_id', req.params.id).eq('user_id', targetUserId);
    if (error) throw error;
    auditLog(req.params.id, user.id, user.username, 'member_remove', 'project_member', targetUserId, null, req.requestId);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- Project chat (any member can read/write) ----------
app.get('/api/projects/:id/chat/count', async (req, res) => {
  try {
    const user = await getCurrentUser(req);
    const projectId = req.params.id;
    const { data: project } = await supabase.from('projects').select('id').eq('id', projectId).single();
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const hasMembers = await projectHasMembers(projectId);
    const access = hasMembers ? await getProjectAccess(projectId, user?.id, user?.username) : { canAccess: !!user, role: user ? 'owner' : null };
    if (!access.canAccess) return res.status(403).json({ error: 'Access required' });
    const { count, error } = await supabase.from('project_chat_messages').select('*', { count: 'exact', head: true }).eq('project_id', projectId);
    if (error && !String(error.message || '').includes('does not exist') && !String(error.message || '').includes('relation')) throw error;
    res.json({ count: typeof count === 'number' ? count : 0 });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/projects/:id/chat', async (req, res) => {
  try {
    const user = await getCurrentUser(req);
    const projectId = req.params.id;
    const { data: project } = await supabase.from('projects').select('id').eq('id', projectId).single();
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const hasMembers = await projectHasMembers(projectId);
    const access = hasMembers ? await getProjectAccess(projectId, user?.id, user?.username) : { canAccess: !!user, role: user ? 'owner' : null };
    if (!access.canAccess) return res.status(403).json({ error: 'Access required' });
    const { limit, offset } = parsePagination(req);
    const { data, error } = await supabase.from('project_chat_messages').select('*').eq('project_id', projectId).order('created_at', { ascending: true }).range(offset, offset + limit - 1);
    if (error) {
      if (String(error.message || '').includes('does not exist') || String(error.message || '').includes('relation')) {
        return res.json({ messages: [], limit, offset });
      }
      throw error;
    }
    res.json({ messages: data || [], limit, offset });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/projects/:id/chat', async (req, res) => {
  try {
    const user = await getCurrentUser(req);
    if (!user) return res.status(401).json({ error: 'Authentication required' });
    const projectId = req.params.id;
    const { data: project } = await supabase.from('projects').select('id').eq('id', projectId).single();
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const hasMembers = await projectHasMembers(projectId);
    const access = hasMembers ? await getProjectAccess(projectId, user.id, user.username) : { canAccess: true, role: 'owner' };
    if (!access.canAccess) return res.status(403).json({ error: 'Access required' });
    const body = (req.body && req.body.body) ? String(req.body.body).trim() : '';
    if (!body) return res.status(400).json({ error: 'body is required' });
    await upsertUserCache(user.id, user.username);
    const { data: row, error } = await supabase.from('project_chat_messages').insert({
      project_id: projectId,
      user_id: user.id,
      username: user.username || 'User',
      body
    }).select().single();
    if (error) {
      if (String(error.message || '').includes('does not exist') || String(error.message || '').includes('relation')) {
        return res.status(503).json({ error: 'Chat not available. Run project_chat_messages in supabase_schema.sql.' });
      }
      throw error;
    }
    auditLog(projectId, user.id, user.username, 'create', 'chat_message', row.id, null, req.requestId);
    res.status(201).json(row);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** Unread = messages with created_at strictly after this user's last_read_at (stored in DB). */
app.get('/api/projects/:id/chat/unread', async (req, res) => {
  try {
    const user = await getCurrentUser(req);
    if (!user) return res.status(401).json({ error: 'Authentication required' });
    const projectId = req.params.id;
    const { data: project } = await supabase.from('projects').select('id').eq('id', projectId).single();
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const hasMembers = await projectHasMembers(projectId);
    const access = hasMembers ? await getProjectAccess(projectId, user.id, user.username) : { canAccess: true, role: 'owner' };
    if (!access.canAccess) return res.status(403).json({ error: 'Access required' });
    const { data: readRow, error: readErr } = await supabase
      .from('project_chat_last_read')
      .select('last_read_at')
      .eq('project_id', projectId)
      .eq('user_id', user.id)
      .maybeSingle();
    if (
      readErr &&
      !String(readErr.message || '').includes('does not exist') &&
      !String(readErr.message || '').includes('relation')
    ) {
      throw readErr;
    }
    const lastRead = readRow?.last_read_at || '1970-01-01T00:00:00.000Z';
    const { count, error } = await supabase
      .from('project_chat_messages')
      .select('*', { count: 'exact', head: true })
      .eq('project_id', projectId)
      .gt('created_at', lastRead);
    if (error) {
      if (String(error.message || '').includes('does not exist') || String(error.message || '').includes('relation')) {
        return res.json({ unread: 0 });
      }
      throw error;
    }
    res.json({ unread: typeof count === 'number' ? count : 0 });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** Advance last_read_at to at least read_through (ISO) or latest message time — never moves backward. */
app.post('/api/projects/:id/chat/read', async (req, res) => {
  try {
    const user = await getCurrentUser(req);
    if (!user) return res.status(401).json({ error: 'Authentication required' });
    const projectId = req.params.id;
    const { data: project } = await supabase.from('projects').select('id').eq('id', projectId).single();
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const hasMembers = await projectHasMembers(projectId);
    const access = hasMembers ? await getProjectAccess(projectId, user.id, user.username) : { canAccess: true, role: 'owner' };
    if (!access.canAccess) return res.status(403).json({ error: 'Access required' });
    let readThrough = (req.body && req.body.read_through) ? String(req.body.read_through).trim() : '';
    if (!readThrough) {
      const { data: latest, error: latestErr } = await supabase
        .from('project_chat_messages')
        .select('created_at')
        .eq('project_id', projectId)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (
        latestErr &&
        !String(latestErr.message || '').includes('does not exist') &&
        !String(latestErr.message || '').includes('relation')
      ) {
        throw latestErr;
      }
      readThrough = (latest && latest.created_at) ? latest.created_at : new Date().toISOString();
    }
    const throughMs = Date.parse(readThrough);
    if (Number.isNaN(throughMs)) return res.status(400).json({ error: 'Invalid read_through' });
    const { data: existing, error: exErr } = await supabase
      .from('project_chat_last_read')
      .select('last_read_at')
      .eq('project_id', projectId)
      .eq('user_id', user.id)
      .maybeSingle();
    if (
      exErr &&
      !String(exErr.message || '').includes('does not exist') &&
      !String(exErr.message || '').includes('relation')
    ) {
      throw exErr;
    }
    const existingMs = existing?.last_read_at ? Date.parse(existing.last_read_at) : 0;
    const finalMs = Math.max(existingMs || 0, throughMs);
    const finalIso = new Date(finalMs).toISOString();
    const { error: upErr } = await supabase.from('project_chat_last_read').upsert(
      { project_id: projectId, user_id: user.id, last_read_at: finalIso },
      { onConflict: 'project_id,user_id' }
    );
    if (
      upErr &&
      (String(upErr.message || '').includes('does not exist') || String(upErr.message || '').includes('relation'))
    ) {
      return res.status(503).json({ error: 'Chat read state not available. Run project_chat_last_read in supabase_schema.sql.' });
    }
    if (upErr) throw upErr;
    res.json({ last_read_at: finalIso });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- Project emails (Resend: send + list; inbound webhook to receive) ----------
const EMAIL_ATTACH_MAX_FILES = 15;
const EMAIL_ATTACH_MAX_TOTAL_BYTES = 24 * 1024 * 1024; // under Resend ~40MB post-base64 limit
const EMAIL_INLINE_ATTACH_MAX = 8;
const EMAIL_INLINE_ONE_MAX_BYTES = 15 * 1024 * 1024;

const emailSendSchema = z
  .object({
    to: z.union([z.string().email(), z.array(z.string().email())]),
    subject: z.string().min(1).max(998),
    text: z.string().max(500000).optional(),
    html: z.string().max(500000).optional(),
    attachment_file_ids: z.array(z.string().uuid()).max(EMAIL_ATTACH_MAX_FILES).optional(),
    inline_attachments: z
      .array(
        z.object({
          filename: z.string().min(1).max(240),
          content_base64: z.string().min(1).max(Math.ceil(EMAIL_INLINE_ONE_MAX_BYTES * 1.4))
        })
      )
      .max(EMAIL_INLINE_ATTACH_MAX)
      .optional()
  })
  .superRefine((data, ctx) => {
    const nProj = data.attachment_file_ids?.length || 0;
    const nIn = data.inline_attachments?.length || 0;
    if (nProj + nIn > EMAIL_ATTACH_MAX_FILES) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Too many attachments (max ${EMAIL_ATTACH_MAX_FILES} combined).`,
        path: ['attachment_file_ids']
      });
    }
  });

function safeEmailAttachmentFilename(name) {
  const base = String(name || 'file')
    .replace(/[/\\]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
  return base || 'file';
}

function appendInlineAttachmentsForResend(inlineList, resendAttachments, attachmentMeta, totalBytesSoFar) {
  let total = totalBytesSoFar;
  for (const item of inlineList) {
    if (resendAttachments.length >= EMAIL_ATTACH_MAX_FILES) {
      throw new Error(`Too many attachments (max ${EMAIL_ATTACH_MAX_FILES}).`);
    }
    const fname = safeEmailAttachmentFilename(item.filename);
    let buf;
    try {
      buf = Buffer.from(item.content_base64, 'base64');
    } catch {
      throw new Error(`Invalid encoding for attachment "${fname}".`);
    }
    if (!buf.length) throw new Error(`Empty attachment "${fname}".`);
    if (buf.length > EMAIL_INLINE_ONE_MAX_BYTES) {
      throw new Error(`Attachment "${fname}" is too large (max 15 MB per file).`);
    }
    total += buf.length;
    if (total > EMAIL_ATTACH_MAX_TOTAL_BYTES) {
      throw new Error('Attachments exceed maximum total size (24 MB).');
    }
    resendAttachments.push({
      filename: fname,
      content: buf.toString('base64'),
      content_type: guessMimeFromFilename(fname)
    });
    attachmentMeta.push({ filename: fname, source: 'computer' });
  }
  return total;
}
const emailAttachImportSchema = z.object({
  attachment_id: z.string().min(8),
  destination: z.enum(['project_files', 'lab'])
});

/** Resend Inbound: after email.received, fetch full body and store under matched project (UUID in To address). */
app.post('/api/webhooks/resend-inbound', async (req, res) => {
  try {
    if (RESEND_INBOUND_WEBHOOK_SECRET) {
      const q = req.query.secret;
      const auth = req.headers.authorization || '';
      const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : '';
      if (q !== RESEND_INBOUND_WEBHOOK_SECRET && bearer !== RESEND_INBOUND_WEBHOOK_SECRET) {
        return res.status(401).json({ error: 'Invalid webhook secret' });
      }
    }
    const event = req.body || {};
    if (event.type !== 'email.received') return res.status(200).json({ ok: true, ignored: true });
    const emailId = event.data?.email_id;
    if (!emailId || !RESEND_API_KEY) return res.status(400).json({ error: 'Missing email_id or RESEND_API_KEY' });
    console.info('[resend-inbound] email.received', emailId, 'project_id query =', req.query.project_id || '(none)');

    const r = await fetch(`https://api.resend.com/emails/receiving/${emailId}`, {
      headers: { Authorization: `Bearer ${RESEND_API_KEY}` }
    });
    const full = await r.json().catch(() => ({}));
    if (!r.ok) {
      return res.status(502).json({ error: full.message || 'Resend receiving API error', details: full });
    }

    const toList = Array.isArray(full.to) ? full.to : [];
    const projectId = extractProjectIdFromInboundPayload(full, req.query);
    if (!projectId) {
      console.warn('[resend-inbound] skipped: no_project_id', { emailId, to: toList, hint: 'Add ?project_id=<uuid> to webhook URL or put project UUID in recipient address' });
      return res.status(200).json({ ok: true, skipped: 'no_project_id_in_recipients' });
    }

    const { data: proj } = await supabase.from('projects').select('id').eq('id', projectId).single();
    if (!proj) {
      console.warn('[resend-inbound] skipped: project_not_found', { projectId, emailId });
      return res.status(200).json({ ok: true, skipped: 'project_not_found' });
    }

    const fromEmail = parseEmailOnly(String(full.from || '')) || String(full.from || '');
    const subject = String(full.subject || '');
    const bodyText = full.text != null ? String(full.text) : null;
    const bodyHtml = full.html != null ? String(full.html) : null;
    const attachments = Array.isArray(full.attachments)
      ? full.attachments.map(a => {
        const id = a.id || a.attachment_id || a.attachmentId;
        return {
          id,
          attachment_id: id,
          filename: a.filename,
          content_type: a.content_type,
          content_disposition: a.content_disposition,
          content_id: a.content_id
        };
      })
      : [];

    const insertPayload = {
      project_id: projectId,
      direction: 'received',
      from_email: fromEmail,
      to_emails: toList,
      subject,
      body_text: bodyText,
      body_html: bodyHtml,
      resend_email_id: emailId,
      sent_by_user_id: null,
      sent_by_username: null,
      attachments
    };
    const { error: insErr } = await supabase.from('project_emails').insert(insertPayload);
    if (insErr) {
      if (String(insErr.message || '').includes('duplicate') || insErr.code === '23505') {
        return res.status(200).json({ ok: true, duplicate: true });
      }
      if (String(insErr.message || '').includes('does not exist') || String(insErr.message || '').includes('relation')) {
        return res.status(503).json({ error: 'project_emails table missing. Run supabase_schema.sql (project_emails).' });
      }
      throw insErr;
    }
    auditLog(projectId, null, 'inbound', 'create', 'project_email', emailId, { subject, from: fromEmail }, req.requestId);
    return res.status(201).json({ ok: true, project_id: projectId });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

app.get('/api/projects/:projectId/emails', async (req, res) => {
  try {
    const projectId = req.params.projectId;
    const ctx = await requireProjectMember(req, res, projectId);
    if (!ctx) return;
    const { limit, offset } = parsePagination(req);
    const dir = (req.query.direction || 'all').toLowerCase();
    let q = supabase.from('project_emails').select('*', { count: 'exact' }).eq('project_id', projectId).order('created_at', { ascending: false });
    if (dir === 'sent') q = q.eq('direction', 'sent');
    else if (dir === 'received') q = q.eq('direction', 'received');
    const { data, error, count } = await q.range(offset, offset + limit - 1);
    if (error) {
      if (String(error.message || '').includes('does not exist') || String(error.message || '').includes('relation')) {
        return res.json({ emails: [], limit, offset, total: 0 });
      }
      throw error;
    }
    res.json({ emails: data || [], limit, offset, total: count ?? 0 });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/projects/:projectId/emails/:emailId', async (req, res) => {
  try {
    const projectId = req.params.projectId;
    const ctx = await requireProjectMember(req, res, projectId);
    if (!ctx) return;
    const { data, error } = await supabase.from('project_emails').select('*').eq('id', req.params.emailId).eq('project_id', projectId).single();
    if (error || !data) return res.status(404).json({ error: 'Email not found' });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** Help frontend show correct Resend Inbound + Reply-To (no secrets). */
app.get('/api/projects/:projectId/emails/inbound-config', async (req, res) => {
  try {
    const projectId = req.params.projectId;
    const ctx = await requireProjectMember(req, res, projectId);
    if (!ctx) return;
    const replyTo = replyToAddressForProject(projectId);
    const host = PUBLIC_API_BASE || '(set PUBLIC_API_BASE_URL to your public API, e.g. https://api.example.com)';
    const webhookTemplate = `${host}/api/webhooks/resend-inbound?secret=YOUR_SECRET&project_id=${projectId}`;
    res.json({
      project_id: projectId,
      reply_to_address: replyTo,
      reply_domain: RESEND_REPLY_DOMAIN || null,
      webhook_url_template: webhookTemplate,
      secret_configured: !!RESEND_INBOUND_WEBHOOK_SECRET
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/projects/:projectId/emails/send', limiterEmail, async (req, res) => {
  try {
    const projectId = req.params.projectId;
    const ctx = await requireProjectMember(req, res, projectId);
    if (!ctx) return;
    if (!RESEND_API_KEY) {
      return res.status(503).json({ error: 'Email sending is not configured. Set RESEND_API_KEY on the server.' });
    }
    const parsed = emailSendSchema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ error: 'Validation failed', issues: parsed.error.flatten() });
    const { to, subject, text, html, attachment_file_ids: attachIds, inline_attachments: inlineAtt } = parsed.data;
    if (!text && !html) return res.status(400).json({ error: 'Email body required (text or html).' });
    const toArr = Array.isArray(to) ? to : [to];
    const payload = { from: RESEND_FROM_EMAIL, to: toArr, subject };
    if (text) payload.text = text;
    if (html) payload.html = html;
    const replyTo = replyToAddressForProject(projectId);
    if (replyTo) payload.reply_to = [replyTo];
    let attachmentMeta = [];
    const resendAttachments = [];
    let bytesUsed = 0;
    if (attachIds && attachIds.length > 0) {
      try {
        const out = await projectFilesToResendAttachments(projectId.trim(), attachIds);
        attachmentMeta = out.meta;
        bytesUsed = out.totalBytes || 0;
        resendAttachments.push(...out.attachments);
      } catch (e) {
        return res.status(400).json({ error: e.message || 'Failed to load attachments' });
      }
    }
    if (inlineAtt && inlineAtt.length > 0) {
      try {
        bytesUsed = appendInlineAttachmentsForResend(inlineAtt, resendAttachments, attachmentMeta, bytesUsed);
      } catch (e) {
        return res.status(400).json({ error: e.message || 'Invalid attachments' });
      }
    }
    if (resendAttachments.length) payload.attachments = resendAttachments;
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      const msg = data.message || data.error || (typeof data === 'string' ? data : 'Resend error');
      return res.status(r.status >= 500 ? 502 : 400).json({ error: typeof msg === 'string' ? msg : 'Resend error', details: data });
    }
    const resendId = data.id || null;
    const { data: row, error: insErr } = await supabase.from('project_emails').insert({
      project_id: projectId,
      direction: 'sent',
      from_email: RESEND_FROM_EMAIL,
      to_emails: toArr,
      subject,
      body_text: text || null,
      body_html: html || null,
      resend_email_id: resendId,
      sent_by_user_id: ctx.user.id,
      sent_by_username: ctx.user.username || null,
      attachments: attachmentMeta.length ? attachmentMeta : []
    }).select().single();
    if (insErr) {
      if (!String(insErr.message || '').includes('does not exist') && !String(insErr.message || '').includes('relation')) {
        console.error('project_emails insert failed:', insErr);
      }
    }
    auditLog(projectId, ctx.user.id, ctx.user.username, 'create', 'email_send', resendId, { to: toArr, subject }, req.requestId);
    res.json({ success: true, id: resendId, email: row || null });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- Tasks ----------
app.get('/api/projects/:projectId/tasks', async (req, res) => {
  try {
    const ctx = await requireProjectMember(req, res, req.params.projectId);
    if (!ctx) return;
    const { limit, offset } = parsePagination(req);
    const { count } = await supabase.from('tasks').select('*', { count: 'exact', head: true }).eq('project_id', req.params.projectId);
    const { data, error } = await supabase.from('tasks').select('*').eq('project_id', req.params.projectId).order('created_at', { ascending: false }).range(offset, offset + limit - 1);
    if (error) throw error;
    res.json({ tasks: data || [], limit, offset, total: count ?? 0 });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/projects/:projectId/tasks', async (req, res) => {
  try {
    const ctx = await requireProjectMember(req, res, req.params.projectId);
    if (!ctx) return;
    const parsed = taskCreateSchema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ error: 'Validation failed', issues: parsed.error.flatten() });
    const { title, status, priority, due_date } = parsed.data;
    const validStatus = (status && ALLOWED_TASK_STATUSES.includes(status)) ? status : 'todo';
    const { data, error } = await supabase.from('tasks').insert({
      project_id: req.params.projectId,
      title: title.trim(),
      status: validStatus,
      priority: priority || 'medium',
      due_date: due_date || null
    }).select().single();
    if (error) throw error;
    auditLog(req.params.projectId, ctx.user.id, ctx.user.username, 'create', 'task', data.id, { title: data.title }, req.requestId);
    res.status(201).json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.patch('/api/projects/:projectId/tasks/:taskId', async (req, res) => {
  try {
    const ctx = await requireProjectMember(req, res, req.params.projectId);
    if (!ctx) return;
    const parsed = taskPatchSchema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ error: 'Validation failed', issues: parsed.error.flatten() });
    const { status, title, priority, due_date } = parsed.data || {};
    let current = null;
    if (status !== undefined) {
      const { data: cur } = await supabase.from('tasks').select('status').eq('id', req.params.taskId).eq('project_id', req.params.projectId).single();
      current = cur;
      if (current && !isAllowedTaskStatusTransition(current.status, status)) {
        return res.status(409).json({ error: `Invalid status transition: ${current.status} → ${status}`, invalid_transition: true, from: current.status, to: status });
      }
    }
    const updates = {};
    if (title !== undefined) updates.title = title.trim();
    if (status !== undefined) updates.status = status;
    if (priority !== undefined) updates.priority = priority;
    if (due_date !== undefined) updates.due_date = due_date || null;
    const { data, error } = await supabase.from('tasks').update(updates).eq('id', req.params.taskId).eq('project_id', req.params.projectId).select().single();
    if (error) throw error;
    const details = status !== undefined ? { before: { status: current?.status }, after: { status: data.status } } : {};
    auditLog(req.params.projectId, ctx.user.id, ctx.user.username, 'update', 'task', data.id, Object.keys(details).length ? details : { title: data.title }, req.requestId);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/projects/:projectId/tasks/:taskId', async (req, res) => {
  try {
    const ctx = await requireProjectMember(req, res, req.params.projectId);
    if (!ctx) return;
    const { error } = await supabase.from('tasks').delete().eq('id', req.params.taskId).eq('project_id', req.params.projectId);
    if (error) throw error;
    auditLog(req.params.projectId, ctx.user.id, ctx.user.username, 'delete', 'task', req.params.taskId, null, req.requestId);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/projects/:projectId/audit', async (req, res) => {
  try {
    const ctx = await requireProjectMember(req, res, req.params.projectId);
    if (!ctx) return;
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 10));
    const { data, error } = await supabase.from('audit_log').select('*').eq('project_id', req.params.projectId).order('created_at', { ascending: false }).range(0, limit - 1);
    if (error) throw error;
    res.json({ audit: data || [] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- Milestones ----------
app.get('/api/projects/:projectId/milestones', async (req, res) => {
  try {
    const ctx = await requireProjectMember(req, res, req.params.projectId);
    if (!ctx) return;
    const { limit, offset } = parsePagination(req);
    const { data, error } = await supabase.from('milestones').select('*').eq('project_id', req.params.projectId).order('due_date', { ascending: true }).range(offset, offset + limit - 1);
    if (error) throw error;
    res.json({ milestones: data || [], limit, offset });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/projects/:projectId/milestones', async (req, res) => {
  try {
    const ctx = await requireProjectMember(req, res, req.params.projectId);
    if (!ctx) return;
    const { title, due_date, description } = req.body || {};
    if (!title || !title.trim()) return res.status(400).json({ error: 'title is required' });
    const { data, error } = await supabase.from('milestones').insert({
      project_id: req.params.projectId,
      title: title.trim(),
      due_date: due_date || null,
      description: (description || '').trim() || null,
      completed_at: null
    }).select().single();
    if (error) throw error;
    auditLog(req.params.projectId, ctx.user.id, ctx.user.username, 'create', 'milestone', data.id, { title: data.title }, req.requestId);
    res.status(201).json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.patch('/api/projects/:projectId/milestones/:milestoneId', async (req, res) => {
  try {
    const ctx = await requireProjectMember(req, res, req.params.projectId);
    if (!ctx) return;
    const { title, due_date, description, completed_at } = req.body || {};
    const updates = {};
    if (title !== undefined) updates.title = title.trim();
    if (due_date !== undefined) updates.due_date = due_date || null;
    if (description !== undefined) updates.description = description.trim() || null;
    if (completed_at !== undefined) updates.completed_at = completed_at || null;
    const { data, error } = await supabase.from('milestones').update(updates).eq('id', req.params.milestoneId).eq('project_id', req.params.projectId).select().single();
    if (error) throw error;
    auditLog(req.params.projectId, ctx.user.id, ctx.user.username, 'update', 'milestone', data.id, null, req.requestId);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/projects/:projectId/milestones/:milestoneId', async (req, res) => {
  try {
    const ctx = await requireProjectMember(req, res, req.params.projectId);
    if (!ctx) return;
    const { error } = await supabase.from('milestones').delete().eq('id', req.params.milestoneId).eq('project_id', req.params.projectId);
    if (error) throw error;
    auditLog(req.params.projectId, ctx.user.id, ctx.user.username, 'delete', 'milestone', req.params.milestoneId, null, req.requestId);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- Documents ----------
app.get('/api/projects/:projectId/documents', async (req, res) => {
  try {
    const ctx = await requireProjectMember(req, res, req.params.projectId);
    if (!ctx) return;
    const { limit, offset } = parsePagination(req);
    const { data, error } = await supabase.from('documents').select('*').eq('project_id', req.params.projectId).order('updated_at', { ascending: false }).range(offset, offset + limit - 1);
    if (error) throw error;
    res.json({ documents: data || [], limit, offset });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/projects/:projectId/documents', async (req, res) => {
  try {
    const ctx = await requireProjectMember(req, res, req.params.projectId);
    if (!ctx) return;
    const { title, content } = req.body || {};
    if (!title || !title.trim()) return res.status(400).json({ error: 'title is required' });
    const { data, error } = await supabase.from('documents').insert({
      project_id: req.params.projectId,
      title: title.trim(),
      content: (content || '').trim() || null
    }).select().single();
    if (error) throw error;
    auditLog(req.params.projectId, ctx.user.id, ctx.user.username, 'create', 'document', data.id, { title: data.title }, req.requestId);
    res.status(201).json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.patch('/api/projects/:projectId/documents/:docId', async (req, res) => {
  try {
    const ctx = await requireProjectMember(req, res, req.params.projectId);
    if (!ctx) return;
    const { title, content } = req.body || {};
    const updates = { updated_at: new Date().toISOString() };
    if (title !== undefined) updates.title = title.trim();
    if (content !== undefined) updates.content = content.trim() || null;
    const { data, error } = await supabase.from('documents').update(updates).eq('id', req.params.docId).eq('project_id', req.params.projectId).select().single();
    if (error) throw error;
    auditLog(req.params.projectId, ctx.user.id, ctx.user.username, 'update', 'document', data.id, null, req.requestId);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/projects/:projectId/documents/:docId', async (req, res) => {
  try {
    const ctx = await requireProjectMember(req, res, req.params.projectId);
    if (!ctx) return;
    const { error } = await supabase.from('documents').delete().eq('id', req.params.docId).eq('project_id', req.params.projectId);
    if (error) throw error;
    auditLog(req.params.projectId, ctx.user.id, ctx.user.username, 'delete', 'document', req.params.docId, null, req.requestId);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- Notes ----------
app.get('/api/projects/:projectId/notes', async (req, res) => {
  try {
    const ctx = await requireProjectMember(req, res, req.params.projectId);
    if (!ctx) return;
    const { limit, offset } = parsePagination(req);
    const { data, error } = await supabase.from('notes').select('*').eq('project_id', req.params.projectId).order('updated_at', { ascending: false }).range(offset, offset + limit - 1);
    if (error) throw error;
    res.json({ notes: data || [], limit, offset });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/projects/:projectId/notes', async (req, res) => {
  try {
    const ctx = await requireProjectMember(req, res, req.params.projectId);
    if (!ctx) return;
    const { title, body } = req.body || {};
    const { data, error } = await supabase.from('notes').insert({
      project_id: req.params.projectId,
      title: (title || 'Untitled').trim(),
      body: (body || '').trim() || null
    }).select().single();
    if (error) throw error;
    auditLog(req.params.projectId, ctx.user.id, ctx.user.username, 'create', 'note', data.id, null, req.requestId);
    res.status(201).json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.patch('/api/projects/:projectId/notes/:noteId', async (req, res) => {
  try {
    const ctx = await requireProjectMember(req, res, req.params.projectId);
    if (!ctx) return;
    const { title, body } = req.body || {};
    const updates = { updated_at: new Date().toISOString() };
    if (title !== undefined) updates.title = title.trim();
    if (body !== undefined) updates.body = body.trim() || null;
    const { data, error } = await supabase.from('notes').update(updates).eq('id', req.params.noteId).eq('project_id', req.params.projectId).select().single();
    if (error) throw error;
    auditLog(req.params.projectId, ctx.user.id, ctx.user.username, 'update', 'note', data.id, null, req.requestId);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/projects/:projectId/notes/:noteId', async (req, res) => {
  try {
    const ctx = await requireProjectMember(req, res, req.params.projectId);
    if (!ctx) return;
    const { error } = await supabase.from('notes').delete().eq('id', req.params.noteId).eq('project_id', req.params.projectId);
    if (error) throw error;
    auditLog(req.params.projectId, ctx.user.id, ctx.user.username, 'delete', 'note', req.params.noteId, null, req.requestId);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- Auth (proxy to Matriya – same users table) ----------
async function upsertUserCache(userId, username) {
  if (userId == null || !username) return;
  try {
    await supabase.from('user_cache').upsert(
      { user_id: userId, username: String(username).trim(), updated_at: new Date().toISOString() },
      { onConflict: 'user_id' }
    );
  } catch (e) {
    console.warn('user_cache upsert failed:', e.message);
  }
}

function forwardAuth(method, path, req, res) {
  if (!MATRIYA_BACK_URL) return res.status(503).json({ error: 'MATRIYA_BACK_URL not set' });
  const url = `${MATRIYA_BACK_URL}/auth${path}`;
  const headers = { 'Content-Type': 'application/json' };
  if (req.headers.authorization) headers.Authorization = req.headers.authorization;
  const opts = { method, url, headers, timeout: 30000 };
  if ((method === 'POST' || method === 'PUT') && req.body) opts.data = req.body;
  axios(opts)
    .then(async r => {
      const data = r.data;
      if (r.status === 200 && data && data.user && data.user.id != null && data.user.username) {
        await upsertUserCache(data.user.id, data.user.username);
      }
      res.status(r.status).json(data);
    })
    .catch(e => {
      const code = e.code || '';
      const statusFromMatriya = e.response?.status;
      const bodyFromMatriya = e.response?.data;
      console.error(`Auth forward ${method} ${path} →`, code || statusFromMatriya, bodyFromMatriya || e.message);
      const errString = (b) => (typeof b === 'object' && b !== null && typeof b.error === 'string' ? b.error : (b?.message || b?.detail || e.message || 'Auth request failed'));
      if (statusFromMatriya != null) {
        return res.status(statusFromMatriya).json({ error: errString(bodyFromMatriya) });
      }
      if (code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'ETIMEDOUT') {
        return res.status(503).json({ error: 'Cannot reach Matriya. Is it running? Check MATRIYA_BACK_URL in .env.' });
      }
      res.status(500).json({ error: errString(bodyFromMatriya) });
    });
}

app.post('/api/auth/login', limiterLoginMw, (req, res) => forwardAuth('POST', '/login', req, res));
app.post('/api/auth/signup', limiterLoginMw, (req, res) => forwardAuth('POST', '/signup', req, res));
app.get('/api/auth/me', (req, res) => {
  if (!MATRIYA_BACK_URL) return res.status(503).json({ error: 'MATRIYA_BACK_URL not set' });
  const url = `${MATRIYA_BACK_URL}/auth/me`;
  const headers = { 'Content-Type': 'application/json' };
  if (req.headers.authorization) headers.Authorization = req.headers.authorization;
  axios({ method: 'GET', url, headers, timeout: 30000 })
    .then(async r => {
      const data = r.data;
      if (r.status === 200 && data && data.id != null && data.username) {
        await upsertUserCache(data.id, data.username);
      }
      res.status(r.status).json(data);
    })
    .catch(e => {
      const upstreamStatus = e.response?.status;
      const upstreamData = e.response?.data;
      const message = (typeof upstreamData === 'object' && upstreamData?.error) ? upstreamData.error : (e.message || 'Auth service error');
      if (upstreamStatus >= 500 || !upstreamStatus) {
        console.error('GET /api/auth/me → Matriya error:', upstreamStatus || e.code || e.message, upstreamData || e.message);
        return res.status(503).json({ error: 'Auth service unavailable. Check that Matriya backend is running and its database is configured (POSTGRES_URL).', detail: message });
      }
      res.status(upstreamStatus || 401).json(typeof upstreamData === 'object' ? upstreamData : { error: message });
    });
});

// ---------- Current user (for permissions) ----------
async function getCurrentUser(req) {
  if (!req.headers.authorization || !MATRIYA_BACK_URL) return null;
  try {
    const r = await axios.get(`${MATRIYA_BACK_URL}/auth/me`, {
      headers: { Authorization: req.headers.authorization },
      timeout: 30000
    });
    if (r.data && r.data.id != null) return r.data;
  } catch (e) {
    if (process.env.NODE_ENV !== 'production') {
      const code = e.code || e.response?.status || e.message;
      console.warn('getCurrentUser failed:', code, '| URL:', `${MATRIYA_BACK_URL}/auth/me`, '| Is Matriya back running? Check MATRIYA_BACK_URL in .env');
    }
  }
  return null;
}

async function getProjectAccess(projectId, userId, username = null) {
  if (!userId) return { canAccess: false, role: null, hasPendingRequest: false };
  if (String(username || '').trim().toLowerCase() === 'admin') return { canAccess: true, role: 'owner', hasPendingRequest: false };
  const { data: members } = await supabase.from('project_members').select('role').eq('project_id', projectId).eq('user_id', userId).maybeSingle();
  if (members) return { canAccess: true, role: members.role, hasPendingRequest: false };
  const { data: pending } = await supabase.from('project_join_requests').select('id').eq('project_id', projectId).eq('user_id', userId).eq('status', 'pending').maybeSingle();
  return { canAccess: false, role: null, hasPendingRequest: !!pending };
}

function projectHasMembers(projectId) {
  return supabase.from('project_members').select('id', { count: 'exact', head: true }).eq('project_id', projectId).then(r => (r.count || 0) > 0);
}

// ---------- RBAC: require project member (returns access or sends 403) ----------
async function requireProjectMember(req, res, projectId) {
  if (!MATRIYA_BACK_URL) {
    res.status(503).json({ error: 'Auth not configured. Set MATRIYA_BACK_URL in the backend environment (e.g. Vercel).' });
    return null;
  }
  const user = await getCurrentUser(req);
  if (!user) {
    res.status(401).json({ error: 'Authentication required' });
    return null;
  }
  const hasMembers = await projectHasMembers(projectId);
  const access = hasMembers ? await getProjectAccess(projectId, user.id, user.username) : { canAccess: !!user, role: user ? 'owner' : null };
  if (!access.canAccess) {
    res.status(403).json({ error: 'Not a project member' });
    return null;
  }
  return { user, access };
}

// ---------- Audit log (actor, entity, action, before/after, request_id) ----------
function auditLog(projectId, userId, username, action, entityType, entityId = null, details = null, requestId = null) {
  supabase.from('audit_log').insert({
    project_id: projectId || null,
    user_id: userId ?? null,
    username: username || null,
    action,
    entity_type: entityType,
    entity_id: entityId ? String(entityId) : null,
    details: details && typeof details === 'object' ? details : null,
    request_id: requestId || null
  }).then(() => {}).catch(() => {});
}

// ---------- Task status state machine (allowed transitions) ----------
// Only three statuses in UI: todo (לביצוע), in_progress (בביצוע), done (הושלם). in_review (בדיקה) removed.
const TASK_STATUS_TRANSITIONS = {
  todo: ['in_progress', 'cancelled'],
  in_progress: ['todo', 'done', 'cancelled'],
  done: [],
  cancelled: [],
  in_review: ['todo', 'in_progress', 'done', 'cancelled'] // legacy: allow moving existing in_review tasks
};
const ALLOWED_TASK_STATUSES = ['todo', 'in_progress', 'done'];
function isAllowedTaskStatusTransition(fromStatus, toStatus) {
  if (!ALLOWED_TASK_STATUSES.includes(toStatus)) return false;
  const allowed = TASK_STATUS_TRANSITIONS[fromStatus];
  return Array.isArray(allowed) && allowed.includes(toStatus);
}

// ---------- Validation (Zod) for critical payloads ----------
const RUN_STATUSES = ['draft', 'running', 'completed', 'failed'];
const RUN_FEATURES_CORE = ['research', 'analysis', 'export', 'report', 'doe', 'integrity'];
const RUN_FEATURES_EXTENDED = ['tagged', 'reviewed', 'archived', 'priority'];

const runCreateSchema = z.object({
  features_core: z.array(z.string()).optional().default([]),
  features_extended: z.array(z.string()).optional().default([]),
  status: z.string().optional().default('draft')
});
const runPatchSchema = z.object({
  status: z.string().optional(),
  features_core: z.array(z.string()).optional(),
  features_extended: z.array(z.string()).optional(),
  rule_id: z.string().nullable().optional()
});
const taskCreateSchema = z.object({
  title: z.string().min(1).max(500),
  status: z.string().optional().default('todo'),
  priority: z.string().optional().default('medium'),
  due_date: z.union([z.string(), z.null()]).optional()
});
const taskPatchSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  status: z.string().optional(),
  priority: z.string().optional(),
  due_date: z.union([z.string(), z.null()]).optional()
});

function validateRunFeatures(core = [], extended = []) {
  const coreArr = Array.isArray(core) ? core : [];
  const extArr = Array.isArray(extended) ? extended : [];
  const invalidCore = coreArr.filter(t => !RUN_FEATURES_CORE.includes(t));
  const invalidExt = extArr.filter(t => !RUN_FEATURES_EXTENDED.includes(t));
  if (invalidCore.length || invalidExt.length) {
    return { ok: false, error: `Invalid features: core [${invalidCore.join(', ')}], extended [${invalidExt.join(', ')}]. Allowed core: ${RUN_FEATURES_CORE.join(', ')}; extended: ${RUN_FEATURES_EXTENDED.join(', ')}.` };
  }
  return { ok: true, core: coreArr, extended: extArr };
}

function appendRunTrace(runId, fromState, toState, ruleId = null) {
  supabase.from('run_fsm_trace').insert({
    run_id: runId,
    from_state: fromState,
    to_state: toState,
    rule_id: ruleId || null
  }).then(() => {}).catch(() => {});
}

// ---------- Runs (per project): feature tagging + FSM trace ----------
app.get('/api/projects/:projectId/runs', async (req, res) => {
  try {
    const ctx = await requireProjectMember(req, res, req.params.projectId);
    if (!ctx) return;
    const projectId = req.params.projectId;
    let q = supabase.from('runs').select('*').eq('project_id', projectId);
    const featuresParam = req.query.features;
    if (featuresParam && typeof featuresParam === 'string') {
      const tags = featuresParam.split(',').map(s => s.trim()).filter(Boolean);
      if (tags.length) {
        const orClauses = tags.flatMap(t => [`features_core.cs.{"${t}"}`, `features_extended.cs.{"${t}"}`]);
        q = q.or(orClauses.join(','));
      }
    }
    const { limit, offset } = parsePagination(req);
    const { data, error } = await q.order('created_at', { ascending: false }).range(offset, offset + limit - 1);
    if (error) {
      if (String(error.message || '').includes('relation') || String(error.message || '').includes('does not exist')) {
        return res.json({ runs: [], limit, offset });
      }
      throw error;
    }
    res.json({ runs: data || [], limit, offset });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/projects/:projectId/runs', async (req, res) => {
  try {
    const ctx = await requireProjectMember(req, res, req.params.projectId);
    if (!ctx) return;
    const projectId = req.params.projectId;
    const parsed = runCreateSchema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ error: 'Validation failed', issues: parsed.error.flatten() });
    const { status: rawStatus, features_core: fc, features_extended: fe } = parsed.data;
    const validStatus = rawStatus && RUN_STATUSES.includes(rawStatus) ? rawStatus : 'draft';
    const validation = validateRunFeatures(fc, fe);
    if (!validation.ok) return res.status(400).json({ error: validation.error });
    const { data, error } = await supabase.from('runs').insert({
      project_id: projectId,
      status: validStatus,
      features_core: validation.core,
      features_extended: validation.extended
    }).select().single();
    if (error) throw error;
    appendRunTrace(data.id, null, data.status, null);
    auditLog(projectId, ctx.user.id, ctx.user.username, 'create', 'run', data.id, null, req.requestId);
    res.status(201).json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/projects/:projectId/runs/:runId', async (req, res) => {
  try {
    const ctx = await requireProjectMember(req, res, req.params.projectId);
    if (!ctx) return;
    const { data, error } = await supabase.from('runs').select('*').eq('id', req.params.runId).eq('project_id', req.params.projectId).single();
    if (error || !data) return res.status(404).json({ error: 'Run not found' });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.patch('/api/projects/:projectId/runs/:runId', async (req, res) => {
  try {
    const ctx = await requireProjectMember(req, res, req.params.projectId);
    if (!ctx) return;
    const projectId = req.params.projectId;
    const runId = req.params.runId;
    const parsed = runPatchSchema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ error: 'Validation failed', issues: parsed.error.flatten() });
    const { status, features_core: fc, features_extended: fe, rule_id: ruleId } = parsed.data || {};
    const { data: current, error: fetchErr } = await supabase.from('runs').select('*').eq('id', runId).eq('project_id', projectId).single();
    if (fetchErr || !current) return res.status(404).json({ error: 'Run not found' });
    const updates = { updated_at: new Date().toISOString() };
    if (status !== undefined) {
      if (!RUN_STATUSES.includes(status)) return res.status(400).json({ error: `Invalid status. Allowed: ${RUN_STATUSES.join(', ')}` });
      updates.status = status;
    }
    if (fc !== undefined || fe !== undefined) {
      const validation = validateRunFeatures(fc !== undefined ? fc : current.features_core, fe !== undefined ? fe : current.features_extended);
      if (!validation.ok) return res.status(400).json({ error: validation.error });
      if (fc !== undefined) updates.features_core = validation.core;
      if (fe !== undefined) updates.features_extended = validation.extended;
    }
    const { data, error } = await supabase.from('runs').update(updates).eq('id', runId).eq('project_id', projectId).select().single();
    if (error) throw error;
    if (updates.status !== undefined) appendRunTrace(runId, current.status, data.status, ruleId || null);
    auditLog(projectId, ctx.user.id, ctx.user.username, 'update', 'run', data.id, null, req.requestId);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/projects/:projectId/runs/:runId/trace', async (req, res) => {
  try {
    const ctx = await requireProjectMember(req, res, req.params.projectId);
    if (!ctx) return;
    const { data: run } = await supabase.from('runs').select('id').eq('id', req.params.runId).eq('project_id', req.params.projectId).single();
    if (!run) return res.status(404).json({ error: 'Run not found' });
    const { data, error } = await supabase.from('run_fsm_trace').select('id, from_state, to_state, rule_id, created_at').eq('run_id', req.params.runId).order('created_at', { ascending: true });
    if (error) throw error;
    res.json({ trace: data || [] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- Central materials & technology domains (reference for analysis) ----------
const SUGGESTED_TECHNOLOGY_DOMAINS = ['acrylic_coating', 'mineral_coating', 'intumescent', 'concrete_inhibitor', 'concrete_repair', 'sealer', 'stone_consolidator'];

async function requireAuth(req, res) {
  if (!MATRIYA_BACK_URL) {
    res.status(503).json({ error: 'Auth not configured' });
    return null;
  }
  const user = await getCurrentUser(req);
  if (!user) {
    res.status(401).json({ error: 'Authentication required' });
    return null;
  }
  return user;
}

app.get('/api/materials', async (req, res) => {
  try {
    const user = await requireAuth(req, res);
    if (!user) return;
    const { data, error } = await supabase.from('materials').select('*').order('material_name');
    if (error) {
      if (String(error.message || '').includes('does not exist') || String(error.message || '').includes('relation')) {
        return res.json({ materials: [] });
      }
      throw error;
    }
    res.json({ materials: data || [] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/materials', async (req, res) => {
  try {
    const user = await requireAuth(req, res);
    if (!user) return;
    const { material_id, material_name, aliases, material_family, material_role, technology_domain } = req.body || {};
    const idStr = material_id != null ? String(material_id).trim() : null;
    const nameStr = material_name != null ? String(material_name).trim() : null;
    if (!idStr || !nameStr) return res.status(400).json({ error: 'material_id and material_name are required' });
    const row = {
      material_id: idStr,
      material_name: nameStr,
      aliases: Array.isArray(aliases) ? aliases : (aliases != null ? [String(aliases)] : []),
      material_family: material_family != null ? String(material_family).trim() || null : null,
      material_role: material_role != null ? String(material_role).trim() || null : null,
      technology_domain: technology_domain != null ? String(technology_domain).trim() || null : null
    };
    const { data, error } = await supabase.from('materials').upsert(row, { onConflict: 'material_id' }).select().single();
    if (error) throw error;
    res.status(201).json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- Import & lab data (management only) ----------
const EXPERIMENT_OUTCOMES = ['success', 'failure', 'partial', 'production_formula'];

function validateExperimentForSync(exp) {
  const err = [];
  if (exp.technology_domain == null || String(exp.technology_domain).trim() === '') err.push('technology_domain required');
  if (exp.experiment_outcome == null || !EXPERIMENT_OUTCOMES.includes(exp.experiment_outcome)) err.push('experiment_outcome must be one of: ' + EXPERIMENT_OUTCOMES.join(', '));
  if (exp.is_production_formula == null) err.push('is_production_formula required');
  if (exp.materials == null) err.push('materials required (use [] if none)');
  if (exp.percentages == null) err.push('percentages required (use {} if none)');
  return err;
}

app.get('/api/projects/:projectId/import/log', async (req, res) => {
  try {
    const ctx = await requireProjectMember(req, res, req.params.projectId);
    if (!ctx) return;
    const { limit, offset } = parsePagination(req);
    const { data, error } = await supabase.from('import_log').select('*').eq('project_id', req.params.projectId).order('created_at', { ascending: false }).range(offset, offset + limit - 1);
    if (error) throw error;
    res.json({ entries: data || [], limit, offset });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/projects/:projectId/import/sharepoint-file', async (req, res) => {
  try {
    const ctx = await requireProjectMember(req, res, req.params.projectId);
    if (!ctx) return;
    const projectId = req.params.projectId;
    const body = req.body || {};
    const source_file_reference = body.source_file_reference != null ? String(body.source_file_reference).trim() : null;
    const experiments = Array.isArray(body.experiments) ? body.experiments : [];
    if (!source_file_reference) return res.status(400).json({ error: 'source_file_reference is required' });
    let created = 0, updated = 0, errCount = 0;
    const details = { errors: [] };
    for (const exp of experiments) {
      const eid = exp.experiment_id != null ? String(exp.experiment_id) : null;
      if (!eid) { errCount++; details.errors.push({ item: exp, reason: 'experiment_id required' }); continue; }
      const payload = {
        project_id: projectId,
        experiment_id: eid,
        experiment_version: exp.experiment_version != null ? parseInt(exp.experiment_version, 10) : 1,
        technology_domain: exp.technology_domain != null ? String(exp.technology_domain) : '',
        formula: exp.formula != null ? String(exp.formula) : null,
        materials: exp.materials != null ? exp.materials : [],
        percentages: exp.percentages != null ? exp.percentages : {},
        results: exp.results != null ? (typeof exp.results === 'string' ? exp.results : JSON.stringify(exp.results)) : null,
        experiment_outcome: exp.experiment_outcome && EXPERIMENT_OUTCOMES.includes(exp.experiment_outcome) ? exp.experiment_outcome : 'success',
        is_production_formula: !!exp.is_production_formula,
        source_file_reference,
        research_session_id: exp.research_session_id || null,
        updated_at: new Date().toISOString()
      };
      const { data: existing } = await supabase.from('lab_experiments').select('id, experiment_version').eq('project_id', projectId).eq('experiment_id', eid).single();
      if (existing) {
        payload.experiment_version = Math.max((payload.experiment_version || 1), (existing.experiment_version || 0) + 1);
        const { error: upErr } = await supabase.from('lab_experiments').update(payload).eq('project_id', projectId).eq('experiment_id', eid);
        if (upErr) { errCount++; details.errors.push({ experiment_id: eid, reason: upErr.message }); continue; }
        updated++;
      } else {
        const { error: insErr } = await supabase.from('lab_experiments').insert(payload);
        if (insErr) { errCount++; details.errors.push({ experiment_id: eid, reason: insErr.message }); continue; }
        created++;
      }
    }
    const { error: logErr } = await supabase.from('import_log').insert({
      project_id: projectId,
      source_file_reference,
      source_type: 'sharepoint_file',
      created_count: created,
      updated_count: updated,
      error_count: errCount,
      details: details.errors.length ? details : null
    });
    if (logErr) console.warn('import_log insert failed:', logErr.message);
    res.status(201).json({ created, updated, error_count: errCount, source_file_reference, details: errCount ? details : undefined });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/projects/:projectId/import/experiment-excel', limiterUpload, upload.single('file'), async (req, res) => {
  try {
    const ctx = await requireProjectMember(req, res, req.params.projectId);
    if (!ctx) return;
    const projectId = req.params.projectId;
    if (!req.file || !req.file.buffer) return res.status(400).json({ error: 'No file uploaded. Send multipart form with field "file".' });
    const wb = XLSX.read(req.file.buffer, { type: 'buffer', cellDates: true });
    const sheetNames = wb.SheetNames || [];
    if (!sheetNames.length) return res.status(400).json({ error: 'Excel file has no sheets' });
    // Support multi-sheet Excel: collect rows from every sheet (with sheet + row for error reporting)
    const rowsWithMeta = [];
    for (const sheetName of sheetNames) {
      const ws = wb.Sheets[sheetName];
      if (!ws) continue;
      const sheetRows = XLSX.utils.sheet_to_json(ws, { defval: '', raw: false });
      for (let r = 0; r < sheetRows.length; r++) {
        rowsWithMeta.push({ row: sheetRows[r], sheet: sheetName, rowIndex: r + 2 });
      }
    }
    if (!rowsWithMeta.length) return res.status(201).json({ created: 0, updated: 0, error_count: 0, source_file_reference: req.file.originalname || 'excel' });

    const col = (obj, ...keys) => {
      for (const k of keys) {
        const v = obj[k];
        if (v !== undefined && v !== null && String(v).trim() !== '') return v;
        const lower = k.toLowerCase();
        for (const key of Object.keys(obj)) {
          if (key.toLowerCase() === lower) return obj[key];
        }
      }
      return null;
    };

    const source_file_reference = req.file.originalname || 'experiment-excel';
    let created = 0, updated = 0, errCount = 0;
    const details = { errors: [] };

    for (let i = 0; i < rowsWithMeta.length; i++) {
      const { row, sheet, rowIndex } = rowsWithMeta[i];
      const eid = col(row, 'experiment_id', 'experiment id', 'id');
      if (!eid) { errCount++; details.errors.push({ sheet, row: rowIndex, reason: 'experiment_id required' }); continue; }
      let materials = col(row, 'materials', 'material');
      let percentages = col(row, 'percentages', 'percentage');
      if (typeof materials === 'string') {
        try { materials = JSON.parse(materials); } catch (_) { materials = materials.split(/[,;]/).map(s => s.trim()).filter(Boolean); }
      }
      if (!Array.isArray(materials) && typeof materials !== 'object') materials = [];
      if (typeof percentages === 'string') {
        try { percentages = JSON.parse(percentages); } catch (_) { percentages = {}; }
      }
      if (typeof percentages !== 'object' || percentages === null) percentages = {};
      const outcomeRaw = (col(row, 'experiment_outcome', 'outcome', 'result') || 'success').toString().toLowerCase();
      const experiment_outcome = EXPERIMENT_OUTCOMES.includes(outcomeRaw) ? outcomeRaw : (outcomeRaw.includes('fail') ? 'failure' : outcomeRaw.includes('part') ? 'partial' : 'success');

      const payload = {
        project_id: projectId,
        experiment_id: String(eid),
        experiment_version: 1,
        technology_domain: (col(row, 'technology_domain', 'domain', 'technology domain') || 'unknown').toString().trim(),
        formula: col(row, 'formula', 'formulation') != null ? String(col(row, 'formula', 'formulation')).trim() : null,
        materials,
        percentages,
        results: col(row, 'results', 'result') != null ? String(col(row, 'results', 'result')).trim() : null,
        experiment_outcome,
        is_production_formula: /true|1|yes|כן/.test(String(col(row, 'is_production_formula', 'production') || '')),
        source_file_reference,
        updated_at: new Date().toISOString()
      };

      const { data: existing } = await supabase.from('lab_experiments').select('id, experiment_version').eq('project_id', projectId).eq('experiment_id', payload.experiment_id).single();
      if (existing) {
        payload.experiment_version = (existing.experiment_version || 0) + 1;
        const { error: upErr } = await supabase.from('lab_experiments').update(payload).eq('project_id', projectId).eq('experiment_id', payload.experiment_id);
        if (upErr) { errCount++; details.errors.push({ sheet, row: rowIndex, experiment_id: payload.experiment_id, reason: upErr.message }); continue; }
        updated++;
      } else {
        const { error: insErr } = await supabase.from('lab_experiments').insert(payload);
        if (insErr) { errCount++; details.errors.push({ sheet, row: rowIndex, experiment_id: payload.experiment_id, reason: insErr.message }); continue; }
        created++;
      }
    }

    const { error: logErr } = await supabase.from('import_log').insert({
      project_id: projectId,
      source_file_reference,
      source_type: 'experiment_excel',
      created_count: created,
      updated_count: updated,
      error_count: errCount,
      details: details.errors.length ? details : null
    });
    if (logErr) console.warn('import_log insert failed:', logErr.message);
    res.status(201).json({ created, updated, error_count: errCount, source_file_reference, details: errCount ? details : undefined });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/projects/:projectId/experiments', async (req, res) => {
  try {
    const ctx = await requireProjectMember(req, res, req.params.projectId);
    if (!ctx) return;
    const { limit, offset } = parsePagination(req);
    const { data, error } = await supabase.from('lab_experiments').select('*').eq('project_id', req.params.projectId).order('updated_at', { ascending: false }).range(offset, offset + limit - 1);
    if (error) throw error;
    res.json({ experiments: data || [], limit, offset });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/projects/:projectId/experiments/sync-to-matriya', async (req, res) => {
  try {
    const ctx = await requireProjectMember(req, res, req.params.projectId);
    if (!ctx) return;
    const projectId = req.params.projectId;
    if (!MATRIYA_BACK_URL) return res.status(503).json({ error: 'MATRIYA_BACK_URL not set' });
    const { data: rows, error } = await supabase.from('lab_experiments').select('*').eq('project_id', projectId);
    if (error) throw error;
    const experiments = (rows || []).map(r => ({
      experiment_id: r.experiment_id,
      technology_domain: r.technology_domain,
      formula: r.formula,
      materials: r.materials,
      percentages: r.percentages,
      results: r.results,
      experiment_outcome: r.experiment_outcome,
      is_production_formula: r.is_production_formula
    }));
    const validationErrors = [];
    for (let i = 0; i < experiments.length; i++) {
      const errs = validateExperimentForSync(experiments[i]);
      if (errs.length) validationErrors.push({ index: i, experiment_id: experiments[i].experiment_id, errors: errs });
    }
    if (validationErrors.length > 0) {
      return res.status(400).json({ error: 'Sync validation failed: required fields missing', validation_errors: validationErrors });
    }
    const r = await axios.post(`${MATRIYA_BACK_URL}/sync/experiments`, { experiments }, { timeout: 30000 });
    res.json(r.data);
  } catch (e) {
    const status = e.response?.status || 500;
    const data = e.response?.data;
    res.status(status).json(data || { error: e.message });
  }
});

app.get('/api/projects/:projectId/research-sessions', async (req, res) => {
  try {
    const ctx = await requireProjectMember(req, res, req.params.projectId);
    if (!ctx) return;
    const { data, error } = await supabase.from('research_sessions').select('*').eq('project_id', req.params.projectId).order('started_at', { ascending: false });
    if (error) throw error;
    res.json({ sessions: data || [] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/projects/:projectId/research-sessions', async (req, res) => {
  try {
    const ctx = await requireProjectMember(req, res, req.params.projectId);
    if (!ctx) return;
    const { name } = req.body || {};
    const { data, error } = await supabase.from('research_sessions').insert({
      project_id: req.params.projectId,
      name: name != null ? String(name).trim() || null : null
    }).select().single();
    if (error) throw error;
    res.status(201).json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/projects/:projectId/material-library', async (req, res) => {
  try {
    const ctx = await requireProjectMember(req, res, req.params.projectId);
    if (!ctx) return;
    const { data, error } = await supabase.from('material_library').select('*').eq('project_id', req.params.projectId).order('name');
    if (error) throw error;
    res.json({ materials: data || [] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/projects/:projectId/material-library', async (req, res) => {
  try {
    const ctx = await requireProjectMember(req, res, req.params.projectId);
    if (!ctx) return;
    const { name, role_or_function } = req.body || {};
    const nameStr = name != null ? String(name).trim() : null;
    if (!nameStr) return res.status(400).json({ error: 'name is required' });
    const { data, error } = await supabase.from('material_library').upsert({
      project_id: req.params.projectId,
      name: nameStr,
      role_or_function: role_or_function != null ? String(role_or_function).trim() || null : null
    }, { onConflict: 'project_id,name' }).select().single();
    if (error) throw error;
    res.status(201).json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- Lab analysis: contradictions, failure patterns, snapshot, formula validate, relations, insights, guard ----------
async function getExperimentsForAnalysis(projectId, options = {}) {
  let q = supabase.from('lab_experiments').select('*').eq('project_id', projectId);
  if (options.researchSessionId) q = q.eq('research_session_id', options.researchSessionId);
  if (options.since) q = q.gte('updated_at', options.since);
  const { data, error } = await q.order('updated_at', { ascending: false });
  if (error) throw error;
  return data || [];
}

function normalizeFormulaForCompare(formula) {
  if (formula == null) return '';
  return String(formula).replace(/\s+/g, ' ').trim().toLowerCase();
}

app.get('/api/projects/:projectId/analysis/contradictions', async (req, res) => {
  try {
    const ctx = await requireProjectMember(req, res, req.params.projectId);
    if (!ctx) return;
    const experiments = await getExperimentsForAnalysis(req.params.projectId);
    const byNormalized = new Map();
    for (const exp of experiments) {
      const key = normalizeFormulaForCompare(exp.formula) || exp.experiment_id;
      if (!byNormalized.has(key)) byNormalized.set(key, []);
      byNormalized.get(key).push(exp);
    }
    const contradictions = [];
    for (const [key, list] of byNormalized) {
      if (list.length < 2) continue;
      const outcomes = [...new Set(list.map(e => e.experiment_outcome))];
      if (outcomes.length > 1) {
        contradictions.push({ formula_key: key, experiments: list.map(e => ({ id: e.id, experiment_id: e.experiment_id, experiment_outcome: e.experiment_outcome, formula: e.formula })), outcomes });
      }
    }
    res.json({ contradictions });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/projects/:projectId/analysis/failure-patterns', async (req, res) => {
  try {
    const ctx = await requireProjectMember(req, res, req.params.projectId);
    if (!ctx) return;
    const experiments = await getExperimentsForAnalysis(req.params.projectId);
    const failures = experiments.filter(e => e.experiment_outcome === 'failure' || e.experiment_outcome === 'partial');
    const byDomain = {};
    const byMaterial = {};
    for (const e of failures) {
      const d = e.technology_domain || 'unknown';
      byDomain[d] = (byDomain[d] || 0) + 1;
      const mats = Array.isArray(e.materials) ? e.materials : (e.materials && typeof e.materials === 'object' ? Object.keys(e.materials) : []);
      mats.forEach(m => { const n = typeof m === 'string' ? m : (m?.name || String(m)); byMaterial[n] = (byMaterial[n] || 0) + 1; });
    }
    const domainEntries = Object.entries(byDomain).sort((a, b) => b[1] - a[1]).slice(0, 20);
    const materialEntries = Object.entries(byMaterial).sort((a, b) => b[1] - a[1]).slice(0, 20);
    res.json({ failure_count: failures.length, by_domain: domainEntries, by_material: materialEntries, sample_failures: failures.slice(0, 10) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/projects/:projectId/analysis/research-snapshot', async (req, res) => {
  try {
    const ctx = await requireProjectMember(req, res, req.params.projectId);
    if (!ctx) return;
    const sessionId = req.query.research_session_id;
    const experiments = await getExperimentsForAnalysis(req.params.projectId, sessionId ? { researchSessionId: sessionId } : {});
    const outcomes = { success: 0, failure: 0, partial: 0, production_formula: 0 };
    experiments.forEach(e => { if (outcomes[e.experiment_outcome] !== undefined) outcomes[e.experiment_outcome]++; });
    const domains = {};
    experiments.forEach(e => { const d = e.technology_domain || 'unknown'; domains[d] = (domains[d] || 0) + 1; });
    res.json({
      total: experiments.length,
      outcomes,
      by_domain: Object.entries(domains).sort((a, b) => b[1] - a[1]),
      snapshot_at: new Date().toISOString(),
      research_session_id: sessionId || null
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/projects/:projectId/analysis/formula-validate', async (req, res) => {
  try {
    const ctx = await requireProjectMember(req, res, req.params.projectId);
    if (!ctx) return;
    const { formula, domain, materials, percentages } = req.body || {};
    const errors = [];
    const warnings = [];
    if (formula != null && String(formula).trim().length === 0) warnings.push('Formula is empty');
    if (percentages && typeof percentages === 'object') {
      const vals = Object.values(percentages).map(v => parseFloat(v));
      const sum = vals.reduce((a, b) => a + b, 0);
      if (vals.length && (isNaN(sum) || Math.abs(sum - 100) > 0.01)) warnings.push(`Percentages sum to ${sum.toFixed(1)}; expected 100`);
    }
    let similar = [];
    if (MATRIYA_BACK_URL && (formula || materials || domain)) {
      try {
        const r = await axios.post(`${MATRIYA_BACK_URL}/analysis/formula`, { domain: domain || '', materials: materials || [], percentages: percentages || {} }, { timeout: 10000 });
        if (r.data?.similar_experiments) similar = r.data.similar_experiments;
        if (Array.isArray(r.data?.warnings)) r.data.warnings.forEach(w => warnings.push(w));
      } catch (_) { /* Matriya optional */ }
    }
    res.json({ valid: errors.length === 0, errors, warnings, similar_experiments: similar });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/projects/:projectId/analysis/relations', async (req, res) => {
  try {
    const ctx = await requireProjectMember(req, res, req.params.projectId);
    if (!ctx) return;
    const experiments = await getExperimentsForAnalysis(req.params.projectId);
    const relations = [];
    for (const exp of experiments) {
      relations.push({ type: 'experiment_formula', experiment_id: exp.experiment_id, formula: exp.formula || null });
      const mats = Array.isArray(exp.materials) ? exp.materials : (exp.materials && typeof exp.materials === 'object' ? Object.keys(exp.materials) : []);
      mats.forEach(m => relations.push({ type: 'experiment_material', experiment_id: exp.experiment_id, material: typeof m === 'string' ? m : (m?.name || String(m)) }));
      if (exp.results) relations.push({ type: 'experiment_result', experiment_id: exp.experiment_id, result_preview: String(exp.results).slice(0, 200) });
    }
    const { data: materials } = await supabase.from('material_library').select('name').eq('project_id', req.params.projectId);
    const materialNames = new Set((materials || []).map(m => m.name));
    res.json({ relations, experiments_count: experiments.length, material_library_count: materialNames.size, material_library: [...materialNames] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/projects/:projectId/analysis/insights', async (req, res) => {
  try {
    const ctx = await requireProjectMember(req, res, req.params.projectId);
    if (!ctx) return;
    const experiments = await getExperimentsForAnalysis(req.params.projectId);
    const total = experiments.length;
    const success = experiments.filter(e => e.experiment_outcome === 'success').length;
    const failure = experiments.filter(e => e.experiment_outcome === 'failure').length;
    const partial = experiments.filter(e => e.experiment_outcome === 'partial').length;
    const production = experiments.filter(e => e.experiment_outcome === 'production_formula' || e.is_production_formula).length;
    const byDomain = {};
    experiments.forEach(e => { const d = e.technology_domain || 'unknown'; byDomain[d] = byDomain[d] || { total: 0, success: 0, failure: 0 }; byDomain[d].total++; if (e.experiment_outcome === 'success') byDomain[d].success++; else if (e.experiment_outcome === 'failure' || e.experiment_outcome === 'partial') byDomain[d].failure++; });
    const domainStats = Object.entries(byDomain).map(([name, s]) => ({ domain: name, ...s, success_rate: s.total ? Math.round((s.success / s.total) * 100) : 0 }));
    domainStats.sort((a, b) => b.total - a.total);
    res.json({
      total_experiments: total,
      success_count: success,
      failure_count: failure,
      partial_count: partial,
      production_formula_count: production,
      success_rate_pct: total ? Math.round((success / total) * 100) : 0,
      by_domain: domainStats.slice(0, 15)
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/projects/:projectId/guard/check', async (req, res) => {
  try {
    const ctx = await requireProjectMember(req, res, req.params.projectId);
    if (!ctx) return;
    const { formula, experiment_id, materials, action } = req.body || {};
    const warnings = [];
    const normalized = normalizeFormulaForCompare(formula);
    if (normalized) {
      const experiments = await getExperimentsForAnalysis(req.params.projectId);
      const sameFormula = experiments.filter(e => normalizeFormulaForCompare(e.formula) === normalized && e.experiment_id !== experiment_id);
      if (sameFormula.length > 0) warnings.push({ code: 'duplicate_formula', message: 'Same or very similar formula already exists in project', count: sameFormula.length, experiment_ids: sameFormula.map(e => e.experiment_id) });
    }
    res.json({ allowed: true, warnings });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- Lab: parse experiment file to text (Excel → readable text for AI) ----------
/**
 * Same parsing as POST /lab/parse-experiment-file; used for email→Lab import to avoid re-upload + extra round trips.
 * @param {Buffer} buffer
 * @param {string} originalName
 * @returns {Promise<{ text: string }>}
 */
async function parseExperimentBufferToText(buffer, originalName) {
  if (!buffer || !Buffer.isBuffer(buffer)) {
    const e = new Error('No file uploaded. Send multipart form with field "file".');
    e.statusCode = 400;
    throw e;
  }
  const name = (originalName || '').toLowerCase();
  if (name.endsWith('.xlsx') || name.endsWith('.xls')) {
    try {
      const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });
      const parts = [];
      for (const sheetName of wb.SheetNames || []) {
        const ws = wb.Sheets[sheetName];
        if (!ws) continue;
        const rows = XLSX.utils.sheet_to_json(ws, { defval: '', raw: false, header: 1 });
        if (rows.length) {
          parts.push(`[גיליון: ${sheetName}]`);
          for (const row of rows) {
            const line = Array.isArray(row) ? row.map(c => String(c ?? '').trim()).join('\t') : Object.entries(row).map(([k, v]) => `${k}: ${v}`).join(', ');
            if (line.replace(/\s/g, '')) parts.push(line);
          }
          parts.push('');
        }
      }
      const text = parts.join('\n').trim() || 'הקובץ ריק או ללא נתונים ניתנים לקריאה.';
      return { text };
    } catch (err) {
      if (err.message && /corrupt|invalid|xlsx|workbook/i.test(err.message)) {
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
      /* Fast path: text-layer PDFs via pdf-parse (ms). Slow path: per-page vision only if text layer is empty/thin. */
      let fromParse = '';
      try {
        const pdfParse = (await import('pdf-parse')).default;
        const data = await pdfParse(buffer);
        fromParse = String(data?.text || '')
          .replace(/\r\n/g, '\n')
          .trim();
      } catch (_) {
        /* Encrypted or unusual PDFs: try vision below when not on Vercel */
      }
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

      if (!OPENAI_API_KEY) {
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
          { headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' }, timeout: 60000 }
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

app.post('/api/projects/:projectId/lab/parse-experiment-file', limiterUpload, upload.single('file'), async (req, res) => {
  try {
    const ctx = await requireProjectMember(req, res, req.params.projectId);
    if (!ctx) return;
    if (!req.file || !req.file.buffer) return res.status(400).json({ error: 'No file uploaded. Send multipart form with field "file".' });
    const { text } = await parseExperimentBufferToText(req.file.buffer, req.file.originalname);
    return res.json({ text });
  } catch (e) {
    if (e.statusCode === 400) return res.status(400).json({ error: e.message });
    if (e.statusCode === 503) return res.status(503).json({ error: e.message });
    if (e.message && /corrupt|invalid|xlsx|workbook/i.test(e.message)) return res.status(400).json({ error: 'קובץ Excel פגום או בפורמט לא נתמך.' });
    res.status(500).json({ error: e.message || 'שגיאה בפענוח הקובץ.' });
  }
});

// ---------- Lab saved experiment contexts (save/load text for AI) ----------
app.get('/api/projects/:projectId/lab/saved-experiments', async (req, res) => {
  try {
    const ctx = await requireProjectMember(req, res, req.params.projectId);
    if (!ctx) return;
    const { data, error } = await supabase
      .from('lab_saved_experiment_contexts')
      .select('id, name, content, created_at')
      .eq('project_id', req.params.projectId)
      .order('created_at', { ascending: false });
    if (error) throw error;
    res.json({ saved: data || [] });
  } catch (e) {
    if (String(e.message || '').includes('does not exist') || String(e.message || '').includes('relation')) {
      return res.json({ saved: [] });
    }
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/projects/:projectId/lab/saved-experiments', async (req, res) => {
  try {
    const ctx = await requireProjectMember(req, res, req.params.projectId);
    if (!ctx) return;
    const { name, content } = req.body || {};
    const projectId = req.params.projectId;
    const trimName = typeof name === 'string' ? name.trim() : '';
    if (!trimName) return res.status(400).json({ error: 'name is required' });
    const { data, error } = await supabase
      .from('lab_saved_experiment_contexts')
      .insert({ project_id: projectId, name: trimName, content: typeof content === 'string' ? content : '' })
      .select()
      .single();
    if (error) throw error;
    res.status(201).json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/projects/:projectId/lab/saved-experiments/:id', async (req, res) => {
  try {
    const ctx = await requireProjectMember(req, res, req.params.projectId);
    if (!ctx) return;
    const { error } = await supabase
      .from('lab_saved_experiment_contexts')
      .delete()
      .eq('id', req.params.id)
      .eq('project_id', req.params.projectId);
    if (error) throw error;
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- Lab AI insights (OpenAI GPT) ----------
const LAB_AI_INSIGHT_TASKS = {
  insights: { title: 'תובנות מהדאטה', instruction: 'סכם תובנות עיקריות מהנתונים: שיעור הצלחה, כישלונות, מגמות לפי תחום. תן סיכום תמציתי בעברית.' },
  contradictions: { title: 'זיהוי סתירות', instruction: 'זהה סתירות: אותה פורמולה עם תוצאות שונות. רשום כל סתירה עם מזהי הניסויים והתוצאות. אם אין – כתוב שאין סתירות. עברית.' },
  'failure-patterns': { title: 'דפוסי כישלון', instruction: 'ניתוח דפוסי כישלון: לפי תחום טכנולוגי ולפי חומר. רשום ספירות ומגמות. עברית.' },
  snapshot: { title: 'ניתוח סנאפשוט מחקר', instruction: 'סנאפשוט של מצב המחקר: סה"כ ניסויים, התפלגות תוצאות (הצלחה/כישלון/חלקי), לפי תחום. עברית.' },
  'formula-validate': { title: 'אימות פורמולה', instruction: 'בדוק אם יש פורמולה/הרכב בנתונים – האם תקין (מאזן מסה, טווחים), אזהרות או שגיאות. אם אין פורמולה מפורשת – כתוב כך. עברית.' },
  'formulation-intelligence': { title: 'Formulation Intelligence', instruction: 'בדיקה לפני ניסוי: מאזן מסה, טווחי חומרים, התאמה לניסויים קיימים. סטטוס: OK / אזהרה / סיכון. עברית.' },
  'similar-experiments': { title: 'ניסויים דומים', instruction: 'זהה קבוצות של ניסויים דומים (חומרים/פרופורציות דומים). רשום ניסויים דומים והתוצאות. עברית.' },
  relations: { title: 'קשרים (ניסוי / פורמולה / חומר / תוצאה)', instruction: 'סכם קשרים בין ניסויים, פורמולות, חומרים ותוצאות. רשימה תמציתית. עברית.' },
  guard: { title: 'Research Guard', instruction: 'בדיקת כפילויות ואזהרות: פורמולות כפולות, סיכונים. האם מותר להמשיך או שיש אזהרות. עברית.' },
  experiments: { title: 'רשימת ניסויים', instruction: 'סיכום רשימת הניסויים: מזהים, תחום, תוצאה, פורמולה (קיצור). עברית.' },
  'suggestion-engine': {
    title: 'Suggestion Engine – מנוע הצעות',
    instruction: `מנגנון שמנתח ניסויים קיימים ומציע ניסויים חדשים. בהתבסס על הנתונים:
1) זהה אזורים שלא נבדקו במרחב הפורמולציות.
2) זהה גבולות יציבות בין ניסויים מוצלחים לנכשלים.
3) זהה קומבינציות חומרים שלא נבדקו.

הפלט: 3–5 הצעות לניסויים. לכל הצעה חובה לכלול במפורש:
• פורמולציה מוצעת
• הסבר: הסבר קצר למה הניסוי הוצע (מה המטרה, מה הצפי)
• Evidence (על בסיס מה ההצעה): על אילו נתונים/ניסויים קיימים ההצעה מתבססת (מזהי ניסויים, תחום, תוצאות רלוונטיות)
• Risk (בסיסי): ציון סיכון בסיסי (נמוך/בינוני/גבוה) והסבר קצר לסיכון

כל התשובה בעברית. הצג כל הצעה במבנה ברור (ממוספר או עם כותרות קטנות).`
  }
};

app.post('/api/projects/:projectId/lab/ai-insight', async (req, res) => {
  try {
    const ctx = await requireProjectMember(req, res, req.params.projectId);
    if (!ctx) return;
    if (!OPENAI_API_KEY) return res.status(503).json({ error: 'OPENAI_API_KEY not set. Add your key to .env for Lab AI insights.' });
    const { experimentContext, insightType } = req.body || {};
    const context = typeof experimentContext === 'string' ? experimentContext.trim() : '';
    const task = LAB_AI_INSIGHT_TASKS[insightType];
    if (!task || !context) return res.status(400).json({ error: 'Body must include experimentContext (string) and insightType (one of: ' + Object.keys(LAB_AI_INSIGHT_TASKS).join(', ') + ').' });
    const systemPrompt = `אתה מומחה לניתוח נתוני ניסויים ומעבדה. אתה מקבל טקסט או נתוני ניסוי ומבצע את המשימה המבוקשת. כל התשובות בעברית בלבד.`;
    const userPrompt = `משימה: ${task.title}\n\nהוראות: ${task.instruction}\n\nנתוני הניסוי/הקשר:\n${context.slice(0, 12000)}`;
    const response = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: 'gpt-4o',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        max_tokens: 2000,
        temperature: 0.3
      },
      {
        headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
        timeout: 60000
      }
    );
    const text = response.data?.choices?.[0]?.message?.content?.trim() || '';
    if (!text) return res.status(502).json({ error: 'OpenAI returned empty response' });
    res.json({ text });
  } catch (e) {
    const status = e.response?.status;
    const msg = e.response?.data?.error?.message || e.message;
    if (status === 401) return res.status(502).json({ error: 'Invalid OpenAI API key' });
    if (status === 429) return res.status(429).json({ error: 'Rate limit – try again in a moment' });
    res.status(status && status >= 400 && status < 600 ? status : 500).json({ error: msg || 'Lab AI request failed' });
  }
});

function analysisInputHash(analysisType, input) {
  try {
    const str = typeof input === 'string' ? input : JSON.stringify(input);
    return crypto.createHash('sha256').update(str).digest('hex');
  } catch (_) { return null; }
}

async function getCachedAnalysis(projectId, analysisType, inputHash) {
  if (!inputHash) return null;
  try {
    const { data, error } = await supabase.from('analysis_log').select('result').eq('project_id', projectId).eq('analysis_type', analysisType).eq('input_hash', inputHash).order('created_at', { ascending: false }).limit(1).maybeSingle();
    if (error || !data) return null;
    return data.result;
  } catch (_) { return null; }
}

async function logAnalysis(projectId, analysisType, inputRef, result, requestId, inputHash = null) {
  try {
    await supabase.from('analysis_log').insert({
      project_id: projectId,
      analysis_type: analysisType,
      input_ref: inputRef || null,
      result: result || {},
      request_id: requestId || null,
      input_hash: inputHash || null
    });
  } catch (_) { /* table may not exist yet */ }
}

function getMaterialsSet(exp) {
  const mats = Array.isArray(exp.materials) ? exp.materials : (exp.materials && typeof exp.materials === 'object' ? Object.keys(exp.materials) : []);
  return new Set(mats.map(m => (typeof m === 'string' ? m : (m?.name || String(m))).trim().toLowerCase()).filter(Boolean));
}

function getPercentagesMap(exp) {
  const p = exp.percentages;
  if (!p || typeof p !== 'object') return {};
  const out = {};
  for (const [k, v] of Object.entries(p)) {
    const num = parseFloat(v);
    if (!isNaN(num)) out[String(k).trim().toLowerCase()] = num;
  }
  return out;
}

function similarityScore(expA, expB) {
  const matA = getMaterialsSet(expA);
  const matB = getMaterialsSet(expB);
  const inter = [...matA].filter(m => matB.has(m)).length;
  const union = new Set([...matA, ...matB]).size;
  const jaccard = union ? inter / union : 0;
  const percA = getPercentagesMap(expA);
  const percB = getPercentagesMap(expB);
  const allKeys = new Set([...Object.keys(percA), ...Object.keys(percB)]);
  let sumDiff = 0;
  let count = 0;
  allKeys.forEach(k => {
    const a = percA[k] ?? 0;
    const b = percB[k] ?? 0;
    sumDiff += Math.abs(a - b);
    count++;
  });
  const avgDiff = count ? sumDiff / count : 0;
  const percScore = Math.max(0, 1 - avgDiff / 100);
  return jaccard * 0.5 + percScore * 0.5;
}

app.post('/api/projects/:projectId/analysis/formulation-intelligence', async (req, res) => {
  try {
    const ctx = await requireProjectMember(req, res, req.params.projectId);
    if (!ctx) return;
    const projectId = req.params.projectId;
    const { formula, domain, materials, percentages } = req.body || {};
    const inputHash = analysisInputHash('formulation_intelligence', { formula, domain, materials, percentages });
    const cached = await getCachedAnalysis(projectId, 'formulation_intelligence', inputHash);
    if (cached) return res.json(cached);

    const issues = [];
    let status = 'OK';

    const vals = percentages && typeof percentages === 'object' ? Object.values(percentages).map(v => parseFloat(v)) : [];
    const sum = vals.reduce((a, b) => a + b, 0);
    if (vals.length > 0) {
      if (isNaN(sum) || Math.abs(sum - 100) > 0.5) {
        issues.push({ code: 'mass_balance', severity: 'error', message: `סכום אחוזים ${sum.toFixed(1)}%; מצופה 100%` });
        status = 'Risk';
      }
    }

    if (percentages && typeof percentages === 'object') {
      for (const [name, v] of Object.entries(percentages)) {
        const num = parseFloat(v);
        if (!isNaN(num) && (num < 0 || num > 100)) {
          issues.push({ code: 'range', severity: 'warning', message: `אחוז לחומר "${name}" מחוץ לטווח 0–100: ${num}` });
          if (status === 'OK') status = 'Warning';
        }
      }
    }

    const matList = Array.isArray(materials) ? materials : (materials && typeof materials === 'object' ? Object.keys(materials) : []);
    matList.forEach(m => {
      const name = typeof m === 'string' ? m : (m?.name ?? String(m));
      if (!name || !String(name).trim()) {
        issues.push({ code: 'empty_material', severity: 'warning', message: 'חומר ללא שם' });
        if (status === 'OK') status = 'Warning';
      }
    });

    const experiments = await getExperimentsForAnalysis(projectId);
    const normalized = normalizeFormulaForCompare(formula);
    const sameFormula = experiments.filter(e => normalizeFormulaForCompare(e.formula) === normalized);
    const failedSame = sameFormula.filter(e => e.experiment_outcome === 'failure' || e.experiment_outcome === 'partial');
    if (failedSame.length > 0) {
      issues.push({ code: 'similar_failed', severity: 'risk', message: `פורמולציה דומה כבר נכשלה ב־${failedSame.length} ניסויים`, experiment_ids: failedSame.map(e => e.experiment_id) });
      status = 'Risk';
    }

    const failures = experiments.filter(e => e.experiment_outcome === 'failure' || e.experiment_outcome === 'partial');
    const failureMaterials = new Set();
    failures.forEach(e => getMaterialsSet(e).forEach(m => failureMaterials.add(m)));
    const inputMats = new Set((matList.map(m => (typeof m === 'string' ? m : (m?.name ?? String(m))).trim().toLowerCase())).filter(Boolean));
    const overlap = [...inputMats].filter(m => failureMaterials.has(m));
    if (overlap.length > 0 && failures.length >= 2) {
      issues.push({ code: 'materials_in_failed', severity: 'warning', message: `חומרים שמופיעים בניסויים שנכשלו: ${overlap.join(', ')}`, materials: overlap });
      if (status === 'OK') status = 'Warning';
    }

    try {
      const { data: centralList } = await supabase.from('materials').select('material_id, material_name, aliases');
      if (centralList && centralList.length > 0) {
        const known = new Set();
        centralList.forEach(r => {
          known.add((r.material_name || '').toString().trim().toLowerCase());
          known.add((r.material_id || '').toString().trim().toLowerCase());
          (r.aliases || []).forEach(a => known.add(String(a).trim().toLowerCase()));
        });
        const unknown = [...inputMats].filter(m => !known.has(m));
        if (unknown.length > 0) {
          issues.push({ code: 'material_not_in_library', severity: 'warning', message: `חומרים שלא בספרייה המרכזית: ${unknown.join(', ')}`, materials: unknown });
          if (status === 'OK') status = 'Warning';
        }
      }
    } catch (_) { /* materials table may not exist */ }

    const result = { status, issues };
    await logAnalysis(projectId, 'formulation_intelligence', null, result, req.requestId, inputHash);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/projects/:projectId/analysis/similar-experiments', async (req, res) => {
  try {
    const ctx = await requireProjectMember(req, res, req.params.projectId);
    if (!ctx) return;
    const projectId = req.params.projectId;
    const experimentIdParam = req.query.experiment_id;
    if (!experimentIdParam) return res.status(400).json({ error: 'experiment_id query is required' });
    const outcomeFilter = req.query.experiment_outcome; // optional: success | failure | partial | production_formula
    const pctMin = req.query.material_pct_min != null ? parseFloat(req.query.material_pct_min) : null;
    const pctMax = req.query.material_pct_max != null ? parseFloat(req.query.material_pct_max) : null;

    const inputHash = analysisInputHash('similar_experiments', { experiment_id: experimentIdParam, experiment_outcome: outcomeFilter, material_pct_min: pctMin, material_pct_max: pctMax });
    const cached = await getCachedAnalysis(projectId, 'similar_experiments', inputHash);
    if (cached) return res.json(cached);

    const experiments = await getExperimentsForAnalysis(projectId);
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(experimentIdParam);
    const source = experiments.find(e => isUuid ? e.id === experimentIdParam : e.experiment_id === experimentIdParam);
    if (!source) return res.status(404).json({ error: 'Experiment not found' });

    let candidates = experiments.filter(e => e.id !== source.id && e.experiment_id !== source.experiment_id);
    if (outcomeFilter) candidates = candidates.filter(e => e.experiment_outcome === outcomeFilter);
    if (pctMin != null && !isNaN(pctMin) || pctMax != null && !isNaN(pctMax)) {
      candidates = candidates.filter(e => {
        const perc = getPercentagesMap(e);
        const vals = Object.values(perc);
        if (vals.length === 0) return false;
        const minP = Math.min(...vals);
        const maxP = Math.max(...vals);
        if (pctMin != null && !isNaN(pctMin) && maxP < pctMin) return false;
        if (pctMax != null && !isNaN(pctMax) && minP > pctMax) return false;
        return true;
      });
    }

    const withScore = candidates
      .map(e => ({ experiment: e, score: similarityScore(source, e) }))
      .filter(x => x.score > 0.1)
      .sort((a, b) => b.score - a.score)
      .slice(0, 20)
      .map(({ experiment, score }) => ({
        experiment_id: experiment.experiment_id,
        id: experiment.id,
        technology_domain: experiment.technology_domain,
        experiment_outcome: experiment.experiment_outcome,
        formula: experiment.formula ? String(experiment.formula).slice(0, 150) : null,
        similarity_score: Math.round(score * 100) / 100
      }));

    const result = { source_experiment_id: source.experiment_id, similar: withScore };
    await logAnalysis(projectId, 'similar_experiments', source.experiment_id, result, req.requestId, inputHash);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/projects/:projectId/analysis/technology-domains', async (req, res) => {
  try {
    const ctx = await requireProjectMember(req, res, req.params.projectId);
    if (!ctx) return;
    const experiments = await getExperimentsForAnalysis(req.params.projectId);
    const fromData = [...new Set(experiments.map(e => (e.technology_domain || '').trim()).filter(Boolean))].sort();
    res.json({ suggested: SUGGESTED_TECHNOLOGY_DOMAINS, from_data: fromData });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- SharePoint (Microsoft Graph) – optional ----------
const sharepointPullSchema = z.object({
  siteUrl: z.string().url().optional(),
  siteId: z.string().uuid().optional(),
  folderPath: z.string().max(2000).default(''),
  driveId: z.string().uuid().optional(),
  mock: z.boolean().optional()
}).refine(data => data.mock === true || data.siteUrl != null || data.siteId != null, { message: 'Either siteUrl, siteId, or mock: true is required' });

let graphTokenCache = { token: null, expiresAt: 0 };
async function getGraphToken() {
  if (graphTokenCache.token && Date.now() < graphTokenCache.expiresAt - 60000) return graphTokenCache.token;
  const res = await axios.post(
    `https://login.microsoftonline.com/${SHAREPOINT_TENANT_ID}/oauth2/v2.0/token`,
    new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: SHAREPOINT_CLIENT_ID,
      client_secret: SHAREPOINT_CLIENT_SECRET,
      scope: 'https://graph.microsoft.com/.default'
    }).toString(),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 15000 }
  );
  const accessToken = res.data?.access_token;
  const expiresIn = (res.data?.expires_in || 3600) * 1000;
  if (!accessToken) throw new Error('No access_token in Graph response');
  graphTokenCache = { token: accessToken, expiresAt: Date.now() + expiresIn };
  return accessToken;
}

async function getSiteIdFromUrl(siteUrl, token) {
  const u = new URL(siteUrl);
  const hostname = u.hostname;
  const pathname = u.pathname.replace(/\/$/, '') || '/';
  const res = await axios.get(
    `https://graph.microsoft.com/v1.0/sites/${hostname}:${pathname}`,
    { headers: { Authorization: `Bearer ${token}` }, timeout: 15000 }
  );
  return res.data?.id;
}

// ---------- Project files (upload → Matriya ingest, metadata in Supabase) ----------
/** Extensions that Matriya can index (ingest). */
const MATRIYA_INGEST_EXTENSIONS = ['.pdf', '.docx', '.txt', '.doc', '.xlsx', '.xls'];
function isMatriyaIngestible(filename) {
  const ext = (filename || '').toLowerCase().replace(/^.*\./, '');
  return MATRIYA_INGEST_EXTENSIONS.some(e => e.slice(1) === ext);
}

/**
 * Run ingest in background (management vector DB); on failure update project_files.ingest_error.
 * On success, debounce-schedule OpenAI vector store rebuild so cloud search matches newly indexed files.
 */
function ingestFileInBackground(projectId, projectFileId, buffer, originalName) {
  if (!hasLocalRag()) return;
  (async () => {
    try {
      const rag = await getLocalRag();
      if (!rag) return;
      const result = await rag.ingestBuffer(buffer, originalName);
      if (!result.success) {
        await supabase.from('project_files').update({ ingest_error: result.error || 'Indexing failed' }).eq('id', projectFileId);
      } else {
        await supabase.from('project_files').update({ ingest_error: null }).eq('id', projectFileId).then(() => {}, () => {});
        if (projectId) scheduleOpenAiVectorSyncForProject(projectId, 'after-local-rag-index');
      }
    } catch (e) {
      const errMsg = e.message || 'Indexing failed';
      await supabase.from('project_files').update({ ingest_error: errMsg }).eq('id', projectFileId).then(() => {}, () => {});
    }
  })();
}

/**
 * Create project_files row and store bytes in Supabase Storage (same layout as POST /files).
 * Without storage_path, downloads / attach-from-project / lab import-from-file do not work.
 */
async function createProjectFileFromBuffer(projectId, ctx, buffer, originalName, folderDisplayName, req, options = {}) {
  const name = (originalName && String(originalName).trim()) || 'file';
  const contentType = (options.contentType && String(options.contentType).trim()) || 'application/octet-stream';
  const auditSource = options.auditSource || 'email_attachment';
  const syncReasonTag = options.syncReason || 'email/buffer';
  const { data: row, error: insertErr } = await supabase.from('project_files').insert({
    project_id: projectId,
    original_name: name,
    folder_display_name: folderDisplayName || null
  }).select().single();
  if (insertErr) throw insertErr;

  let rowOut = row;
  const buf = buffer && Buffer.isBuffer(buffer) ? buffer : buffer ? Buffer.from(buffer) : null;
  if (buf && buf.length > 0) {
    await ensureManualBucketExists();
    const relativeKey = `${PROJECT_PREFIX}${projectId}/${row.id}/${safeStorageKeySegment(name)}`;
    const storage_path = `${MANUAL_PREFIX}/${relativeKey}`;
    const { error: upErr } = await supabase.storage.from(MANUAL_BUCKET).upload(relativeKey, buf, {
      contentType,
      upsert: false
    });
    if (upErr) {
      await supabase.from('project_files').delete().eq('id', row.id).eq('project_id', projectId);
      throw new Error(upErr.message || 'Failed to store file in project storage');
    }
    const { data: updated, error: pathErr } = await supabase
      .from('project_files')
      .update({ storage_path })
      .eq('id', row.id)
      .select()
      .single();
    if (pathErr) {
      await supabase.storage.from(MANUAL_BUCKET).remove([relativeKey]).catch(() => {});
      await supabase.from('project_files').delete().eq('id', row.id).eq('project_id', projectId);
      throw pathErr;
    }
    rowOut = updated || { ...row, storage_path };
  }

  auditLog(projectId, ctx.user.id, ctx.user.username, 'create', 'project_file', rowOut.id, { original_name: name, source: auditSource }, req.requestId);
  if (hasLocalRag() && buf && buf.length) {
    setImmediate(() => ingestFileInBackground(projectId, rowOut.id, Buffer.from(buf), name));
  }
  if (rowOut.storage_path) scheduleOpenAiVectorSyncForProject(projectId, syncReasonTag);
  return rowOut;
}

/** Import an attachment from a received email into project files (RAG). destination=lab uses LAB_EMAIL_IMPORT_FOLDER. */
app.post('/api/projects/:projectId/emails/:storedEmailId/import-attachment', limiterEmail, async (req, res) => {
  try {
    const projectId = req.params.projectId;
    const ctx = await requireProjectMember(req, res, projectId);
    if (!ctx) return;
    if (!RESEND_API_KEY) return res.status(503).json({ error: 'RESEND_API_KEY required' });
    const parsed = emailAttachImportSchema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ error: 'Validation failed', issues: parsed.error.flatten() });
    const { attachment_id, destination } = parsed.data;

    const { data: mailRow, error: mailErr } = await supabase.from('project_emails').select('*').eq('id', req.params.storedEmailId).eq('project_id', projectId).single();
    if (mailErr || !mailRow) return res.status(404).json({ error: 'Email not found' });
    if (mailRow.direction !== 'received') return res.status(400).json({ error: 'Only received emails can import Resend attachments' });
    if (!mailRow.resend_email_id) return res.status(400).json({ error: 'Email has no Resend receiving id' });

    const attUrl = `https://api.resend.com/emails/receiving/${encodeURIComponent(mailRow.resend_email_id)}/attachments/${encodeURIComponent(attachment_id)}`;
    const attMetaR = await fetch(attUrl, { headers: { Authorization: `Bearer ${RESEND_API_KEY}` } });
    const attMeta = await attMetaR.json().catch(() => ({}));
    if (!attMetaR.ok) {
      return res.status(502).json({ error: typeof attMeta.message === 'string' ? attMeta.message : 'Failed to get attachment from Resend', details: attMeta });
    }
    const downloadUrl = attMeta.download_url;
    if (!downloadUrl) return res.status(502).json({ error: 'No download_url from Resend (URLs expire ~1h after receipt)' });
    const binR = await fetch(downloadUrl);
    if (!binR.ok) return res.status(502).json({ error: 'Failed to download attachment bytes' });
    const buf = Buffer.from(await binR.arrayBuffer());
    const filename = attMeta.filename || 'attachment';
    const folderLabel = destination === 'lab' ? LAB_EMAIL_IMPORT_FOLDER : null;
    const ct = attMeta.content_type || attMeta.contentType || 'application/octet-stream';
    /** Run Lab text extraction in parallel with storage upload (same buffer) — saves wall time vs sequential. */
    const labParsePromise =
      destination === 'lab'
        ? parseExperimentBufferToText(buf, filename)
            .then((r) => r.text)
            .catch(() => null)
        : null;
    const row = await createProjectFileFromBuffer(projectId, ctx, buf, filename, folderLabel, req, { contentType: ct });
    const lab_parsed_text = labParsePromise != null ? await labParsePromise : null;
    res.status(201).json({
      file: row,
      ingestible: isMatriyaIngestible(filename),
      destination,
      ...(destination === 'lab' ? { lab_parsed_text } : {})
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/projects/:projectId/files', async (req, res) => {
  try {
    const projectId = req.params.projectId;
    if (!projectId || typeof projectId !== 'string' || !projectId.trim()) {
      return res.status(400).json({ error: 'project_id required' });
    }
    const ctx = await requireProjectMember(req, res, projectId);
    if (!ctx) return;
    const { limit, offset } = parsePagination(req);
    const { data, error } = await supabase.from('project_files').select('*').eq('project_id', projectId.trim()).order('created_at', { ascending: false }).range(offset, offset + limit - 1);
    if (error) {
      const msg = String(error.message || error);
      if (msg.includes('does not exist') || msg.includes('relation') || msg.includes('project_files')) {
        console.warn('project_files table missing – run full supabase_schema.sql to enable files. Returning empty list.');
        return res.json({ files: [], limit, offset });
      }
      throw error;
    }
    res.json({ files: data || [], limit, offset });
  } catch (e) {
    console.error('GET /api/projects/:projectId/files', e?.message || e);
    res.status(500).json({ error: e?.message || 'Failed to list project files' });
  }
});

app.post('/api/projects/:projectId/files/pull-sharepoint', limiterSharePoint, async (req, res) => {
  const projectId = req.params.projectId;
  const ctx = await requireProjectMember(req, res, projectId);
  if (!ctx) return;
  if (!SHAREPOINT_TENANT_ID || !SHAREPOINT_CLIENT_ID || !SHAREPOINT_CLIENT_SECRET) {
    return res.status(503).json({ error: 'SharePoint integration not configured (SHAREPOINT_TENANT_ID, SHAREPOINT_CLIENT_ID, SHAREPOINT_CLIENT_SECRET)' });
  }
  if (!hasLocalRag()) {
    return res.status(503).json({ error: 'RAG not configured – set POSTGRES_URL in .env for document indexing' });
  }
  const parsed = sharepointPullSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ error: 'Validation failed', issues: parsed.error.flatten() });
  }
  const { siteUrl, siteId, folderPath, driveId } = parsed.data;
  const requestId = (req.body && req.body.request_id) || req.requestId;
  try {
    const { data: existing, error: insertError } = await supabase.from('sharepoint_pull_requests').insert({ request_id: requestId, project_id: projectId }).select('request_id').single();
    if (insertError && insertError.code === '23505') {
      return res.json({ pulled: 0, skipped: true, idempotent: true, message: 'Already processed this request_id' });
    }
    if (insertError) throw insertError;
    const token = await getGraphToken();
    let site = siteId;
    if (!site && siteUrl) site = await getSiteIdFromUrl(siteUrl, token);
    if (!site) return res.status(400).json({ error: 'Could not resolve SharePoint site (check siteUrl or siteId)' });
    const drivePath = driveId
      ? `https://graph.microsoft.com/v1.0/sites/${site}/drives/${driveId}`
      : `https://graph.microsoft.com/v1.0/sites/${site}/drive`;
    const folderPathEnc = folderPath.replace(/^\//, '').trim();
    const listUrl = folderPathEnc
      ? `${drivePath}/root:/${folderPathEnc}:/children`
      : `${drivePath}/root/children`;
    const listRes = await axios.get(listUrl, { headers: { Authorization: `Bearer ${token}` }, timeout: 15000 });
    const children = listRes.data?.value || [];
    const files = children.filter(item => item.file != null);
    const ingested = [];
    const failed = [];
    for (const item of files) {
      try {
        const contentRes = await axios.get(
          `https://graph.microsoft.com/v1.0/sites/${site}/drive/items/${item.id}/content`,
          { headers: { Authorization: `Bearer ${token}` }, responseType: 'arraybuffer', timeout: 120000, maxRedirects: 5 }
        );
        const buffer = Buffer.from(contentRes.data);
        const originalName = item.name || 'file';
        if (!buffer?.length) {
          failed.push({ name: originalName, error: 'Empty file' });
          continue;
        }
        // Same as POST /files: persist to Supabase Storage (storage_path) so GPT sync / downloads work.
        const rowOut = await createProjectFileFromBuffer(projectId, ctx, buffer, originalName, null, req, {
          auditSource: 'sharepoint',
          syncReason: 'sharepoint-pull'
        });
        ingested.push({ id: rowOut.id, original_name: originalName });
      } catch (e) {
        failed.push({ name: item.name || 'file', error: e.response?.data?.error ?? e.message });
      }
    }
    res.json({ pulled: ingested.length, failed: failed.length, ingested, failed });
  } catch (e) {
    const msg = e.response?.data?.error?.message ?? e.response?.data?.error ?? e.message;
    const status = e.response?.status || 500;
    res.status(status).json({ error: msg });
  }
});

app.post('/api/projects/:projectId/files', limiterUpload, upload.single('file'), async (req, res) => {
  const projectId = req.params.projectId;
  const ctx = await requireProjectMember(req, res, projectId);
  if (!ctx) return;
  if (!req.file) {
    return res.status(400).json({ error: 'No file provided' });
  }
  const file = req.file;
  const utf8Name = req.body && typeof req.body.originalName === 'string' && req.body.originalName.trim();
  const originalName = (utf8Name ? req.body.originalName.trim() : null) || file.originalname || 'file';
  const folderDisplayName = req.body && typeof req.body.folder_display_name === 'string' && req.body.folder_display_name.trim() ? req.body.folder_display_name.trim() : null;
  try {
    const { data: row, error: insertErr } = await supabase.from('project_files').insert({
      project_id: projectId,
      original_name: originalName,
      folder_display_name: folderDisplayName || null
    }).select().single();
    if (insertErr) throw insertErr;

    const buffer = file.buffer ? Buffer.from(file.buffer) : null;
    let rowOut = row;
    if (buffer && buffer.length > 0) {
      await ensureManualBucketExists();
      const relativeKey = `${PROJECT_PREFIX}${projectId}/${row.id}/${safeStorageKeySegment(originalName)}`;
      const storage_path = `${MANUAL_PREFIX}/${relativeKey}`;
      const { error: upErr } = await supabase.storage.from(MANUAL_BUCKET).upload(relativeKey, buffer, {
        contentType: file.mimetype || 'application/octet-stream',
        upsert: false
      });
      if (upErr) {
        await supabase.from('project_files').delete().eq('id', row.id).eq('project_id', projectId);
        throw new Error(upErr.message || 'Failed to store file in project storage');
      }
      const { data: updated, error: pathErr } = await supabase
        .from('project_files')
        .update({ storage_path })
        .eq('id', row.id)
        .select()
        .single();
      if (pathErr) {
        await supabase.storage.from(MANUAL_BUCKET).remove([relativeKey]).catch(() => {});
        await supabase.from('project_files').delete().eq('id', row.id).eq('project_id', projectId);
        throw pathErr;
      }
      rowOut = updated || { ...row, storage_path };
    }

    auditLog(projectId, ctx.user.id, ctx.user.username, 'create', 'project_file', rowOut.id, { original_name: originalName }, req.requestId);

    res.status(201).json(rowOut);
    if (hasLocalRag() && buffer) {
      setImmediate(() => ingestFileInBackground(projectId, rowOut.id, buffer, originalName));
    }
    if (rowOut.storage_path) scheduleOpenAiVectorSyncForProject(projectId, 'multipart');
  } catch (e) {
    const status = e.response?.status || 500;
    const data = e.response?.data || { error: e.message };
    res.status(status).json(typeof data === 'object' ? data : { error: e.message });
  }
});

app.delete('/api/projects/:projectId/files/:fileId', async (req, res) => {
  try {
    const ctx = await requireProjectMember(req, res, req.params.projectId);
    if (!ctx) return;
    const { error } = await supabase.from('project_files').delete().eq('id', req.params.fileId).eq('project_id', req.params.projectId);
    if (error) throw error;
    auditLog(req.params.projectId, ctx.user.id, ctx.user.username, 'delete', 'project_file', req.params.fileId, null, req.requestId);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * Backfill storage_path for rows missing it by uploading UTF-8 text from the management RAG index (same DB as ingest).
 * Enables GPT sync / download for legacy SharePoint-pull rows, etc.
 */
app.post('/api/projects/:projectId/files/repair-storage-from-rag', limiterRag, async (req, res) => {
  try {
    const projectId = req.params.projectId;
    const ctx = await requireProjectMember(req, res, projectId);
    if (!ctx) return;
    if (!hasLocalRag()) {
      return res.status(503).json({ error: 'RAG not configured – set POSTGRES_URL (or DATABASE_URL) for management vector DB' });
    }
    const rag = await getLocalRag();
    if (!rag || typeof rag.getFullTextForFile !== 'function') {
      return res.status(503).json({ error: 'RAG service cannot rebuild storage' });
    }

    const { data: rows, error } = await supabase
      .from('project_files')
      .select('id, original_name, storage_path')
      .eq('project_id', projectId);
    if (error) return res.status(500).json({ error: error.message });

    const missing = (rows || []).filter((r) => !r.storage_path || !String(r.storage_path).trim());
    const repaired = [];
    const failed = [];

    await ensureManualBucketExists();

    for (const row of missing) {
      const name = String(row.original_name || '').trim() || 'file';
      let text = await rag.getFullTextForFile(name);
      if (!text) {
        const base = path.basename(name);
        if (base !== name) text = await rag.getFullTextForFile(base);
      }
      if (!text || !String(text).trim()) {
        failed.push({ id: row.id, original_name: name, error: 'לא נמצא טקסט באינדוקס למסמך זה (שם קובץ לא תואם או טרם אונדקס)' });
        continue;
      }

      const header = `--- שוחזר מאינדוקס המסמכים (מקור: ${name}) ---\n\n`;
      const buffer = Buffer.from(header + text, 'utf8');
      if (buffer.length > 32 * 1024 * 1024) {
        failed.push({ id: row.id, original_name: name, error: 'הטקסט המשוחזר גדול מדי' });
        continue;
      }

      try {
        const relativeKey = `${PROJECT_PREFIX}${projectId}/${row.id}/${safeStorageKeySegment(name)}_rag_repair.txt`;
        const storage_path = `${MANUAL_PREFIX}/${relativeKey}`;
        const { error: upErr } = await supabase.storage.from(MANUAL_BUCKET).upload(relativeKey, buffer, {
          contentType: 'text/plain; charset=utf-8',
          upsert: true
        });
        if (upErr) throw new Error(upErr.message);
        const { error: upRowErr } = await supabase
          .from('project_files')
          .update({ storage_path })
          .eq('id', row.id)
          .eq('project_id', projectId);
        if (upRowErr) throw new Error(upRowErr.message);
        repaired.push({ id: row.id, original_name: name });
        auditLog(projectId, ctx.user.id, ctx.user.username, 'update', 'project_file', row.id, { storage_repaired_from_rag: true }, req.requestId);
      } catch (e) {
        failed.push({ id: row.id, original_name: name, error: e.message || String(e) });
      }
    }

    if (repaired.length > 0) scheduleOpenAiVectorSyncForProject(projectId, 'repair-storage-from-rag');

    res.json({
      ok: true,
      repaired_count: repaired.length,
      failed_count: failed.length,
      repaired,
      failed: failed.length ? failed : undefined
    });
  } catch (e) {
    console.error('[repair-storage-from-rag]', e);
    res.status(500).json({ error: e.message || 'repair failed' });
  }
});

const SHAREPOINT_BUCKET = 'sharepoint-files';
const MANUAL_BUCKET = 'manually-uploaded-sharepoint-files';
const MANUAL_PREFIX = 'manual';
const MAPPING_KEY = '_mapping.json';

async function ensureSharepointBucketExists() {
  const { error } = await supabase.storage.createBucket(SHAREPOINT_BUCKET, { public: false });
  if (error && !String(error.message || '').toLowerCase().includes('already exists')) {
    console.warn('[SharePoint] bucket create:', error.message);
  }
}

async function ensureManualBucketExists() {
  const { error } = await supabase.storage.createBucket(MANUAL_BUCKET, { public: false });
  if (error && !String(error.message || '').toLowerCase().includes('already exists')) {
    console.warn('[SharePoint] manual bucket create:', error.message);
  }
}

function safeStorageKeySegment(name) {
  return String(name).replace(/[^\x00-\x7E.a-zA-Z0-9_.-]/g, '_').replace(/\s+/g, '_').replace(/[()[\]]/g, '_') || 'file';
}
function safeStoragePath(relativePathOrName, folderPath) {
  const prefix = (folderPath && String(folderPath).trim()) ? String(folderPath).replace(/\\/g, '/').split('/').filter(Boolean).map(safeStorageKeySegment).join('/') : '';
  const parts = String(relativePathOrName).replace(/\\/g, '/').split('/').filter(Boolean);
  const safeParts = parts.map(p => safeStorageKeySegment(p) || 'file');
  const relativeKey = safeParts.join('/') || 'file';
  return prefix ? `${prefix}/${relativeKey}` : relativeKey;
}

const bucketListCache = { byProject: {}, files: null, filesExpiresAt: 0 };
const BUCKET_CACHE_TTL_MS = 2 * 60 * 1000;
const BUCKET_DISPLAY_NAMES_CACHE_TTL_MS = 30 * 1000; // shorter so production shows decoded names soon after upload

const PROJECT_PREFIX = 'project_';

async function getNextFolderNumber(projectId, forManualBucket = false) {
  const query = forManualBucket
    ? supabase.from('sharepoint_display_names').select('path')
    : supabase.from('sharepoint_display_names').select('path').eq('project_id', projectId);
  const { data: rows } = await query;
  const folderPaths = (rows || []).filter(r => r.path && /^folder_\d+$/.test(String(r.path).trim()));
  if (folderPaths.length === 0) return 1;
  const nums = folderPaths.map(r => parseInt(String(r.path).replace(/^folder_(\d+)$/, '$1'), 10)).filter(n => !Number.isNaN(n));
  return nums.length ? Math.max(...nums) + 1 : 1;
}

function getExtension(relativeName) {
  const s = String(relativeName || '');
  const i = s.lastIndexOf('.');
  return i > 0 ? s.slice(i) : '';
}

/** Returns ASCII-only extension for Supabase storage (Hebrew not supported in bucket paths). */
function getExtensionAscii(relativeName) {
  const raw = getExtension(relativeName);
  if (!raw) return '';
  const safe = raw.replace(/[^a-zA-Z0-9.]/g, '').toLowerCase().slice(0, 10);
  return safe ? (safe.startsWith('.') ? safe : '.' + safe) : '';
}

/** Random ASCII id for bucket paths (no folder_1 / file_1; Hebrew not supported in Supabase Storage). */
function randomAsciiId(len = 8) {
  return crypto.randomBytes(Math.ceil(len / 2)).toString('hex').slice(0, len);
}

/** True if path is our ASCII-only manual bucket path (e.g. "a1b2c3d4.pdf" or "a1b2c3/x4y5z6.pdf"). */
function isManualAsciiPath(path) {
  const s = typeof path === 'string' ? path.trim() : '';
  return s.length > 0 && /^[a-zA-Z0-9]+(\.[a-zA-Z0-9]+)?(\/[a-zA-Z0-9._-]+)?$/.test(s);
}

async function getBucketNameMapping() {
  const { data, error } = await supabase.storage.from(SHAREPOINT_BUCKET).download(MAPPING_KEY);
  if (error || !data) return {};
  try {
    const text = await data.text();
    return JSON.parse(text) || {};
  } catch { return {}; }
}

async function saveBucketNameMapping(mapping) {
  const json = JSON.stringify(mapping || {}, null, 0);
  const { error } = await supabase.storage.from(SHAREPOINT_BUCKET).upload(MAPPING_KEY, Buffer.from(json, 'utf8'), { contentType: 'application/json', upsert: true });
  if (error) throw error;
}

async function listBucketRecursive(bucket, prefix = '') {
  const { data, error } = await supabase.storage.from(bucket).list(prefix, { limit: 500 });
  if (error) throw error;
  const files = [];
  const subdirs = [];
  for (const item of data || []) {
    const path = prefix ? `${prefix}/${item.name}` : item.name;
    if (item.id) files.push({ path, name: item.name });
    else subdirs.push(path);
  }
  if (subdirs.length) {
    const nested = await Promise.all(subdirs.map(p => listBucketRecursive(bucket, p)));
    nested.forEach((arr, idx) => {
      files.push(...arr);
      if (arr.length === 0) {
        const p = subdirs[idx];
        const name = p.includes('/') ? p.split('/').pop() : p;
        files.push({ path: p, name: name || p });
      }
    });
  }
  return files;
}

async function listAllBucketsMerged() {
  const [fromSharepoint, fromManual] = await Promise.all([
    listBucketRecursive(SHAREPOINT_BUCKET, ''),
    listBucketRecursive(MANUAL_BUCKET, '').catch(() => [])
  ]);
  const manualPrefixed = fromManual.map(f => ({ path: MANUAL_PREFIX + '/' + f.path, name: f.name }));
  return [...fromSharepoint, ...manualPrefixed];
}

app.get('/api/projects/:projectId/files/sharepoint-bucket', async (req, res) => {
  try {
    const ctx = await requireProjectMember(req, res, req.params.projectId);
    if (!ctx) return;
    const projectId = req.params.projectId;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store, max-age=0'); // so production always gets fresh display names (no קובץ/תיקייה)
    const now = Date.now();
    let files = (bucketListCache.files && now < bucketListCache.filesExpiresAt) ? bucketListCache.files : null;
    if (!files) {
      files = await listAllBucketsMerged();
      bucketListCache.files = files;
      bucketListCache.filesExpiresAt = now + BUCKET_CACHE_TTL_MS;
    }
    const projCache = bucketListCache.byProject[projectId];
    if (projCache && now < projCache.expiresAt) {
      console.log('[sharepoint-bucket] serving from cache for projectId=', projectId, '| displayNamesMap keys=', Object.keys(projCache.displayNamesMap).length);
      const withDisplay = files.map(f => ({ ...f, displayName: projCache.safeDisplay(f.path, f.name) }));
      return res.json({ files: withDisplay, displayNamesMap: projCache.displayNamesMap });
    }
    const prefix = `${PROJECT_PREFIX}${projectId}/`;
    const [mapping, { data: dbRowsRaw, error: dbErr }] = await Promise.all([
      getBucketNameMapping(),
      supabase.from('sharepoint_display_names').select('path, display_name').eq('project_id', projectId)
    ]);
    if (dbErr) console.warn('[sharepoint-bucket] display_names query failed (run migration 005?):', dbErr.message);
    const dbRows = dbRowsRaw || [];
    console.log('[sharepoint-bucket] projectId=', projectId, '| dbRows=', dbRows.length, '| sample DB paths=', dbRows.slice(0, 5).map(r => r.path));
    const dbMap = {};
    for (const row of dbRows || []) {
      if (row.path != null && row.display_name != null) dbMap[prefix + row.path] = row.display_name;
    }
    const displayNamesMap = { ...mapping };
    for (const k of Object.keys(dbMap)) {
      displayNamesMap[k] = dbMap[k];
      displayNamesMap[MANUAL_PREFIX + '/' + k] = dbMap[k];
    }
    for (const row of dbRows || []) {
      if (row.path != null && row.display_name != null) displayNamesMap[MANUAL_PREFIX + '/' + row.path] = row.display_name;
    }
    const manualPaths = displayNamesMap ? Object.keys(displayNamesMap).filter(p => p.startsWith(MANUAL_PREFIX + '/')) : [];
    console.log('[sharepoint-bucket] displayNamesMap manual keys=', manualPaths.length, '| sample=', manualPaths.slice(0, 5));
    const safeDisplay = (path, name) => {
      const d = displayNamesMap[path] ?? mapping[path];
      if (d == null || d === '' || d === '_') return name || path;
      if (/[\uFFFD\u00A4]/.test(String(d))) return name || path;
      return d;
    };
    const withDisplay = files.map(f => ({ ...f, displayName: safeDisplay(f.path, f.name) }));
    const manualFiles = withDisplay.filter(f => (f.path || '').startsWith('manual/'));
    const fromDb = manualFiles.filter(f => displayNamesMap[f.path] != null).length;
    const fromFallback = manualFiles.length - fromDb;
    console.log('[sharepoint-bucket] withDisplay: manual files=', manualFiles.length, '| with display from DB/map=', fromDb, '| fallback (name/path)=', fromFallback);
    if (dbRows.length > 0) {
      bucketListCache.byProject[projectId] = { displayNamesMap, safeDisplay, expiresAt: now + BUCKET_DISPLAY_NAMES_CACHE_TTL_MS };
    }
    res.json({ files: withDisplay, displayNamesMap });
  } catch (e) {
    res.status(500).json({ error: e?.message || 'Failed to list bucket' });
  }
});

// Public Supabase config for direct-to-bucket upload from frontend (avoids 413 / CORS on Vercel; set SUPABASE_ANON_KEY or NEXT_PUBLIC_SUPABASE_ANON_KEY in production).
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
app.get('/api/projects/:projectId/files/upload-to-sharepoint-bucket/config', async (req, res) => {
  try {
    const ctx = await requireProjectMember(req, res, req.params.projectId);
    if (!ctx) return;
    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
      return res.json({ useDirectUpload: false });
    }
    res.json({ useDirectUpload: true, supabaseUrl: SUPABASE_URL, supabaseAnonKey: SUPABASE_ANON_KEY });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Get signed upload URLs for direct-to-bucket upload from frontend (faster, no file through server).
// Storage paths are ASCII-only (random ids) because Hebrew is not supported in Supabase Storage; display names (Hebrew/English) are stored in DB and shown in the frontend.
app.post('/api/projects/:projectId/files/upload-to-sharepoint-bucket/signed-urls', limiterUpload, async (req, res) => {
  try {
    const ctx = await requireProjectMember(req, res, req.params.projectId);
    if (!ctx) return;
    const folderPath = (req.body?.folderPath != null) ? String(req.body.folderPath).trim() : '';
    const files = req.body?.files;
    const existingFolderId = (req.body?.folderId != null && req.body.folderId !== '') ? String(req.body.folderId).trim() : null;
    if (!Array.isArray(files) || files.length === 0) return res.status(400).json({ error: 'Body must include files: [{ relativeName, contentType? }]' });
    if (files.length > 50) return res.status(400).json({ error: 'Maximum 50 files per request' });

    const folderId = (folderPath && !existingFolderId) ? randomAsciiId(8) : (folderPath ? existingFolderId : null);
    const storagePaths = files.map((f) => {
      const relativeName = (f && f.relativeName) ? String(f.relativeName) : 'file';
      const ext = getExtensionAscii(relativeName) || '';
      const fileId = randomAsciiId(8);
      return folderId ? `${folderId}/${fileId}${ext}` : `${fileId}${ext}`;
    });

    const urls = [];
    await ensureManualBucketExists();
    for (const storagePath of storagePaths) {
      const { data, error } = await supabase.storage.from(MANUAL_BUCKET).createSignedUploadUrl(storagePath, { upsert: true });
      if (error) return res.status(500).json({ error: error.message });
      urls.push({ path: data.path, token: data.token });
    }
    res.json({ bucket: MANUAL_BUCKET, urls, folderId: folderId || undefined });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/projects/:projectId/files/upload-to-sharepoint-bucket/invalidate-cache', async (req, res) => {
  try {
    const ctx = await requireProjectMember(req, res, req.params.projectId);
    if (!ctx) return;
    bucketListCache.files = null;
    bucketListCache.filesExpiresAt = 0;
    bucketListCache.byProject = {};
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

function mergePathDisplayMappings(merged, storagePath, displayName) {
  const p = String(storagePath).trim();
  const d = String(displayName).trim();
  if (!p || d == null) return;
  merged[p] = d;
  const pParts = p.split('/');
  const dParts = d.split('/');
  for (let i = 0; i < pParts.length; i++) {
    const prefixP = pParts.slice(0, i + 1).join('/');
    if (!prefixP) continue;
    const isFolder = i < pParts.length - 1;
    if (isFolder) {
      const folderDisplayIndex = Math.min(i, Math.max(0, dParts.length - 2));
      merged[prefixP] = dParts[folderDisplayIndex] ?? dParts[0] ?? prefixP;
    } else {
      merged[prefixP] = d;
    }
  }
}

app.post('/api/projects/:projectId/files/upload-to-sharepoint-bucket/update-display-names', async (req, res) => {
  try {
    const ctx = await requireProjectMember(req, res, req.params.projectId);
    if (!ctx) return;
    const projectId = req.params.projectId;
    const mappings = req.body?.mappings;
    if (!mappings || typeof mappings !== 'object') return res.status(400).json({ error: 'Body must include mappings: { "storagePath": "displayName", ... }' });

    const prefix = `${PROJECT_PREFIX}${projectId}/`;
    if (Object.keys(mappings).length > 0) {
      const keys = Object.keys(mappings);
      console.log('[update-display-names] projectId=', projectId, '| count=', keys.length, '| sample paths=', keys.slice(0, 5), '| sample displayNames=', keys.slice(0, 5).map(k => mappings[k]));
    }
    for (const [rawPath, displayName] of Object.entries(mappings)) {
      const d = String(displayName ?? '').trim();
      if (!d) continue;
      const storagePath = String(rawPath ?? '').trim().replace(/^\/+/, '');
      const relativePath = storagePath.startsWith(prefix)
        ? storagePath.slice(prefix.length).trim()
        : (isManualAsciiPath(storagePath) ? storagePath : '');
      if (!relativePath) {
        console.log('[update-display-names] skip path (no prefix match):', JSON.stringify(storagePath));
        continue;
      }
      const dParts = d.split('/').filter(Boolean);
      const relParts = relativePath.split('/').filter(Boolean);
      const fileDisplayName = dParts.length > 0 ? dParts[dParts.length - 1] : d;
      const folderDisplayName = dParts.length > 1 ? dParts[0] : dParts[0] || d;
      const { error: errFile } = await supabase.from('sharepoint_display_names').upsert(
        { project_id: projectId, path: relativePath, display_name: fileDisplayName, updated_at: new Date().toISOString() },
        { onConflict: 'project_id,path' }
      );
      if (errFile) return res.status(500).json({ error: 'Failed to save display name: ' + (errFile.message || 'database error') });
      if (relParts.length > 1) {
        const folderPath = relParts.slice(0, -1).join('/');
        const { error: errFolder } = await supabase.from('sharepoint_display_names').upsert(
          { project_id: projectId, path: folderPath, display_name: folderDisplayName, updated_at: new Date().toISOString() },
          { onConflict: 'project_id,path' }
        );
        if (errFolder) return res.status(500).json({ error: 'Failed to save folder display name: ' + (errFolder.message || 'database error') });
      }
    }

    const current = await getBucketNameMapping();
    const merged = { ...current };
    for (const [path, displayName] of Object.entries(mappings)) {
      mergePathDisplayMappings(merged, path, displayName);
    }
    await saveBucketNameMapping(merged);
    bucketListCache.files = null;
    bucketListCache.filesExpiresAt = 0;
    bucketListCache.byProject = {};
    res.json({ ok: true, updated: Object.keys(mappings).length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const sharepointUploadProgressMap = new Map();

app.get('/api/projects/:projectId/files/upload-to-sharepoint-bucket/progress', async (req, res) => {
  try {
    const ctx = await requireProjectMember(req, res, req.params.projectId);
    if (!ctx) return;
    const uploadId = req.query.uploadId;
    if (!uploadId) return res.status(400).json({ error: 'uploadId required' });
    const progress = sharepointUploadProgressMap.get(uploadId);
    // On Vercel/serverless, progress is in-memory per instance; polling may hit another instance. Return 200 with unknown so frontend does not treat as failure.
    if (!progress) return res.status(200).json({ file: null, total: null, phase: 'unknown' });
    res.json(progress);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/projects/:projectId/files/upload-to-sharepoint-bucket', limiterUpload, upload.fields([{ name: 'files', maxCount: 50 }, { name: 'file', maxCount: 1 }]), async (req, res) => {
  const uploadId = req.headers['x-upload-id'] || null;
  const setProgress = (file, total, phase) => {
    if (uploadId) sharepointUploadProgressMap.set(uploadId, { file, total, phase });
  };
  try {
    const ctx = await requireProjectMember(req, res, req.params.projectId);
    if (!ctx) return;
    const projectId = req.params.projectId;
    const raw = req.files || {};
    const filesArray = raw.files ? (Array.isArray(raw.files) ? raw.files : [raw.files]) : [];
    const fileSingle = raw.file ? (Array.isArray(raw.file) ? raw.file[0] : raw.file) : null;
    const files = filesArray.length ? filesArray : (fileSingle ? [fileSingle] : []);
    if (files.length === 0) return res.status(400).json({ error: 'No files provided. Send multipart form with "files" (and optional "folderPath", "folderId" for chunked upload).' });
    const folderPath = (req.body && req.body.folderPath != null) ? String(req.body.folderPath).trim() : '';
    const existingFolderId = (req.body && typeof req.body.folderId === 'string') ? String(req.body.folderId).trim() : null;
    let fileNames = null;
    try {
      if (req.body && typeof req.body.fileNamesB64 === 'string') {
        const decoded = Buffer.from(req.body.fileNamesB64, 'base64').toString('utf8');
        fileNames = JSON.parse(decoded);
      }
    } catch (_) {}
    if (!Array.isArray(fileNames) || fileNames.length !== files.length) {
      try {
        if (req.body && typeof req.body.fileNames === 'string') fileNames = JSON.parse(req.body.fileNames);
      } catch (_) {}
    }
    if (!Array.isArray(fileNames) || fileNames.length !== files.length) fileNames = null;
    if (!fileNames && files.length > 0 && process.env.NODE_ENV !== 'production') console.warn('[SharePoint upload] fileNames missing or length mismatch – display names may be wrong.');
    await ensureManualBucketExists();
    const uploaded = [];
    const failed = [];
    const folderId = folderPath ? (existingFolderId || randomAsciiId(8)) : null;
    const storagePaths = files.map((file, i) => {
      const relativeName = fileNames ? String(fileNames[i] ?? '').trim() || file.originalname || file.name || 'file' : file.originalname || file.name || 'file';
      const ext = getExtensionAscii(relativeName) || '';
      const fileId = randomAsciiId(8);
      return folderId ? `${folderId}/${fileId}${ext}` : `${fileId}${ext}`;
    });
    if (folderPath) console.log('[SharePoint upload] bucket=', MANUAL_BUCKET, 'folderPath(display)=', folderPath, 'storagePrefix=', folderId, 'supabaseProject=', (SUPABASE_URL || '').replace(/^https:\/\/([^.]+).*/, '$1'));
    const UPLOAD_FILE_TIMEOUT_MS = 10 * 60 * 1000; // 10 min per file
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const relativeName = fileNames ? String(fileNames[i] ?? '').trim() || file.originalname || file.name || 'file' : file.originalname || file.name || 'file';
      const storagePath = storagePaths[i];
      console.log('[SharePoint upload] uploading file', i + 1, '/', files.length, 'path=', storagePath, 'size=', Math.round((file.buffer?.length || 0) / 1024), 'KB');
      let result;
      try {
        result = await Promise.race([
          supabase.storage.from(MANUAL_BUCKET).upload(storagePath, file.buffer, { contentType: file.mimetype || 'application/octet-stream', upsert: true }),
          new Promise((_, rej) => setTimeout(() => rej(new Error('Upload timeout')), UPLOAD_FILE_TIMEOUT_MS))
        ]);
      } catch (raceErr) {
        console.error('[SharePoint upload] FAIL path=', storagePath, 'error=', raceErr.message);
        failed.push({ name: relativeName, error: raceErr.message });
        continue;
      }
      const { error } = result;
      if (error) {
        console.error('[SharePoint upload] FAIL path=', storagePath, 'error=', error.message);
        failed.push({ name: relativeName, error: error.message });
      } else {
        console.log('[SharePoint upload] OK path=', storagePath);
        uploaded.push({ path: storagePath, name: relativeName });
        const fullStoragePath = MANUAL_PREFIX + '/' + storagePath;
        const { data: fileRow, error: insertErr } = await supabase.from('project_files').insert({
          project_id: projectId,
          original_name: relativeName,
          storage_path: fullStoragePath,
          folder_display_name: folderPath || null
        }).select('id').single();
        if (!insertErr && fileRow && hasLocalRag() && isMatriyaIngestible(relativeName)) {
          setImmediate(() => ingestFileInBackground(projectId, fileRow.id, file.buffer, relativeName));
        }
      }
      setProgress(i + 1, files.length, 'files');
    }
    console.log('[SharePoint upload] all files done, saving display names...');
    setProgress(files.length, files.length, 'displayNames');
    if (uploaded.length > 0) {
      for (const u of uploaded) {
        const relativePath = u.path.startsWith(PROJECT_PREFIX)
          ? u.path.slice(`${PROJECT_PREFIX}${projectId}/`.length).trim()
          : (isManualAsciiPath(u.path) ? u.path : '');
        if (!relativePath) continue;
        const relParts = relativePath.split('/').filter(Boolean);
        const fileDisplayName = folderPath ? (folderPath + '/' + u.name).split('/').filter(Boolean).pop() || u.name : u.name;
        const folderDisplayName = folderPath || (relParts.length > 1 ? 'Upload' : '');
        const { error: errFile } = await supabase.from('sharepoint_display_names').upsert(
          { project_id: projectId, path: relativePath, display_name: fileDisplayName, updated_at: new Date().toISOString() },
          { onConflict: 'project_id,path' }
        );
        if (errFile) console.warn('[SharePoint upload] display_name upsert failed (bucket list will show ASCII path):', relativePath, errFile.message);
        if (relParts.length > 1) {
          const folderPathKey = relParts.slice(0, -1).join('/');
          const { error: errFolder } = await supabase.from('sharepoint_display_names').upsert(
            { project_id: projectId, path: folderPathKey, display_name: folderDisplayName, updated_at: new Date().toISOString() },
            { onConflict: 'project_id,path' }
          );
          if (errFolder && process.env.NODE_ENV !== 'production') console.warn('[SharePoint upload] folder display_name upsert failed:', folderPathKey, errFolder.message);
        }
      }
    }
    bucketListCache.files = null;
    bucketListCache.filesExpiresAt = 0;
    bucketListCache.byProject = {};
    const supabaseProjectRef = (SUPABASE_URL || '').match(/https:\/\/([^.]+)\.supabase\.co/)?.[1] || 'unknown';
    console.log('[SharePoint upload] sending response uploaded=', uploaded.length, 'failed=', failed.length);
    if (uploadId) sharepointUploadProgressMap.delete(uploadId);
    const payload = {
      uploaded: uploaded.length,
      failed: failed.length,
      uploaded_paths: uploaded,
      errors: failed.length ? failed : undefined,
      bucket: MANUAL_BUCKET,
      supabase_project: supabaseProjectRef
    };
    if (folderPath && folderId) payload.folderId = folderId;
    if (uploaded.length > 0) scheduleOpenAiVectorSyncForProject(projectId, 'sharepoint-bulk');
    res.status(201).json(payload);
  } catch (e) {
    console.error('[SharePoint upload] route error:', e.message);
    if (uploadId) sharepointUploadProgressMap.delete(uploadId);
    if (!res.headersSent) res.status(500).json({ error: e.message });
  }
});

/** Register uploaded paths (from direct-to-bucket upload) into project_files and trigger Matriya ingest so they can be asked on. */
app.post('/api/projects/:projectId/files/register-and-ingest', async (req, res) => {
  try {
    const ctx = await requireProjectMember(req, res, req.params.projectId);
    if (!ctx) return;
    const projectId = req.params.projectId;
    const paths = req.body?.paths;
    if (!Array.isArray(paths) || paths.length === 0) {
      return res.status(400).json({ error: 'paths array required (e.g. [{ path, name }])' });
    }
    if (!hasLocalRag()) {
      return res.status(503).json({ error: 'RAG not configured – set POSTGRES_URL for document indexing' });
    }
    await ensureManualBucketExists();
    const registered = [];
    const errors = [];
    let registerIngestNewRows = 0;
    for (const item of paths) {
      const path = (item && item.path) ? String(item.path).trim() : '';
      const name = (item && item.name) ? String(item.name).trim() : path.split('/').pop() || 'file';
      if (!path) continue;
      const storagePath = path.startsWith(MANUAL_PREFIX + '/') ? path.slice((MANUAL_PREFIX + '/').length) : path;
      const fullStoragePath = MANUAL_PREFIX + '/' + storagePath;
      try {
        const { data: existing } = await supabase.from('project_files').select('id').eq('project_id', projectId).eq('storage_path', fullStoragePath).limit(1).maybeSingle();
        if (existing) {
          registered.push({ id: existing.id, name });
          continue;
        }
        const { data: blob, error: dlErr } = await supabase.storage.from(MANUAL_BUCKET).download(storagePath);
        if (dlErr || !blob) {
          errors.push({ path, name, error: dlErr?.message || 'Download failed' });
          continue;
        }
        const buffer = Buffer.from(await blob.arrayBuffer());
        const { data: fileRow, error: insertErr } = await supabase.from('project_files').insert({
          project_id: projectId,
          original_name: name,
          storage_path: fullStoragePath,
          folder_display_name: null
        }).select('id').single();
        if (insertErr) {
          errors.push({ path, name, error: insertErr.message });
          continue;
        }
        registered.push({ id: fileRow.id, name });
        registerIngestNewRows += 1;
        if (isMatriyaIngestible(name)) {
          setImmediate(() => ingestFileInBackground(projectId, fileRow.id, buffer, name));
        }
      } catch (e) {
        errors.push({ path, name, error: e.message || String(e) });
      }
    }
    if (registerIngestNewRows > 0) scheduleOpenAiVectorSyncForProject(projectId, 'register-ingest');
    res.status(201).json({ registered: registered.length, registered_ids: registered.map(r => r.id), errors: errors.length ? errors : undefined });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Failed to register and ingest' });
  }
});

const MANUAL_TYPO_BUCKET = 'manualy-uploded-sharepoint-files'; // typo bucket name in Supabase
function resolveBucketAndPath(path) {
  if (path.startsWith(MANUAL_PREFIX + '/')) {
    return { bucket: MANUAL_BUCKET, storagePath: path.slice(MANUAL_PREFIX.length + 1) };
  }
  if (path.startsWith('manual2/')) {
    return { bucket: MANUAL_TYPO_BUCKET, storagePath: path.slice(8) };
  }
  return { bucket: SHAREPOINT_BUCKET, storagePath: path };
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

/**
 * Load project_files from Supabase Storage for outbound email attachments (Resend).
 * Only rows with non-empty storage_path work (SharePoint bucket / manual bucket paths).
 */
async function projectFilesToResendAttachments(projectId, fileIds) {
  const unique = [...new Set(fileIds)];
  if (unique.length > EMAIL_ATTACH_MAX_FILES) {
    throw new Error(`Too many attachments (max ${EMAIL_ATTACH_MAX_FILES})`);
  }
  const attachments = [];
  const meta = [];
  let totalBytes = 0;
  for (const fid of unique) {
    const { data: row, error } = await supabase
      .from('project_files')
      .select('id, original_name, storage_path')
      .eq('project_id', projectId)
      .eq('id', fid)
      .maybeSingle();
    if (error) throw new Error(error.message || 'Database error loading file');
    if (!row) throw new Error('Project file not found or not in this project');
    if (!row.storage_path || !String(row.storage_path).trim()) {
      const label = row.original_name || fid;
      throw new Error(
        `Cannot attach "${label}": no stored file (only documents synced to project storage can be attached to email).`
      );
    }
    const { bucket, storagePath } = resolveBucketAndPath(row.storage_path);
    const { data: blob, error: downloadError } = await supabase.storage.from(bucket).download(storagePath);
    if (downloadError || !blob) {
      throw new Error(`Could not read "${row.original_name || fid}": ${downloadError?.message || 'download failed'}`);
    }
    const buffer = Buffer.from(await blob.arrayBuffer());
    totalBytes += buffer.length;
    if (totalBytes > EMAIL_ATTACH_MAX_TOTAL_BYTES) {
      throw new Error('Attachments exceed maximum total size (24 MB).');
    }
    const filename = row.original_name || storagePath.split('/').pop() || 'attachment';
    attachments.push({
      filename,
      content: buffer.toString('base64'),
      content_type: guessMimeFromFilename(filename)
    });
    meta.push({ filename, project_file_id: row.id });
  }
  return { attachments, meta, totalBytes };
}

app.post('/api/projects/:projectId/files/from-bucket', async (req, res) => {
  try {
    const projectId = req.params.projectId;
    const ctx = await requireProjectMember(req, res, projectId);
    if (!ctx) return;
    const path = req.body?.path;
    if (!path || typeof path !== 'string') return res.status(400).json({ error: 'path is required' });
    const { bucket, storagePath } = resolveBucketAndPath(path);
    let displayName = req.body?.displayName;
    if (!displayName || typeof displayName !== 'string') {
      const mapping = bucket === SHAREPOINT_BUCKET ? await getBucketNameMapping() : {};
      displayName = mapping[path] || path.split('/').pop() || path || 'file';
    }
    const { data: blob, error: downloadError } = await supabase.storage.from(bucket).download(storagePath);
    if (downloadError || !blob) return res.status(404).json({ error: downloadError?.message || 'File not found in bucket' });
    const buffer = Buffer.from(await blob.arrayBuffer());
    const originalName = displayName;

    const folderDisplayName = req.body?.folder_display_name != null ? String(req.body.folder_display_name).trim() || null : null;
    const { data: row, error } = await supabase.from('project_files').insert({
      project_id: projectId,
      original_name: originalName,
      storage_path: path,
      folder_display_name: folderDisplayName || null
    }).select().single();
    if (error) throw error;
    auditLog(projectId, ctx.user.id, ctx.user.username, 'create', 'project_file', row.id, { original_name: originalName, source: 'sharepoint_bucket' }, req.requestId);

    res.status(201).json(row);
    if (hasLocalRag()) {
      setImmediate(() => ingestFileInBackground(projectId, row.id, buffer, originalName));
    }
    if (row.storage_path) scheduleOpenAiVectorSyncForProject(projectId, 'from-bucket');
  } catch (e) {
    res.status(e.response?.status || 500).json({ error: e.response?.data?.error || e.message });
  }
});

app.get('/api/projects/:projectId/files/:fileId/download', async (req, res) => {
  try {
    const ctx = await requireProjectMember(req, res, req.params.projectId);
    if (!ctx) return;
    const { projectId, fileId } = req.params;
    const { data: row, error } = await supabase.from('project_files').select('original_name, storage_path').eq('id', fileId).eq('project_id', projectId).single();
    if (error || !row) return res.status(404).json({ error: 'File not found' });
    if (!row.storage_path) return res.status(404).json({ error: 'Download not available for this file (not from SharePoint bucket)' });
    const { bucket, storagePath } = resolveBucketAndPath(row.storage_path);
    const { data: blob, error: downloadError } = await supabase.storage.from(bucket).download(storagePath);
    if (downloadError || !blob) return res.status(404).json({ error: downloadError?.message || 'File not found in storage' });
    const buffer = Buffer.from(await blob.arrayBuffer());
    const filename = row.original_name || row.storage_path.split('/').pop() || 'download';
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.send(buffer);
  } catch (e) {
    res.status(e.response?.status || 500).json({ error: e.response?.data?.error || e.message });
  }
});

// ---------- GPT RAG (OpenAI vector stores + Responses API file_search) ----------
function openAiJsonHeaders() {
  return { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' };
}

function openAiVectorStoreHeaders() {
  return {
    Authorization: `Bearer ${OPENAI_API_KEY}`,
    'Content-Type': 'application/json',
    'OpenAI-Beta': 'assistants=v2'
  };
}

function extractOpenAiResponsesOutputText(data) {
  if (!data || typeof data !== 'object') return '';
  if (typeof data.output_text === 'string' && data.output_text.trim()) return data.output_text.trim();
  const out = data.output;
  if (!Array.isArray(out)) return '';
  const parts = [];
  for (const item of out) {
    if (item.type === 'message' && Array.isArray(item.content)) {
      for (const c of item.content) {
        if (c && typeof c.text === 'string' && (c.type === 'output_text' || c.type === 'text')) parts.push(c.text);
      }
    }
  }
  return parts.join('\n\n').trim();
}

/** From Responses API when `include: ['file_search_call.results']` — evidence for UI quotes. */
function collectFileSearchSnippetsFromResponse(data) {
  const chunks = [];
  const out = data?.output;
  if (!Array.isArray(out)) return chunks;
  for (const item of out) {
    if (item.type !== 'file_search_call') continue;
    const results = item.results || item.search_results || item.content || [];
    const list = Array.isArray(results) ? results : [];
    for (const r of list) {
      const text =
        (typeof r === 'string' && r) ||
        r.text ||
        r.content ||
        r.chunk ||
        r.snippet ||
        '';
      const fname =
        r.filename ||
        r.file_name ||
        (r.file && (r.file.filename || r.file.name)) ||
        r.name ||
        'Unknown';
      if (text && String(text).trim()) {
        chunks.push({ filename: String(fname), text: String(text).trim() });
      }
    }
  }
  return chunks;
}

const GPT_RAG_SOURCE_EXCERPT_MAX = 4000;
const GPT_RAG_SOURCES_UI_MAX = 6;

function tokenizeGptRagEvidence(text) {
  if (!text || typeof text !== 'string') return [];
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length >= 2)
    .slice(0, 80);
}

function scoreGptRagSnippet(snippetLower, queryToks, answerToks) {
  let s = 0;
  for (const t of queryToks) {
    if (t.length >= 2 && snippetLower.includes(t)) s += 2;
  }
  for (const t of answerToks) {
    if (t.length >= 3 && snippetLower.includes(t)) s += 1;
  }
  return s;
}

/** Dedupe, rank by overlap with user query and model answer, cap for UI (same idea as matriya-back). */
function dedupeAndCapSources(snippets, query = '', answerText = '', maxItems = GPT_RAG_SOURCES_UI_MAX) {
  const cap = Math.max(1, maxItems);
  const list = Array.isArray(snippets) ? snippets : [];
  const seen = new Set();
  const deduped = [];
  let ord = 0;
  for (const s of list) {
    const fn = String(s.filename || 'Unknown');
    const raw = String(s.text || '').trim();
    if (!raw) continue;
    const key = `${fn}\0${raw.slice(0, 120)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push({ filename: fn, text: raw, _i: ord++ });
  }
  const qt = tokenizeGptRagEvidence(query);
  const at = tokenizeGptRagEvidence(answerText).slice(0, 50);
  let picked;
  if (qt.length === 0 && at.length === 0) {
    picked = deduped.slice(0, cap);
  } else {
    const scored = deduped.map((row) => ({
      ...row,
      sc: scoreGptRagSnippet(row.text.toLowerCase(), qt, at)
    }));
    scored.sort((a, b) => b.sc - a.sc || a._i - b._i);
    const best = scored[0]?.sc ?? 0;
    if (best <= 0) {
      picked = deduped.slice(0, cap);
    } else {
      const floor = Math.max(1, best * 0.35);
      const strong = scored.filter((x) => x.sc >= floor);
      const pool = strong.length ? strong : scored;
      picked = pool.slice(0, cap);
    }
  }
  return picked.map((row) => {
    const excerpt =
      row.text.length > GPT_RAG_SOURCE_EXCERPT_MAX
        ? `${row.text.slice(0, GPT_RAG_SOURCE_EXCERPT_MAX)}…`
        : row.text;
    return { filename: row.filename, excerpt };
  });
}

/**
 * Ensures file_search uses only this project's store: DB already maps project → vs id;
 * OpenAI metadata.project_id must match (set on sync). Blocks wrong-project IDs in DB.
 */
async function verifyOpenAiVectorStoreMatchesProject(vectorStoreId, projectId) {
  let r;
  try {
    r = await axios.get(`${OPENAI_API_BASE}/vector_stores/${vectorStoreId}`, {
      headers: openAiVectorStoreHeaders(),
      timeout: 30000
    });
  } catch (e) {
    if (e.response?.status === 404) {
      const err = new Error('GPT vector store was deleted or is invalid. Sync project files to OpenAI again.');
      err.statusCode = 400;
      throw err;
    }
    throw e;
  }
  const meta = r.data?.metadata;
  if (meta && typeof meta === 'object' && meta.project_id != null && String(meta.project_id) !== String(projectId)) {
    const err = new Error('GPT vector store is not registered for this project. Sync again from the Documents tab.');
    err.statusCode = 403;
    throw err;
  }
}

app.get('/api/projects/:projectId/gpt-rag/status', limiterRag, async (req, res) => {
  try {
    const projectId = req.params.projectId;
    const ctx = await requireProjectMember(req, res, projectId);
    if (!ctx) return;
    if (!OPENAI_API_KEY) {
      return res.json({ configured: false, openai: false, reason: 'OPENAI_API_KEY not set on server' });
    }
    const { data: project, error } = await supabase.from('projects').select('id, openai_vector_store_id').eq('id', projectId).single();
    if (error || !project) return res.status(404).json({ error: 'Project not found' });
    const vsId = project.openai_vector_store_id;
    if (!vsId) {
      return res.json({ configured: true, openai: true, vector_store_id: null, vector_store_status: null });
    }
    try {
      const r = await axios.get(`${OPENAI_API_BASE}/vector_stores/${vsId}`, { headers: openAiVectorStoreHeaders(), timeout: 30000 });
      return res.json({
        configured: true,
        openai: true,
        vector_store_id: vsId,
        vector_store_status: r.data?.status || null,
        file_counts: r.data?.file_counts || null
      });
    } catch (e) {
      return res.json({
        configured: true,
        openai: true,
        vector_store_id: vsId,
        vector_store_status: 'unknown',
        warning: e.response?.data?.error?.message || e.message
      });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/projects/:projectId/gpt-rag/sync', limiterRag, async (req, res) => {
  try {
    const projectId = req.params.projectId;
    const ctx = await requireProjectMember(req, res, projectId);
    if (!ctx) return;
    if (!OPENAI_API_KEY) return res.status(503).json({ error: 'OPENAI_API_KEY not set on server' });

    const result = await syncProjectGptRagToOpenAI(supabase, projectId, {
      openaiApiKey: OPENAI_API_KEY,
      openaiBase: OPENAI_API_BASE
    });
    if (!result.ok) {
      return res.status(result.status).json({
        error: result.error,
        skipped: result.skipped,
        uploaded: result.uploaded,
        batch_id: result.batch_id
      });
    }
    res.json({
      ok: true,
      vector_store_id: result.vector_store_id,
      uploaded: result.uploaded,
      incremental: Boolean(result.incremental),
      skipped: result.skipped,
      batch_status: result.batch_status
    });
  } catch (e) {
    console.error('[gpt-rag/sync]', e.response?.data || e.message);
    res.status(500).json({ error: e.response?.data?.error?.message || e.message || 'Sync failed' });
  }
});

app.post('/api/projects/:projectId/gpt-rag/query', limiterRag, async (req, res) => {
  try {
    const projectId = req.params.projectId;
    const ctx = await requireProjectMember(req, res, projectId);
    if (!ctx) return;
    if (!OPENAI_API_KEY) return res.status(503).json({ error: 'OPENAI_API_KEY not set on server' });
    const q = (req.body && String(req.body.query || '').trim()) || '';
    if (!q) return res.status(400).json({ error: 'query is required' });

    const { data: project, error } = await supabase.from('projects').select('openai_vector_store_id').eq('id', projectId).single();
    if (error || !project) return res.status(404).json({ error: 'Project not found' });
    const vsId = project.openai_vector_store_id;
    if (!vsId) return res.status(400).json({ error: 'No GPT vector store yet. Sync project files to OpenAI from the Documents tab first.' });

    try {
      await verifyOpenAiVectorStoreMatchesProject(vsId, projectId);
    } catch (verErr) {
      const st = verErr.statusCode || 500;
      return res.status(st).json({ error: verErr.message || 'Vector store verification failed' });
    }

    const { data: catalogRows } = await supabase
      .from('project_files')
      .select('original_name, storage_path')
      .eq('project_id', projectId)
      .order('created_at', { ascending: false })
      .limit(200);
    const catalogAppendix = buildProjectFileCatalogAppendix(catalogRows || []);

    // Single vector store for this project only (sync uploads only project_files for this project_id).
    const payload = {
      model: OPENAI_RAG_MODEL,
      instructions: GPT_RAG_QUERY_INSTRUCTIONS,
      input: q + catalogAppendix,
      tools: [{ type: 'file_search', vector_store_ids: [vsId], max_num_results: 24 }],
      include: ['file_search_call.results']
    };

    const r = await axios.post(`${OPENAI_API_BASE}/responses`, payload, {
      headers: openAiJsonHeaders(),
      timeout: 120000
    });

    const text = extractOpenAiResponsesOutputText(r.data);
    const rawSnippets = collectFileSearchSnippetsFromResponse(r.data);
    const sources = dedupeAndCapSources(rawSnippets, q, text);
    res.json({
      run_id: r.data?.id || crypto.randomUUID(),
      outputs: { synthesis: text, research: text, analysis: text },
      justifications: [],
      sources
    });
  } catch (e) {
    console.error('[gpt-rag/query]', e.response?.data || e.message);
    res.status(e.response?.status || 500).json({ error: e.response?.data?.error?.message || e.message || 'Query failed' });
  }
});

// ---------- RAG (proxy to Matriya back) ----------
function ragConnectionErrorMessage(e) {
  const code = e.code || '';
  const status = e.response?.status;
  if (code === 'ECONNRESET') return 'החיבור למטריה נותק. ייתכן שהבקשה לוקחת יותר מדי זמן או שמטריה התאתחלה. נסה שוב.';
  if (code === 'ETIMEDOUT') return 'הבקשה למטריה עברה timeout. נסה שוב או קצר את השאלה.';
  if (code === 'ECONNREFUSED' || code === 'ENOTFOUND') return 'לא ניתן להתחבר למטריה. וודא שמטריה פועלת ו־MATRIYA_BACK_URL נכון.';
  if (status === 502 || status === 503 || status === 504) return 'מטריה לא זמינה כרגע (שגיאת שרת). וודא ש־matriya-back פועל והמסד נתונים מוגדר. נסה שוב.';
  return e.response?.data?.error || e.message;
}
function ragConnectionStatus(e) {
  const code = e.code || '';
  if (code === 'ECONNRESET' || code === 'ETIMEDOUT') return 502;
  if (code === 'ECONNREFUSED' || code === 'ENOTFOUND') return 503;
  const status = e.response?.status;
  if (status === 502 || status === 503 || status === 504) return status;
  return status || 500;
}

app.get('/api/rag/files', async (req, res) => {
  if (!hasLocalRag()) return res.json({ files: [] });
  try {
    const rag = await getLocalRag();
    const files = rag ? await rag.getAllFilenames() : [];
    res.json({ files: files || [] });
  } catch (e) {
    console.warn('[RAG] files list error:', e.message);
    res.json({ files: [] });
  }
});

app.get('/api/rag/health', async (req, res) => {
  if (!hasLocalRag()) return res.json({ ok: false, error: 'Set POSTGRES_URL for RAG (management vector DB)' });
  try {
    const rag = await getLocalRag();
    const info = rag ? await rag.getCollectionInfo() : null;
    const ok = !!info;
    if (ok) console.log('[RAG] health', { ok: true, document_count: info.document_count });
    else console.log('[RAG] health', { ok: false });
    res.json({
      ok,
      vector_db: info ? { document_count: info.document_count, collection_name: info.collection_name, db_path: info.db_path } : null
    });
  } catch (e) {
    console.log('[RAG] health error', e.message);
    res.json({ ok: false, error: e.message });
  }
});

app.post('/api/rag/search', async (req, res) => {
  if (!hasLocalRag()) return res.status(503).json({ error: 'Set POSTGRES_URL for RAG' });
  try {
    const { query, n_results = 10, generate_answer, filename } = req.body || {};
    const rag = await getLocalRag();
    if (!rag) return res.status(503).json({ error: 'RAG not available' });
    const filterMetadata = filename && typeof filename === 'string' && filename.trim() ? { filename: filename.trim() } : null;
    if (generate_answer) {
      const out = await rag.generateAnswer(query || '', n_results, filterMetadata, true);
      return res.json({ results: out.results, answer: out.answer, context: out.context });
    }
    const results = await rag.search(query || '', n_results, filterMetadata);
    res.json({ results });
  } catch (e) {
    console.error('[RAG] search error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/rag/research/run', async (req, res) => {
  if (!hasLocalRag()) return res.status(503).json({ error: 'Set POSTGRES_URL for RAG' });
  const body = req.body || {};
  const query = (body.query || '').trim();
  let filenamesArray = Array.isArray(body.filenames) && body.filenames.length > 0 ? body.filenames.filter(f => typeof f === 'string' && f.trim()) : null;
  if (!filenamesArray?.length && body.filename && typeof body.filename === 'string' && body.filename.trim()) {
    const trimmed = body.filename.trim();
    const base = path.basename(trimmed);
    filenamesArray = base !== trimmed ? [trimmed, base] : [trimmed];
  }
  const filterMetadata = filenamesArray?.length ? { filenames: filenamesArray } : null;
  if (!query) return res.status(400).json({ error: 'query is required' });
  try {
    const rag = await getLocalRag();
    if (!rag) return res.status(503).json({ error: 'RAG not available' });
    const out = await rag.generateAnswer(query, 20, filterMetadata, true);
    let synthesis = out.answer || '';
    if (!synthesis && (filterMetadata?.filename || filterMetadata?.filenames)) {
      const indexedSet = new Set(await rag.getAllFilenames());
      const requested = filenamesArray || [];
      const notIndexed = requested.filter(f => !indexedSet.has(f));
      if (notIndexed.length) {
        synthesis = 'הקובץ שנבחר לא באינדוקס (פורמט לא נתמך או טרם עובד). בחר "כל הקבצים" או קובץ אחר מהרשימה.';
      } else {
        synthesis = 'לא נמצא תוכן במערכת עבור הקובץ שנבחר. נסה לבחור "כל הקבצים" או להריץ שוב את סקריפט האינדוקס.';
      }
    } else if (!synthesis) {
      synthesis = 'לא נמצא תוכן במערכת. ייתכן שקבצים טרם עובדו (אינדוקס). וודא שהקבצים הועלו והריץ את סקריפט האינדוקס.';
    }
    res.json({
      run_id: crypto.randomUUID(),
      outputs: { synthesis, research: synthesis, analysis: synthesis },
      justifications: []
    });
  } catch (e) {
    console.error('[RAG] research/run error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/rag/research/session', async (req, res) => {
  res.json({ session_id: crypto.randomUUID() });
});

// ---------- Health ----------
app.get('/health', async (req, res) => {
  const start = Date.now();
  let db_status = 'disconnected';
  try {
    const { error } = await supabase.from('projects').select('id').limit(1);
    db_status = error ? 'disconnected' : 'connected';
  } catch (_) {}
  const response_time_ms = Date.now() - start;
  res.json({
    ok: db_status === 'connected',
    service: 'maneger-back',
    db_status,
    response_time_ms
  });
});

// Vercel uses this as the serverless handler; locally we start the HTTP server
if (!process.env.VERCEL) {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Maneger API running on http://0.0.0.0:${PORT}`);
    if (!hasLocalRag()) console.warn('POSTGRES_URL not set – RAG (document Q&A) disabled. Set POSTGRES_URL to use management_vector.');
  });
}
export default app;
