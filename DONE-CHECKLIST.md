# DONE – רשימה מסודרת לסימון (Management System)

## 1. PR / Commit links

כל השינויים במערכת הניהול (maneger) – אין PR יחיד; ניתן לסמן DONE לפי commits או לפי PR שמאחד אותם:

| נושא | Repo | מה לחפש / Commit |
|------|------|-------------------|
| Multi-file upload | **manegment-front** | `App.jsx` – `multiple` + לולאה `Array.from(fileList)` + `onFileChange` async; `strings.js` – `chooseFileMultiple`, `uploadSomeFailed` |
| RBAC (requireProjectMember) | **manegment-back** | `server.js` – `requireProjectMember`, 401/403 על כל endpoints של פרויקט |
| Audit log מלא + before/after | **manegment-back** | `server.js` – `auditLog()`, task update עם `details: { before, after }`; טבלה `audit_log` ב-`supabase_schema.sql` |
| FSM (409 על מעבר לא חוקי) | **manegment-back** | `server.js` – PATCH task עם `status` → 409 + `invalid_transition`, `from`, `to` |
| Runs + trace | **manegment-back** | `server.js` – POST/GET/PATCH runs, GET runs/:id/trace; `supabase_schema.sql` – `runs`, `run_fsm_trace` |
| ENFORCEMENT + check script | **manegment-back** | `ENFORCEMENT.md`, `scripts/check-enforcement.js` |

**אם יש PR אחד שמכסה הכול:**  
PR ב-**manegment-back** שמכיל: RBAC, Audit, FSM 409, Runs, ENFORCEMENT.md, check-enforcement.js.  
PR ב-**manegment-front** שמכיל: Multi-file upload (App.jsx + strings).

---

## 2. טבלת Endpoints → Guards (Auth / Admin / Permission)

| Endpoint | Guard | הערה |
|----------|--------|------|
| `GET /api/projects` | אין | רשימת פרויקטים (ללא סינון לפי משתמש) |
| `POST /api/projects` | Auth (getCurrentUser) | 401 אם לא מאומת |
| `GET /api/projects/:id/access` | אין (או user אוטומטי כ-owner אם אין members) | |
| `GET /api/projects/:id` | Auth + Project member | 401 לא מאומת, 403 לא חבר |
| `PATCH /api/projects/:id` | Auth + **Owner only** | 403 אם לא owner |
| `DELETE /api/projects/:id` | Auth + **Owner only** | 403 אם לא owner |
| `POST /api/projects/:id/request` | Auth | |
| `GET /api/projects/:id/requests` | Auth + **Owner only** | |
| `POST .../requests/:requestId/approve` | Auth + **Owner only** | |
| `POST .../requests/:requestId/reject` | Auth + **Owner only** | |
| `GET /api/users` | Auth | |
| `GET /api/projects/:id/members` | Auth + Project member | |
| `POST /api/projects/:id/members` | Auth + **Owner only** | |
| `DELETE /api/projects/:id/members/:userId` | Auth + **Owner only** | |
| `GET /api/projects/:id/chat` | Auth + Project member | |
| `POST /api/projects/:id/chat` | Auth + Project member | |
| `GET/POST/PATCH/DELETE /api/projects/:id/tasks` | Auth + Project member | PATCH: FSM → 409 על מעבר לא חוקי |
| `GET/POST/PATCH/DELETE .../milestones` | Auth + Project member | |
| `GET/POST/PATCH/DELETE .../documents` | Auth + Project member | |
| `GET/POST/PATCH/DELETE .../notes` | Auth + Project member | |
| `GET/POST/DELETE .../files` | Auth + Project member | |
| `GET/POST/PATCH .../runs`, `GET .../runs/:id/trace` | Auth + Project member | |
| `GET /api/auth/me`, `POST /api/auth/login|signup` | – | Proxy ל-Matriya |
| `GET/POST .../rag/*` | Auth (מועבר ל-Matriya) | |

**סיכום:**  
- **Auth** = כותרת `Authorization: Bearer <token>`; ללא → 401.  
- **Project member** = `requireProjectMember` → לא חבר בפרויקט → 403.  
- **Owner only** = בדיקה נפרדת ל-`role === 'owner'` → 403 אם member.  
- **Admin** = אין שכבת Admin במערכת הניהול; רק owner/member.

---

## 3. שתי דוגמאות cURL

### דוגמה 1: 403 (ללא token) או 409 (מעבר FSM לא חוקי)

**מקבלת 401 (ללא Auth):**
```bash
curl -s -o /dev/null -w "%{http_code}" \
  -X GET "http://localhost:8001/api/projects/ec9e94e5-f981-41dc-8595-dbc14f2dd117/tasks"
# Expected: 401 (no Authorization header)
```

**מקבלת 403 (לא חבר בפרויקט – עם token של משתמש שלא בפרויקט):**
```bash
curl -s -w "\n%{http_code}" \
  -X GET "http://localhost:8001/api/projects/<PROJECT_ID>/tasks" \
  -H "Authorization: Bearer <TOKEN_OF_USER_NOT_IN_PROJECT>"
# Expected: 403, body: {"error":"Not a project member"}
```

**מקבלת 409 (מעבר מצב לא חוקי – todo → done):**
```bash
curl -s -w "\n%{http_code}" \
  -X PATCH "http://localhost:8001/api/projects/<PROJECT_ID>/tasks/<TASK_ID>" \
  -H "Authorization: Bearer <VALID_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"status":"done"}'
# When task is currently "todo", expected: 409, body: {"error":"Invalid status transition: todo → done","invalid_transition":true,"from":"todo","to":"done"}
```

### דוגמה 2: 200 (הצלחה)

**רשימת משימות (משתמש חבר בפרויקט):**
```bash
curl -s -w "\n%{http_code}" \
  -X GET "http://localhost:8001/api/projects/<PROJECT_ID>/tasks" \
  -H "Authorization: Bearer <VALID_TOKEN>"
# Expected: 200, body: {"tasks":[...]}
```

**עדכון משימה עם מעבר חוקי (todo → in_progress):**
```bash
curl -s -w "\n%{http_code}" \
  -X PATCH "http://localhost:8001/api/projects/<PROJECT_ID>/tasks/<TASK_ID>" \
  -H "Authorization: Bearer <VALID_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"status":"in_progress"}'
# Expected: 200, body: task object
```

---

## 4. דוגמת רשומת Audit מלאה (before/after + user_id + timestamp)

```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "project_id": "ec9e94e5-f981-41dc-8595-dbc14f2dd117",
  "user_id": 42,
  "username": "david",
  "action": "update",
  "entity_type": "task",
  "entity_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "details": {
    "before": { "status": "todo" },
    "after":  { "status": "in_progress" }
  },
  "created_at": "2026-02-25T14:30:00.000Z"
}
```

הטבלה: `audit_log` (ב-Supabase). שדה `details` (JSONB) מכיל את ה-before/after בעדכוני task (ובמקרים אחרים פרטים רלוונטיים כמו title, original_name).
