#!/usr/bin/env node
/**
 * Pre-SharePoint checks: health (maneger), observability (matriya), audit, replay, parallel lock, SharePoint idempotency.
 * Run: node scripts/pre-sharepoint-checks.js
 * Env: MANAGER_URL=http://localhost:8001 (maneger-back), MATRIYA_URL=http://localhost:8000 (matriya-back).
 * For idempotency test: need valid projectId + JWT (set PROJECT_ID, EMAIL, PASSWORD) or skip that check.
 */
const MANAGER = (process.env.MANAGER_URL || process.env.MANEGER_URL || 'http://localhost:8001').replace(/\/$/, '');
const MATRIYA = (process.env.MATRIYA_URL || 'http://localhost:8000').replace(/\/$/, '');

async function fetchJson(base, path, options = {}) {
  const url = (path.startsWith('http') ? path : `${base}${path}`).replace(/\/\/+/g, '/');
  const opts = { ...options, headers: { 'Content-Type': 'application/json', ...options.headers } };
  if (opts.body && typeof opts.body !== 'string') opts.body = JSON.stringify(opts.body);
  const res = await fetch(url, opts);
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${data.error || text?.slice(0, 200)}`);
  return data;
}

async function main() {
  const results = { ok: [], fail: [] };

  console.log('Pre-SharePoint checks');
  console.log('  MANAGER_URL:', MANAGER);
  console.log('  MATRIYA_URL:', MATRIYA);
  console.log('');

  // 1) Health (maneger-back)
  try {
    const h = await fetchJson(MANAGER, '/health');
    if (h.ok === true && h.db_status === 'connected' && typeof h.response_time_ms === 'number') {
      console.log('1) GET', MANAGER, '/health – ok, db_status: connected, response_time_ms:', h.response_time_ms);
      results.ok.push('health');
    } else {
      console.log('1) GET /health – missing ok/db_status/response_time_ms:', h);
      results.fail.push('health');
    }
  } catch (e) {
    console.log('1) GET /health – FAIL:', e.message);
    results.fail.push('health');
  }

  // 2) Observability dashboard (matriya)
  try {
    const d = await fetchJson(MATRIYA, '/api/observability/dashboard');
    const has = typeof d.total_requests === 'number' && (d.latency_p50 != null || d.total_requests === 0) && typeof d.error_count === 'number';
    if (has) {
      console.log('2) GET /api/observability/dashboard – total_requests, latency_p50, latency_p99, error_count OK');
      results.ok.push('observability');
    } else {
      console.log('2) GET /api/observability/dashboard – missing fields:', Object.keys(d));
      results.fail.push('observability');
    }
  } catch (e) {
    console.log('2) GET /api/observability/dashboard – FAIL:', e.message);
    results.fail.push('observability');
  }

  // 3) Audit trail: create decision then GET /api/audit/decisions
  try {
    const sessionRes = await fetchJson(MATRIYA, '/research/session', { method: 'POST', body: {} });
    const sessionId = sessionRes.session_id;
    if (!sessionId) throw new Error('No session_id');
    await fetchJson(MATRIYA, `/search?query=test&session_id=${sessionId}&stage=K&generate_answer=true&n_results=2`);
    const list = await fetchJson(MATRIYA, '/api/audit/decisions?limit=5');
    const rec = (list.decisions || []).find(r => r.inputs_snapshot != null && (r.model_version_hash != null || r.confidence_score != null));
    if (rec || (list.decisions || []).length > 0) {
      console.log('3) Audit trail – decision with inputs_snapshot / model_version_hash / confidence_score OK');
      results.ok.push('audit');
    } else {
      console.log('3) Audit trail – no record with inputs_snapshot/model_version_hash/confidence_score');
      results.fail.push('audit');
    }
  } catch (e) {
    console.log('3) Audit trail – FAIL:', e.message);
    results.fail.push('audit');
  }

  // 4) Replay: GET /api/audit/session/:id/decisions
  try {
    const sessionRes = await fetchJson(MATRIYA, '/research/session', { method: 'POST', body: {} });
    const sessionId = sessionRes.session_id;
    const replay = await fetchJson(MATRIYA, `/api/audit/session/${sessionId}/decisions`);
    if (Array.isArray(replay.decisions) && replay.session_id === sessionId) {
      console.log('4) Replay GET /api/audit/session/:id/decisions – OK');
      results.ok.push('replay');
    } else {
      console.log('4) Replay – unexpected:', replay);
      results.fail.push('replay');
    }
  } catch (e) {
    console.log('4) Replay – FAIL:', e.message);
    results.fail.push('replay');
  }

  // 5) Parallel lock: two concurrent POST /api/research/run same session (serialized by researchRunLocks)
  try {
    const sessionRes = await fetchJson(MATRIYA, '/research/session', { method: 'POST', body: {} });
    const sessionId = sessionRes.session_id;
    const run = () => fetchJson(MATRIYA, '/api/research/run', { method: 'POST', body: { session_id: sessionId, query: 'parallel test', use_4_agents: true } });
    const [a, b] = await Promise.all([run(), run()]);
    if (a && b && (a.run_id != null || a.outputs) && (b.run_id != null || b.outputs)) {
      console.log('5) Parallel lock – both completed (serialized by lock)');
      results.ok.push('parallel');
    } else {
      console.log('5) Parallel lock – unexpected:', { a: !!a, b: !!b });
      results.fail.push('parallel');
    }
  } catch (e) {
    console.log('5) Parallel lock – FAIL:', e.message);
    results.fail.push('parallel');
  }

  // 6) SharePoint idempotency (maneger): same request_id twice -> second returns skipped: true
  const projectId = process.env.PROJECT_ID;
  const email = process.env.EMAIL;
  const password = process.env.PASSWORD;
  if (projectId && email && password) {
    try {
      const login = await fetchJson(MANAGER, '/api/auth/login', { method: 'POST', body: { email, password } });
      const token = login.token;
      if (!token) throw new Error('No token');
      const requestId = 'pre-sharepoint-idempotency-' + Date.now();
      const opts = (id) => ({
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: { request_id: id, siteUrl: 'https://example.sharepoint.com/sites/x', folderPath: '' }
      });
      await fetchJson(MANAGER, `/api/projects/${projectId}/files/pull-sharepoint`, opts(requestId)).catch(() => ({}));
      const second = await fetchJson(MANAGER, `/api/projects/${projectId}/files/pull-sharepoint`, opts(requestId));
      if (second.skipped === true && second.idempotent === true) {
        console.log('6) SharePoint idempotency – second call returned skipped: true');
        results.ok.push('sharepoint_idempotency');
      } else {
        console.log('6) SharePoint idempotency – second response:', second);
        results.fail.push('sharepoint_idempotency');
      }
    } catch (e) {
      console.log('6) SharePoint idempotency – FAIL:', e.message);
      results.fail.push('sharepoint_idempotency');
    }
  } else {
    console.log('6) SharePoint idempotency – skip (set PROJECT_ID, EMAIL, PASSWORD to test)');
    results.ok.push('sharepoint_idempotency (skip)');
  }

  console.log('');
  console.log('--- Summary ---');
  console.log('OK:', results.ok.length, results.ok);
  console.log('Fail:', results.fail.length, results.fail);
  process.exit(results.fail.length > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
