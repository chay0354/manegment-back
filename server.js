/**
 * Project Manager API – Express + Supabase.
 * Features: projects, tasks, milestones, documents, notes, file upload (→ Matriya), RAG (proxy to Matriya back).
 */
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import { createClient } from '@supabase/supabase-js';
import axios from 'axios';
import FormData from 'form-data';

const PORT = parseInt(process.env.PORT, 10) || 8001;
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const MATRIYA_BACK_URL = (process.env.MATRIYA_BACK_URL || '').replace(/\/$/, '');

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

const app = express();
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }
});

// Root (for Vercel / health checks)
app.get('/', (req, res) => res.json({ service: 'maneger-back', health: '/health', api: '/api' }));

// ---------- Projects ----------
app.get('/api/projects', async (req, res) => {
  try {
    const { data, error } = await supabase.from('projects').select('*').order('updated_at', { ascending: false });
    if (error) throw error;
    res.json({ projects: data || [] });
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
    const { name, description } = req.body || {};
    const updates = { updated_at: new Date().toISOString() };
    if (name !== undefined) updates.name = name.trim();
    if (description !== undefined) updates.description = description.trim() || null;
    const { data, error } = await supabase.from('projects').update(updates).eq('id', req.params.id).select().single();
    if (error) throw error;
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
    const { data, error } = await supabase.from('project_chat_messages').select('*').eq('project_id', projectId).order('created_at', { ascending: true });
    if (error) {
      if (String(error.message || '').includes('does not exist') || String(error.message || '').includes('relation')) {
        return res.json({ messages: [] });
      }
      throw error;
    }
    res.json({ messages: data || [] });
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
    res.status(201).json(row);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- Tasks ----------
app.get('/api/projects/:projectId/tasks', async (req, res) => {
  try {
    const { data, error } = await supabase.from('tasks').select('*').eq('project_id', req.params.projectId).order('created_at', { ascending: false });
    if (error) throw error;
    res.json({ tasks: data || [] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/projects/:projectId/tasks', async (req, res) => {
  try {
    const { title, status, priority, due_date } = req.body || {};
    if (!title || !title.trim()) return res.status(400).json({ error: 'title is required' });
    const { data, error } = await supabase.from('tasks').insert({
      project_id: req.params.projectId,
      title: title.trim(),
      status: status || 'todo',
      priority: priority || 'medium',
      due_date: due_date || null
    }).select().single();
    if (error) throw error;
    res.status(201).json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.patch('/api/projects/:projectId/tasks/:taskId', async (req, res) => {
  try {
    const { title, status, priority, due_date } = req.body || {};
    const updates = {};
    if (title !== undefined) updates.title = title.trim();
    if (status !== undefined) updates.status = status;
    if (priority !== undefined) updates.priority = priority;
    if (due_date !== undefined) updates.due_date = due_date || null;
    const { data, error } = await supabase.from('tasks').update(updates).eq('id', req.params.taskId).eq('project_id', req.params.projectId).select().single();
    if (error) throw error;
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/projects/:projectId/tasks/:taskId', async (req, res) => {
  try {
    const { error } = await supabase.from('tasks').delete().eq('id', req.params.taskId).eq('project_id', req.params.projectId);
    if (error) throw error;
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- Milestones ----------
app.get('/api/projects/:projectId/milestones', async (req, res) => {
  try {
    const { data, error } = await supabase.from('milestones').select('*').eq('project_id', req.params.projectId).order('due_date', { ascending: true });
    if (error) throw error;
    res.json({ milestones: data || [] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/projects/:projectId/milestones', async (req, res) => {
  try {
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
    res.status(201).json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.patch('/api/projects/:projectId/milestones/:milestoneId', async (req, res) => {
  try {
    const { title, due_date, description, completed_at } = req.body || {};
    const updates = {};
    if (title !== undefined) updates.title = title.trim();
    if (due_date !== undefined) updates.due_date = due_date || null;
    if (description !== undefined) updates.description = description.trim() || null;
    if (completed_at !== undefined) updates.completed_at = completed_at || null;
    const { data, error } = await supabase.from('milestones').update(updates).eq('id', req.params.milestoneId).eq('project_id', req.params.projectId).select().single();
    if (error) throw error;
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/projects/:projectId/milestones/:milestoneId', async (req, res) => {
  try {
    const { error } = await supabase.from('milestones').delete().eq('id', req.params.milestoneId).eq('project_id', req.params.projectId);
    if (error) throw error;
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- Documents ----------
app.get('/api/projects/:projectId/documents', async (req, res) => {
  try {
    const { data, error } = await supabase.from('documents').select('*').eq('project_id', req.params.projectId).order('updated_at', { ascending: false });
    if (error) throw error;
    res.json({ documents: data || [] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/projects/:projectId/documents', async (req, res) => {
  try {
    const { title, content } = req.body || {};
    if (!title || !title.trim()) return res.status(400).json({ error: 'title is required' });
    const { data, error } = await supabase.from('documents').insert({
      project_id: req.params.projectId,
      title: title.trim(),
      content: (content || '').trim() || null
    }).select().single();
    if (error) throw error;
    res.status(201).json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.patch('/api/projects/:projectId/documents/:docId', async (req, res) => {
  try {
    const { title, content } = req.body || {};
    const updates = { updated_at: new Date().toISOString() };
    if (title !== undefined) updates.title = title.trim();
    if (content !== undefined) updates.content = content.trim() || null;
    const { data, error } = await supabase.from('documents').update(updates).eq('id', req.params.docId).eq('project_id', req.params.projectId).select().single();
    if (error) throw error;
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/projects/:projectId/documents/:docId', async (req, res) => {
  try {
    const { error } = await supabase.from('documents').delete().eq('id', req.params.docId).eq('project_id', req.params.projectId);
    if (error) throw error;
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- Notes ----------
app.get('/api/projects/:projectId/notes', async (req, res) => {
  try {
    const { data, error } = await supabase.from('notes').select('*').eq('project_id', req.params.projectId).order('updated_at', { ascending: false });
    if (error) throw error;
    res.json({ notes: data || [] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/projects/:projectId/notes', async (req, res) => {
  try {
    const { title, body } = req.body || {};
    const { data, error } = await supabase.from('notes').insert({
      project_id: req.params.projectId,
      title: (title || 'Untitled').trim(),
      body: (body || '').trim() || null
    }).select().single();
    if (error) throw error;
    res.status(201).json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.patch('/api/projects/:projectId/notes/:noteId', async (req, res) => {
  try {
    const { title, body } = req.body || {};
    const updates = { updated_at: new Date().toISOString() };
    if (title !== undefined) updates.title = title.trim();
    if (body !== undefined) updates.body = body.trim() || null;
    const { data, error } = await supabase.from('notes').update(updates).eq('id', req.params.noteId).eq('project_id', req.params.projectId).select().single();
    if (error) throw error;
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/projects/:projectId/notes/:noteId', async (req, res) => {
  try {
    const { error } = await supabase.from('notes').delete().eq('id', req.params.noteId).eq('project_id', req.params.projectId);
    if (error) throw error;
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
      const status = e.response?.status || 500;
      const data = e.response?.data || { error: e.message };
      res.status(status).json(typeof data === 'object' ? data : { error: e.message });
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

// ---------- Project files (upload → Matriya ingest, metadata in Supabase) ----------
app.get('/api/projects/:projectId/files', async (req, res) => {
  try {
    const { data, error } = await supabase.from('project_files').select('*').eq('project_id', req.params.projectId).order('created_at', { ascending: false });
    if (error) {
      const msg = String(error.message || error);
      // If table is missing, return empty list so opening a project still works; run full schema to enable files.
      if (msg.includes('does not exist') || msg.includes('relation') || msg.includes('project_files')) {
        console.warn('project_files table missing – run full supabase_schema.sql to enable files. Returning empty list.');
        return res.json({ files: [] });
      }
      throw error;
    }
    res.json({ files: data || [] });
  } catch (e) {
    console.error('GET /api/projects/:projectId/files', e?.message || e);
    res.status(500).json({ error: e?.message || 'Failed to list project files' });
  }
});

app.post('/api/projects/:projectId/files', upload.single('file'), async (req, res) => {
  const projectId = req.params.projectId;
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
    res.status(201).json(data);
  } catch (e) {
    const status = e.response?.status || 500;
    const data = e.response?.data || { error: e.message };
    res.status(status).json(typeof data === 'object' ? data : { error: e.message });
  }
});

app.delete('/api/projects/:projectId/files/:fileId', async (req, res) => {
  try {
    const { error } = await supabase.from('project_files').delete().eq('id', req.params.fileId).eq('project_id', req.params.projectId);
    if (error) throw error;
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- RAG (proxy to Matriya back) ----------
function ragConnectionErrorMessage(e) {
  const code = e.code || '';
  if (code === 'ECONNRESET') return 'החיבור למטריה נותק. ייתכן שהבקשה לוקחת יותר מדי זמן או שמטריה התאתחלה. נסה שוב.';
  if (code === 'ETIMEDOUT') return 'הבקשה למטריה עברה timeout. נסה שוב או קצר את השאלה.';
  if (code === 'ECONNREFUSED' || code === 'ENOTFOUND') return 'לא ניתן להתחבר למטריה. וודא שמטריה פועלת ו־MATRIYA_BACK_URL נכון.';
  return e.response?.data?.error || e.message;
}
function ragConnectionStatus(e) {
  const code = e.code || '';
  if (code === 'ECONNRESET' || code === 'ETIMEDOUT') return 502;
  if (code === 'ECONNREFUSED' || code === 'ENOTFOUND') return 503;
  return e.response?.status || 500;
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
