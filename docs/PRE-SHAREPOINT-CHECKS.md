# Pre-SharePoint checks (6 tests)

Before connecting SharePoint, run these to confirm the system is stable.

## 1. Health (maneger-back)

```http
GET /health
```

**Expected:** `{ "ok": true, "db_status": "connected", "response_time_ms": <number> }`

---

## 2. Observability (matriya-back)

```http
GET /api/observability/dashboard
```

**Expected:** `total_requests`, `latency_p50`, `latency_p99`, `error_count` present.

---

## 3. Audit trail (matriya-back)

- Create a decision: e.g. `POST /research/session` then `GET /search?session_id=...&stage=K&generate_answer=true`
- Then: `GET /api/audit/decisions`
- **Expected:** At least one record with `inputs_snapshot`, `model_version_hash`, `confidence_score`.

---

## 4. Replay (matriya-back)

```http
GET /api/audit/session/{session_id}/decisions
```

**Expected:** Array of decisions for that session (replay from snapshot).

---

## 5. Parallel lock (matriya-back)

Send two concurrent `POST /api/research/run` with the same `session_id`.  
**Expected:** Both complete; only one run at a time (serialized by `researchRunLocks`).

---

## 6. SharePoint idempotency (maneger-back)

Call twice with the **same** `request_id` (e.g. in body or `x-request-id`):

```http
POST /api/projects/{projectId}/files/pull-sharepoint
Body: { "request_id": "same-uuid", "siteUrl": "...", "folderPath": "..." }
```

**Expected:** First may succeed or fail (e.g. 503 if SharePoint not configured). Second returns `{ "skipped": true, "idempotent": true }` and no duplicate ingest.

---

## Run the script

From **maneger-back** (needs both servers running):

```bash
# Default: MANAGER_URL=http://localhost:8001, MATRIYA_URL=http://localhost:8000
node scripts/pre-sharepoint-checks.js

# With credentials for test 6 (SharePoint idempotency):
PROJECT_ID=<uuid> EMAIL=... PASSWORD=... node scripts/pre-sharepoint-checks.js
```

**DB (maneger-back):** Ensure `sharepoint_pull_requests` table exists (see `supabase_schema.sql`).
