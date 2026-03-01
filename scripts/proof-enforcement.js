/**
 * Live proofs for: 429 rate limit, 400 validation, pagination metadata, audit (request_id + before/after), restore test.
 * Run: node scripts/proof-enforcement.js
 * Optional: MANAGER_URL=http://localhost:8001 EMAIL=... PASSWORD=... for auth-required proofs (400, audit).
 */
import 'dotenv/config';
import crypto from 'crypto';

const BASE = (process.env.MANAGER_URL || process.env.MANEGER_URL || 'http://localhost:8001').replace(/\/$/, '');

async function fetchSafe(url, opts = {}) {
  try {
    return await fetch(url, opts);
  } catch (e) {
    return { ok: false, status: 0, json: async () => ({ error: e.message || 'fetch failed' }) };
  }
}

async function main() {
  console.log('--- Proof 1: 429 rate limit ---');
  let lastStatus = 0;
  for (let i = 0; i < 22; i++) {
    const r = await fetchSafe(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
    lastStatus = r.status;
    if (r.status === 429) {
      const body = await r.json().catch(() => ({}));
      console.log('429 received:', JSON.stringify(body, null, 2));
      break;
    }
  }
  if (lastStatus === 0) console.log('(Server unreachable – start server and run again)');
  else if (lastStatus !== 429) console.log('(No 429 in 22 requests – rate limit may need a fresh window or different limit)');

  console.log('\n--- Proof 2: 400 validation (schema) ---');
  const email = process.env.EMAIL;
  const password = process.env.PASSWORD;
  let token;
  let projectId;
  if (email && password) {
    const loginRes = await fetchSafe(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
    const loginJson = await (loginRes.json ? loginRes.json() : Promise.resolve({})).catch(() => ({}));
    token = loginJson.token;
    const projRes = await fetchSafe(`${BASE}/api/projects`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    const projJson = await (projRes.json ? projRes.json() : Promise.resolve({})).catch(() => ({}));
    projectId = projJson.projects?.[0]?.id;
  }
  if (projectId && token) {
    const invalidRes = await fetchSafe(`${BASE}/api/projects/${projectId}/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ title: '' })
    });
    const invalidBody = await (invalidRes.json ? invalidRes.json() : Promise.resolve({})).catch(() => ({}));
    console.log('400 response:', invalidRes.status, JSON.stringify(invalidBody, null, 2));
  } else {
    console.log('(Set EMAIL and PASSWORD to run 400 validation proof against POST .../tasks with invalid body)');
  }

  console.log('\n--- Proof 3: Pagination (total / limit / offset) ---');
  const listRes = await fetchSafe(`${BASE}/api/projects?limit=2&offset=0`);
  const listJson = await (listRes.json ? listRes.json() : Promise.resolve({})).catch(() => ({}));
  console.log('Response keys:', Object.keys(listJson));
  console.log('total:', listJson.total, 'limit:', listJson.limit, 'offset:', listJson.offset);

  console.log('\n--- Proof 4: Audit (request_id + before/after) ---');
  if (projectId && token) {
    const tasksRes = await fetchSafe(`${BASE}/api/projects/${projectId}/tasks?limit=5`, { headers: { Authorization: `Bearer ${token}` } });
    const tasksJson = await (tasksRes.json ? tasksRes.json() : Promise.resolve({})).catch(() => ({}));
    const task = tasksJson.tasks?.[0];
    const requestId = crypto.randomUUID();
    if (task) {
      const fromStatus = task.status;
      const toStatus = fromStatus === 'todo' ? 'in_progress' : 'todo';
      const patchRes = await fetchSafe(`${BASE}/api/projects/${projectId}/tasks/${task.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'x-request-id': requestId },
        body: JSON.stringify({ status: toStatus })
      });
      if (patchRes.ok) {
        const auditRes = await fetchSafe(`${BASE}/api/projects/${projectId}/audit?limit=1`, { headers: { Authorization: `Bearer ${token}` } });
        const auditJson = await (auditRes.json ? auditRes.json() : Promise.resolve({})).catch(() => ({}));
        const rec = auditJson.audit?.[0];
        console.log('Audit record:', rec ? { request_id: rec.request_id, action: rec.action, entity_type: rec.entity_type, details: rec.details } : auditJson);
        if (fromStatus !== toStatus) {
          await fetchSafe(`${BASE}/api/projects/${projectId}/tasks/${task.id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify({ status: fromStatus })
          });
        }
      }
    } else {
      console.log('(No task in project – create one to see audit with before/after)');
    }
  } else {
    console.log('(Set EMAIL and PASSWORD to run audit proof)');
  }

  console.log('\n--- Proof 5: Restore test ---');
  console.log('See RESTORE-TEST-DONE.md and INFRASTRUCTURE.md. Run a restore in Supabase (dev) and note the date there.');
}

main().catch((e) => { console.error(e); process.exit(1); });
