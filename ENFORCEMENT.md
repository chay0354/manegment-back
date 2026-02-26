# Management System – Enforcement (RBAC / Audit / FSM)

תיעוד אכיפה במערכת הניהול: RBAC, Audit Log מלא, ו-FSM אכוף.

---

## 1. Multi-File Upload

- **מיקום:** Frontend – `maneger-front/src/App.jsx` (טאב ניהול מסמכים / RAG).
- **שינוי:** שדה ההעלאה הוא `multiple`; ב-`onFileChange` מתבצע **לולאה על כל הקבצים** (`Array.from(fileList)`) והעלאה סדרתית לכל קובץ דרך `projectFilesApi.upload(projectId, file)`.
- **אין UploadTab.js** – ההעלאה נמצאת ב-`App.jsx` בתוך קומפוננטת ה-RAG (מקטע "העלאת קבצים").
- **וידוא:** בחר 3–4 קבצים בבת אחת (Ctrl+Click או Shift+Click) → לחץ "בחר קבצים להעלאה" → כל הקבצים מועלים ואחרי רענון רשימת הקבצים כולם מופיעים ברשימה.

---

## 2. RBAC – אכיפה מלאה

### טבלת Roles (מבנה נוכחי)

| תפקיד   | טבלה / מקור        | הרשאות |
|---------|---------------------|--------|
| owner   | `project_members.role` | כל פעולות הפרויקט, מחיקת פרויקט, עדכון פרויקט, הוספת/הסרת חברים, אישור/דחיית בקשת הצטרפות |
| member  | `project_members.role` | צפייה בפרויקט, משימות, אבנים, מסמכים, הערות, קבצים, צ'אט, RAG, runs – אין מחיקת פרויקט או ניהול חברים |

אין טבלת `permissions` נפרדת – ההרשאות נגזרות מ-`project_members.role` (owner vs member).

### איפה יש Guard על כל endpoint רגיש

- **פונקציה מרכזית:** `requireProjectMember(req, res, projectId)` ב-`server.js`.
- **התנהגות:** בודקת `Authorization` → קוראת ל-Matriya `/auth/me` → בודקת שימוש ב-`project_members` (או מטפלת בפרויקט ללא חברים כ־owner). אם אין גישה: **401** (לא מאומת) או **403** (לא חבר בפרויקט).

**Endpoints שמשתמשים ב-`requireProjectMember` (כל גישה לנתוני פרויקט):**

- `GET/POST/PATCH/DELETE` – tasks, milestones, documents, notes  
- `GET/POST/DELETE` – project files  
- `GET/POST` – chat  
- `GET/POST/PATCH` – runs, `GET` runs/:id/trace  

**Endpoints עם בדיקת owner בלבד (ללא member):**

- `PATCH /api/projects/:id` – רק owner  
- `DELETE /api/projects/:id` – רק owner  
- `POST/DELETE /api/projects/:id/members` – רק owner  
- `POST /api/projects/:id/requests/:requestId/approve` – רק owner  
- `POST /api/projects/:id/requests/:requestId/reject` – רק owner  

### דוגמה לבקשה שמחזירה 403 (גישה לא מורשית)

1. התחבר כמשתמש A (חבר בפרויקט X).  
2. צור פרויקט Y והתחבר כמשתמש B (חבר רק ב-Y).  
3. עם טוקן של B שלח:  
   `GET /api/projects/<project-X-id>/tasks`  
   עם `Authorization: Bearer <token-of-B>`.  
4. **תוצאה צפויה:** **403** עם גוף:  
   `{ "error": "Not a project member" }`.

דוגמה ל-401: קריאה ל-`GET /api/projects/:projectId/tasks` **בלי** כותרת `Authorization` → **401** `{ "error": "Authentication required" }`.

---

## 3. Audit Log מלא

### פעולות שנרשמות כ-Audit

| פעולה   | entity_type          | פרטים (details) / before–after |
|---------|----------------------|----------------------------------|
| create  | project              | name                             |
| update  | project              | –                                |
| delete  | project              | –                                |
| request_approve | project_join_request | username                 |
| request_reject  | project_join_request | –                        |
| member_add      | project_member       | username                 |
| member_remove   | project_member       | –                        |
| create  | chat_message         | –                                |
| create  | task                 | title                            |
| update  | task                 | **before** / **after** (למשל status) |
| delete  | task                 | –                                |
| create/update/delete | milestone, document, note | title וכו' |
| create  | project_file         | original_name                    |
| delete  | project_file         | –                                |
| create  | run                  | –                                |
| update  | run                  | –                                |

כל רשומה כוללת: `project_id`, `user_id`, `username`, `action`, `entity_type`, `entity_id`, `details` (JSONB), `created_at`.

### דוגמת רשומה מלאה (user_id + before/after + timestamp)

```json
{
  "id": "uuid",
  "project_id": "project-uuid",
  "user_id": 42,
  "username": "david",
  "action": "update",
  "entity_type": "task",
  "entity_id": "task-uuid",
  "details": {
    "before": { "status": "todo" },
    "after":  { "status": "in_progress" }
  },
  "created_at": "2026-02-25T12:00:00.000Z"
}
```

טבלת ה-audit: `audit_log` ב-`supabase_schema.sql`. השדה `details` (JSONB) משמש ל־before/after ולשדות רלוונטיים נוספים (למשל title, original_name).

---

## 4. FSM Enforcement אמיתי

### ResearchGate vs StateMachine

- **ResearchGate** – מנגנון אכיפה ב-**Matriya** (נעילה על research כשנמצאה הפרת B-Integrity). לא חלק ממערכת הניהול.
- **StateMachine במערכת הניהול** – אכוף ב-**Task status** בלבד: מעברים חוקיים מוגדרים ב-`TASK_STATUS_TRANSITIONS` ב-`server.js`, והעדכון ל-DB מתבצע **רק אחרי** בדיקת המעבר. מעבר לא חוקי נחסם לפני עדכון ה-DB.

### אכיפה אטומית (לפני DB)

ב-`PATCH /api/projects/:projectId/tasks/:taskId`:

1. נטען ה-task הנוכחי מה-DB.  
2. אם נשלח `status` חדש – מתבצעת בדיקה: `isAllowedTaskStatusTransition(current.status, status)`.  
3. אם המעבר **לא חוקי** – מחזירים **409** ולא מעדכנים את ה-DB.  
4. אם חוקי – מעדכנים ואז כותבים audit.

### דוגמה ל-409 על מעבר מצב לא חוקי

**בקשה:**  
`PATCH /api/projects/<id>/tasks/<taskId>`  
גוף: `{ "status": "done" }`  
כאשר ה-task הנוכחי ב-status **`todo`** (מותר רק: `in_progress`, `cancelled`).

**תשובה:**  
**409 Conflict**  
גוף:
```json
{
  "error": "Invalid status transition: todo → done",
  "invalid_transition": true,
  "from": "todo",
  "to": "done"
}
```

מעברים חוקיים (לפי `TASK_STATUS_TRANSITIONS`):  
todo → in_progress | cancelled; in_progress → todo | in_review | cancelled; in_review → in_progress | done | cancelled; done / cancelled → אין מעבר.

---

## סיכום תנאי סף ל-Kernel Lock

| תנאי   | סטטוס במערכת הניהול |
|--------|----------------------|
| RBAC   | אכוף – `requireProjectMember` + owner-only על endpoints רגישים; 401/403 על גישה לא מורשית. |
| Audit  | לוג מלא לכל שינוי (create/update/delete) כולל before/after ב-update של task; טבלת `audit_log`. |
| FSM    | אכוף ב-task status – 409 על מעבר לא חוקי, עדכון DB רק אחרי ולידציה. |

ResearchGate נשאר מנגנון האכיפה הרשמי **במטריה**; במערכת הניהול האכיפה הרשמית היא **Task State Machine** עם 409 ו-audit.
