/**
 * Project Manager API – Express + Supabase.
 * Features: projects, tasks, milestones, documents, notes, file upload (→ Matriya), RAG (proxy to Matriya back).
 */
import 'dotenv/config';
import crypto from 'crypto';
import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import multer from 'multer';
import { createClient } from '@supabase/supabase-js';
import axios from 'axios';
import FormData from 'form-data';
import { z } from 'zod';
import * as XLSX from 'xlsx';

const PORT = parseInt(process.env.PORT, 10) || 8001;
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const MATRIYA_BACK_URL = (process.env.MATRIYA_BACK_URL || '').replace(/\/$/, '');
const SHAREPOINT_TENANT_ID = process.env.SHAREPOINT_TENANT_ID || '';
const SHAREPOINT_CLIENT_ID = process.env.SHAREPOINT_CLIENT_ID || '';
const SHAREPOINT_CLIENT_SECRET = process.env.SHAREPOINT_CLIENT_SECRET || '';

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

const app = express();
app.set('trust proxy', 1); // Vercel sends X-Forwarded-For; required for express-rate-limit to identify clients correctly
// Full CORS: allow any origin, all methods, all headers (so any URL can call the API)
function corsHeaders(req, res, next) {
  const origin = req.headers.origin;
  res.setHeader('Access-Control-Allow-Origin', origin || '*');
  res.setHeader('Access-Control-Allow-Credentials', origin ? 'true' : 'false');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Max-Age', '86400');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
}
app.use(corsHeaders);
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '1mb' }));

// Request ID for audit (actor, entity, action, before/after, request_id)
app.use((req, res, next) => {
  req.requestId = req.headers['x-request-id'] || crypto.randomUUID();
  next();
});

// Rate limiting: auth strict, upload/chat/rag moderate, general API relaxed
const limiterAuth = rateLimit({ windowMs: 60 * 1000, max: 20, message: { error: 'Too many auth attempts' } });
const limiterUpload = rateLimit({ windowMs: 60 * 1000, max: 15, message: { error: 'Too many uploads' } });
const limiterSharePoint = rateLimit({ windowMs: 60 * 1000, max: 5, message: { error: 'Too many SharePoint pull requests' } });
const limiterRag = rateLimit({ windowMs: 60 * 1000, max: 30, message: { error: 'Too many RAG requests' } });
const limiterGeneral = rateLimit({ windowMs: 60 * 1000, max: 200, message: { error: 'Too many requests' } });
app.use('/api/auth', limiterAuth);
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
    const access = await getProjectAccess(projectId, user?.id);
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
    const access = await getProjectAccess(projectId, user?.id);
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
    const access = await getProjectAccess(projectId, user.id);
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
app.get('/api/projects/:id/chat', async (req, res) => {
  try {
    const user = await getCurrentUser(req);
    const projectId = req.params.id;
    const { data: project } = await supabase.from('projects').select('id').eq('id', projectId).single();
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const hasMembers = await projectHasMembers(projectId);
    const access = hasMembers ? await getProjectAccess(projectId, user?.id) : { canAccess: !!user, role: user ? 'owner' : null };
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
    const access = hasMembers ? await getProjectAccess(projectId, user.id) : { canAccess: true, role: 'owner' };
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
    const { data, error } = await supabase.from('tasks').insert({
      project_id: req.params.projectId,
      title: title.trim(),
      status: status || 'todo',
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

app.post('/api/auth/login', (req, res) => forwardAuth('POST', '/login', req, res));
app.post('/api/auth/signup', (req, res) => forwardAuth('POST', '/signup', req, res));
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

async function getProjectAccess(projectId, userId) {
  if (!userId) return { canAccess: false, role: null, hasPendingRequest: false };
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
  const access = hasMembers ? await getProjectAccess(projectId, user.id) : { canAccess: !!user, role: user ? 'owner' : null };
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
const TASK_STATUS_TRANSITIONS = {
  todo: ['in_progress', 'cancelled'],
  in_progress: ['todo', 'in_review', 'cancelled'],
  in_review: ['in_progress', 'done', 'cancelled'],
  done: [],
  cancelled: []
};
function isAllowedTaskStatusTransition(fromStatus, toStatus) {
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
    const firstSheet = wb.SheetNames[0];
    if (!firstSheet) return res.status(400).json({ error: 'Excel file has no sheets' });
    const ws = wb.Sheets[firstSheet];
    const rows = XLSX.utils.sheet_to_json(ws, { defval: '', raw: false });
    if (!rows.length) return res.status(201).json({ created: 0, updated: 0, error_count: 0, source_file_reference: req.file.originalname || 'excel' });

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

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const eid = col(row, 'experiment_id', 'experiment id', 'id');
      if (!eid) { errCount++; details.errors.push({ row: i + 2, reason: 'experiment_id required' }); continue; }
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
        if (upErr) { errCount++; details.errors.push({ row: i + 2, experiment_id: payload.experiment_id, reason: upErr.message }); continue; }
        updated++;
      } else {
        const { error: insErr } = await supabase.from('lab_experiments').insert(payload);
        if (insErr) { errCount++; details.errors.push({ row: i + 2, experiment_id: payload.experiment_id, reason: insErr.message }); continue; }
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

async function logAnalysis(projectId, analysisType, inputRef, result, requestId) {
  try {
    await supabase.from('analysis_log').insert({
      project_id: projectId,
      analysis_type: analysisType,
      input_ref: inputRef || null,
      result: result || {},
      request_id: requestId || null
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
    await logAnalysis(projectId, 'formulation_intelligence', null, result, req.requestId);
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

    const experiments = await getExperimentsForAnalysis(projectId);
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(experimentIdParam);
    const source = experiments.find(e => isUuid ? e.id === experimentIdParam : e.experiment_id === experimentIdParam);
    if (!source) return res.status(404).json({ error: 'Experiment not found' });

    const withScore = experiments
      .filter(e => e.id !== source.id && e.experiment_id !== source.experiment_id)
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
    await logAnalysis(projectId, 'similar_experiments', source.experiment_id, result, req.requestId);
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
app.get('/api/projects/:projectId/files', async (req, res) => {
  try {
    const ctx = await requireProjectMember(req, res, req.params.projectId);
    if (!ctx) return;
    const { limit, offset } = parsePagination(req);
    const { data, error } = await supabase.from('project_files').select('*').eq('project_id', req.params.projectId).order('created_at', { ascending: false }).range(offset, offset + limit - 1);
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
  if (!MATRIYA_BACK_URL) {
    return res.status(503).json({ error: 'MATRIYA_BACK_URL not set – cannot ingest files' });
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
        const form = new FormData();
        form.append('file', buffer, { filename: originalName });
        const ingestRes = await axios.post(`${MATRIYA_BACK_URL}/ingest/file`, form, {
          timeout: 180000,
          maxContentLength: Infinity,
          maxBodyLength: Infinity,
          headers: form.getHeaders()
        });
        if (!ingestRes.data?.success) {
          failed.push({ name: originalName, error: ingestRes.data?.error || 'Ingestion failed' });
          continue;
        }
        const { data: row, error } = await supabase.from('project_files').insert({
          project_id: projectId,
          original_name: originalName
        }).select().single();
        if (error) {
          failed.push({ name: originalName, error: error.message });
          continue;
        }
        auditLog(projectId, ctx.user.id, ctx.user.username, 'create', 'project_file', row.id, { original_name: originalName, source: 'sharepoint' }, req.requestId);
        ingested.push({ id: row.id, original_name: originalName });
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
  if (!MATRIYA_BACK_URL) {
    return res.status(503).json({ error: 'MATRIYA_BACK_URL not set – cannot ingest files' });
  }
  const file = req.file;
  const utf8Name = req.body && typeof req.body.originalName === 'string' && req.body.originalName.trim();
  const originalName = (utf8Name ? req.body.originalName.trim() : null) || file.originalname || 'file';
  try {
    const form = new FormData();
    form.append('file', file.buffer, { filename: originalName });
    const r = await axios.post(`${MATRIYA_BACK_URL}/ingest/file`, form, {
      timeout: 180000,
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
      headers: form.getHeaders()
    });
    if (!r.data || !r.data.success) {
      return res.status(500).json({ error: r.data?.error || 'Matriya ingestion failed' });
    }
    const { data, error } = await supabase.from('project_files').insert({
      project_id: projectId,
      original_name: originalName
    }).select().single();
    if (error) throw error;
    auditLog(projectId, ctx.user.id, ctx.user.username, 'create', 'project_file', data.id, { original_name: originalName }, req.requestId);
    res.status(201).json(data);
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
    res.status(201).json(payload);
  } catch (e) {
    console.error('[SharePoint upload] route error:', e.message);
    if (uploadId) sharepointUploadProgressMap.delete(uploadId);
    if (!res.headersSent) res.status(500).json({ error: e.message });
  }
});

function resolveBucketAndPath(path) {
  if (path.startsWith(MANUAL_PREFIX + '/')) {
    return { bucket: MANUAL_BUCKET, storagePath: path.slice(MANUAL_PREFIX.length + 1) };
  }
  return { bucket: SHAREPOINT_BUCKET, storagePath: path };
}

app.post('/api/projects/:projectId/files/from-bucket', async (req, res) => {
  try {
    const projectId = req.params.projectId;
    const ctx = await requireProjectMember(req, res, projectId);
    if (!ctx) return;
    const path = req.body?.path;
    if (!path || typeof path !== 'string') return res.status(400).json({ error: 'path is required' });
    if (!MATRIYA_BACK_URL) return res.status(503).json({ error: 'MATRIYA_BACK_URL not set' });
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
    const form = new FormData();
    form.append('file', buffer, { filename: originalName });
    const ingestRes = await axios.post(`${MATRIYA_BACK_URL}/ingest/file`, form, {
      timeout: 180000,
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
      headers: form.getHeaders()
    });
    if (!ingestRes.data?.success) return res.status(500).json({ error: ingestRes.data?.error || 'Matriya ingestion failed' });
    const { data: row, error } = await supabase.from('project_files').insert({
      project_id: projectId,
      original_name: originalName,
      storage_path: path
    }).select().single();
    if (error) throw error;
    auditLog(projectId, ctx.user.id, ctx.user.username, 'create', 'project_file', row.id, { original_name: originalName, source: 'sharepoint_bucket' }, req.requestId);
    res.status(201).json(row);
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

app.get('/api/rag/health', async (req, res) => {
  if (!MATRIYA_BACK_URL) return res.json({ ok: false, error: 'MATRIYA_BACK_URL not set' });
  try {
    const r = await axios.get(`${MATRIYA_BACK_URL}/health`, { timeout: 5000 }).catch(() => null);
    res.json({ ok: !!r, matriya_url: MATRIYA_BACK_URL });
  } catch (e) {
    res.json({ ok: false, error: e.message, matriya_url: MATRIYA_BACK_URL });
  }
});

app.post('/api/rag/search', async (req, res) => {
  if (!MATRIYA_BACK_URL) return res.status(503).json({ error: 'MATRIYA_BACK_URL not set' });
  try {
    const { query, n_results, session_id, stage, generate_answer, filename } = req.body || {};
    const params = new URLSearchParams();
    if (query) params.set('query', query);
    if (n_results != null) params.set('n_results', n_results);
    if (session_id) params.set('session_id', session_id);
    if (stage) params.set('stage', stage);
    if (generate_answer !== undefined) params.set('generate_answer', generate_answer);
    if (filename) params.set('filename', filename);
    const url = `${MATRIYA_BACK_URL}/search?${params.toString()}`;
    const forwardHeaders = {};
    if (req.headers.authorization) forwardHeaders.Authorization = req.headers.authorization;
    const r = await axios.get(url, { timeout: 60000, headers: forwardHeaders });
    res.json(r.data);
  } catch (e) {
    console.error('GET /api/rag/search → Matriya error:', e.code || e.message, e.response?.status);
    const status = ragConnectionStatus(e);
    const message = ragConnectionErrorMessage(e);
    res.status(status).json(typeof (e.response?.data) === 'object' && e.response?.data !== null ? { ...e.response.data, error: message } : { error: message });
  }
});

app.post('/api/rag/research/run', async (req, res) => {
  if (!MATRIYA_BACK_URL) return res.status(503).json({ error: 'MATRIYA_BACK_URL not set' });
  try {
    const forwardHeaders = {};
    if (req.headers.authorization) forwardHeaders.Authorization = req.headers.authorization;
    const r = await axios.post(`${MATRIYA_BACK_URL}/api/research/run`, req.body || {}, { timeout: 120000, headers: { 'Content-Type': 'application/json', ...forwardHeaders } });
    res.json(r.data);
  } catch (e) {
    console.error('POST /api/rag/research/run → Matriya error:', e.code || e.message, e.response?.status);
    const status = ragConnectionStatus(e);
    const message = ragConnectionErrorMessage(e);
    res.status(status).json(typeof (e.response?.data) === 'object' && e.response?.data !== null ? { ...e.response.data, error: message } : { error: message });
  }
});

app.post('/api/rag/research/session', async (req, res) => {
  if (!MATRIYA_BACK_URL) return res.status(503).json({ error: 'MATRIYA_BACK_URL not set' });
  try {
    const forwardHeaders = {};
    if (req.headers.authorization) forwardHeaders.Authorization = req.headers.authorization;
    const r = await axios.post(`${MATRIYA_BACK_URL}/research/session`, req.body || {}, { timeout: 10000, headers: { 'Content-Type': 'application/json', ...forwardHeaders } });
    res.json(r.data);
  } catch (e) {
    console.error('POST /api/rag/research/session → Matriya error:', e.code || e.message, e.response?.status);
    const status = ragConnectionStatus(e);
    const message = ragConnectionErrorMessage(e);
    res.status(status).json(typeof (e.response?.data) === 'object' && e.response?.data !== null ? { ...e.response.data, error: message } : { error: message });
  }
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
    if (!MATRIYA_BACK_URL) console.warn('MATRIYA_BACK_URL not set – RAG features disabled');
  });
}
export default app;
