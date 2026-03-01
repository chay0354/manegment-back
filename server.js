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
  limits: { fileSize: 50 * 1024 * 1024 }
});

// Pagination: ?limit=50&offset=0 (limit 1–100, default 50)
function parsePagination(req) {
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50));
  const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
  return { limit, offset };
}

// Root (for Vercel / health checks)
app.get('/', (req, res) => res.json({ service: 'maneger-back', health: '/health', api: '/api' }));

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
  const opts = { method, url, headers, timeout: 15000 };
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
      if (statusFromMatriya != null) {
        return res.status(statusFromMatriya).json(typeof bodyFromMatriya === 'object' ? bodyFromMatriya : { error: e.message });
      }
      if (code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'ETIMEDOUT') {
        return res.status(503).json({ error: 'Cannot reach Matriya. Is it running? Check MATRIYA_BACK_URL in .env.' });
      }
      res.status(500).json({ error: bodyFromMatriya?.error || e.message || 'Auth request failed' });
    });
}

app.post('/api/auth/login', (req, res) => forwardAuth('POST', '/login', req, res));
app.post('/api/auth/signup', (req, res) => forwardAuth('POST', '/signup', req, res));
app.get('/api/auth/me', (req, res) => {
  if (!MATRIYA_BACK_URL) return res.status(503).json({ error: 'MATRIYA_BACK_URL not set' });
  const url = `${MATRIYA_BACK_URL}/auth/me`;
  const headers = { 'Content-Type': 'application/json' };
  if (req.headers.authorization) headers.Authorization = req.headers.authorization;
  axios({ method: 'GET', url, headers, timeout: 15000 })
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
      timeout: 8000
    });
    if (r.data && r.data.id != null) return r.data;
  } catch (e) {
    /* ignore */
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
  try {
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
          timeout: 120000,
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
      timeout: 120000,
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
app.get('/health', (req, res) => res.json({ ok: true, service: 'maneger-back' }));

// Vercel uses this as the serverless handler; locally we start the HTTP server
if (!process.env.VERCEL) {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Maneger API running on http://0.0.0.0:${PORT}`);
    if (!MATRIYA_BACK_URL) console.warn('MATRIYA_BACK_URL not set – RAG features disabled');
  });
}
export default app;
