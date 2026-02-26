/**
 * Check that the 2 enforcement changes are in effect:
 * 1) RBAC: unauthenticated request to project-scoped endpoint → 401
 * 2) FSM: invalid task status transition (e.g. todo → done) → 409 with invalid_transition
 *
 * Run from maneger-back: node scripts/check-enforcement.js
 * With FSM test: node scripts/check-enforcement.js --login <username> <password>
 * (Loads .env so MATRIYA_BACK_URL is used for login.)
 */
import 'dotenv/config';
import axios from 'axios';

const BASE = process.env.MANEGER_URL || 'http://localhost:8001';
let token = null;

function request(method, path, opts = {}) {
  const url = path.startsWith('http') ? path : `${BASE}${path}`;
  const headers = { 'Content-Type': 'application/json', ...opts.headers };
  if (token) headers.Authorization = `Bearer ${token}`;
  return axios.request({ method, url, headers, data: opts.body, validateStatus: () => true });
}

async function main() {
  console.log('Checking enforcement (RBAC 401 + FSM 409)...\n');
  let ok = true;

  // ----- 1) RBAC: no auth → 401 on project-scoped endpoint -----
  console.log('1) RBAC: GET /api/projects/:id/tasks without Authorization → 401');
  let projectsRes = await request('GET', '/api/projects');
  if (projectsRes.status !== 200 || !projectsRes.data?.projects?.length) {
    console.log('   Skip: no projects (create one first). Status:', projectsRes.status);
  } else {
    const projectId = projectsRes.data.projects[0].id;
    const tasksRes = await request('GET', `/api/projects/${projectId}/tasks`);
    if (tasksRes.status === 401) {
      console.log('   OK: got 401 (Authentication required)');
    } else {
      console.log('   FAIL: expected 401, got', tasksRes.status, tasksRes.data?.error || '');
      ok = false;
    }
  }

  // ----- 2) FSM: invalid transition → 409 -----
  const loginArgs = process.argv.slice(2).filter(a => a === '--login');
  const loginIdx = process.argv.indexOf('--login');
  const hasLogin = loginIdx >= 0 && process.argv[loginIdx + 1] && process.argv[loginIdx + 2];
  if (!hasLogin) {
    console.log('\n2) FSM 409: skipped (run with --login <username> <password> to test)');
  } else {
    const username = process.argv[loginIdx + 1];
    const password = process.argv[loginIdx + 2];
    const matriyaUrl = process.env.MATRIYA_BACK_URL;
    if (!matriyaUrl) {
      console.log('\n2) FSM 409: skipped (set MATRIYA_BACK_URL to login)');
    } else {
      console.log('\n2) FSM: PATCH task todo → done (invalid) → 409');
      let loginRes;
      try {
        loginRes = await axios.post(`${matriyaUrl}/auth/login`, { username, password }, { validateStatus: () => true, timeout: 5000 });
      } catch (e) {
        console.log('   Skip: Matriya unreachable', e.code || e.message);
        loginRes = null;
      }
      if (!loginRes || loginRes.status !== 200 || !loginRes.data?.access_token) {
        if (loginRes) console.log('   Skip: login failed', loginRes.status, loginRes.data?.error || '');
      } else {
        token = loginRes.data.access_token;
        if (!projectsRes.data?.projects?.length) {
          projectsRes = await request('GET', '/api/projects');
        }
        if (!projectsRes.data?.projects?.length) {
          console.log('   Skip: no projects');
        } else {
          const projectId = projectsRes.data.projects[0].id;
          const tasksRes = await request('GET', `/api/projects/${projectId}/tasks`);
          if (tasksRes.status !== 200) {
            console.log('   Skip: GET tasks failed', tasksRes.status);
          } else {
            const todoTask = (tasksRes.data.tasks || []).find(t => t.status === 'todo');
            const taskId = todoTask?.id;
            if (!taskId) {
              const createRes = await request('POST', `/api/projects/${projectId}/tasks`, { body: { title: 'Check FSM', status: 'todo' } });
              const tid = createRes.data?.id;
              if (!tid) {
                console.log('   Skip: could not create task', createRes.status);
              } else {
                const patchRes = await request('PATCH', `/api/projects/${projectId}/tasks/${tid}`, { body: { status: 'done' } });
                if (patchRes.status === 409 && patchRes.data?.invalid_transition === true && patchRes.data?.from === 'todo' && patchRes.data?.to === 'done') {
                  console.log('   OK: got 409 with invalid_transition, from=todo, to=done');
                } else {
                  console.log('   FAIL: expected 409 with invalid_transition, got', patchRes.status, patchRes.data);
                  ok = false;
                }
              }
            } else {
              const patchRes = await request('PATCH', `/api/projects/${projectId}/tasks/${taskId}`, { body: { status: 'done' } });
              if (patchRes.status === 409 && patchRes.data?.invalid_transition === true && patchRes.data?.from === 'todo' && patchRes.data?.to === 'done') {
                console.log('   OK: got 409 with invalid_transition, from=todo, to=done');
              } else {
                console.log('   FAIL: expected 409 with invalid_transition, got', patchRes.status, patchRes.data);
                ok = false;
              }
            }
          }
        }
      }
    }
  }

  console.log('\n' + (ok ? 'All checks passed.' : 'Some checks failed.'));
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
