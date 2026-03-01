# Management System – Infrastructure (תשתית)

חיזוק תשתית: Rate limiting, validation, pagination, audit, backup.

---

## 1. Rate limiting + body size limits

| מה קיים | מה הושלם |
|---------|-----------|
| multer: `fileSize: 50MB` (PDF/Excel) | הושלם מראש |
| – | **express.json({ limit: '1mb' })** – הגבלת גוף JSON |
| – | **Rate limit:** auth 20/min, RAG 30/min, כללי 200/min |
| – | **limiterUpload:** 15/min על POST .../files |
| – | RAG proxy: timeout 120s (research/run), 10s (session) – כבר קיים ב-axios |

---

## 2. Validation אחיד (Zod)

| payload | סכמה | היכן |
|---------|------|------|
| **runs** | `runCreateSchema`, `runPatchSchema` | POST/PATCH /api/projects/:id/runs |
| **tasks** | `taskCreateSchema`, `taskPatchSchema` | POST/PATCH /api/projects/:id/tasks |
| config, results, filters | – | לא הוגדרו (אין endpoints ייעודיים כרגע); ניתן להוסיף לפי דרישה |

כל payload קריטי ל-runs ו-tasks עובר Zod; כישלון → 400 עם `issues`.

---

## 3. Pagination + Indexes

| list endpoint | pagination | query params |
|---------------|------------|--------------|
| GET /api/projects | כן | `?limit=50&offset=0` (ברירת מחדל 50, מקס 100) |
| GET .../tasks | כן | idem |
| GET .../milestones | כן | idem |
| GET .../documents | כן | idem |
| GET .../notes | כן | idem |
| GET .../runs | כן | idem |
| GET .../files | כן | idem |
| GET .../chat | כן | idem |

תשובה: תמיד כוללת `limit` ו-`offset` בנוסף למערך הרשומה.

**אינדקסים (supabase_schema.sql):**

- `project_id` + `created_at` / `updated_at` כבר קיימים על רוב הטבלאות.
- **runs:** נוסף `runs_created_at_idx` על `(project_id, created_at DESC)`.
- **audit_log:** נוסף `audit_log_request_id_idx` על `request_id`.

---

## 4. Audit coverage מלא

| ישות | create | update | delete | request_id | before/after |
|------|--------|--------|--------|------------|--------------|
| project | ✓ | ✓ | ✓ | ✓ | ב-details כשמשמעותי |
| project_join_request | approve/reject ✓ | – | – | ✓ | – |
| project_member | ✓ | – | ✓ | ✓ | – |
| chat_message | ✓ | – | – | ✓ | – |
| task | ✓ | ✓ | ✓ | ✓ | task update: details.before/after (status) |
| milestone | ✓ | ✓ | ✓ | ✓ | – |
| document | ✓ | ✓ | ✓ | ✓ | – |
| note | ✓ | ✓ | ✓ | ✓ | – |
| run | ✓ | ✓ | – | ✓ | – |
| project_file | ✓ | – | ✓ | ✓ | – |

**שדות רשומת audit:** `project_id`, `user_id`, `username` (actor), `action`, `entity_type`, `entity_id` (entity), `details` (before/after כשקיים), `request_id`, `created_at`.

טבלה: `audit_log`. עמודה `request_id` נוספה; ערך מגיע מ-`req.requestId` (middleware: `x-request-id` או UUID).

---

## 5. Backup + restore test

| נושא | סטטוס |
|------|--------|
| **גיבוי DB אוטומטי** | Supabase מספק גיבויים אוטומטיים (תלוי בתוכנית). ב-Dashboard: Project Settings → Database → Backups. |
| **בדיקת restore אחת** | יש לבצע ידנית; אין סקריפט אוטומטי במערכת הניהול. |

**צעדים לבדיקת restore (פעם אחת):**

1. ב-Supabase Dashboard: Settings → Database → Backups – לוודא שיש גיבוי (Point-in-time או daily).
2. ליצור פרויקט/משימה בדיקה, לרשום מזהה.
3. לבחור "Restore" לגיבוי (או PITR) לרגע לפני/אחרי – לפי ממשק Supabase.
4. אחרי restore: להריץ את האפליקציה ולוודא שהפרויקט/משימה נגישים ושה-audit_log נראה סביר.

אין סקריפט backup/restore בתוך maneger-back; הגיבוי והשחזור מתבצעים בממשק Supabase.

---

## 6. SharePoint – משיכת קבצים מפולדר (אופציונלי)

ניתן למשוך קבצים מתיקיית SharePoint לפרויקט (לאחר מכן הם נשלחים ל-Matriya ingest כמו העלאה רגילה).

**Endpoint:** `POST /api/projects/:projectId/files/pull-sharepoint`  
**Rate limit:** 5 בקשות לדקה (`limiterSharePoint`).

**Body (JSON):**

- `siteUrl` (string, אופציונלי) – כתובת האתר, למשל `https://tenant.sharepoint.com/sites/MySite`
- `siteId` (UUID, אופציונלי) – מזהה האתר ב-Graph (אם ידוע)
- `folderPath` (string, חובה) – נתיב התיקייה בתוך ה-drive, למשל `Shared Documents/MyFolder` או ריק ל-root
- `driveId` (UUID, אופציונלי) – מזהה ה-drive; ברירת מחדל: ה-drive הראשי של האתר

חובה לספק `siteUrl` או `siteId`.

**משתני סביבה (אופציונליים):**

- `SHAREPOINT_TENANT_ID` – Tenant (ספריית Azure AD)
- `SHAREPOINT_CLIENT_ID` – Client ID של App registration
- `SHAREPOINT_CLIENT_SECRET` – Client secret של האפליקציה

ב-Azure: App registration → API permissions → Microsoft Graph → Application: `Sites.Read.All` או `Files.Read.All` (לפחות).

**תשובה:** `{ pulled, failed, ingested: [{ id, original_name }], failed: [{ name, error }] }`.

---

## סיכום: מה כבר קיים vs מה דורש השלמה

| פריט | קיים | הושלם במסגרת זו |
|------|------|------------------|
| Rate limiting (auth, upload, RAG, כללי) | חלקית | ✓ הגבלות ומוגבלים לכל הנתיבים הרלוונטיים |
| Body size (JSON 1mb, file 50MB) | file היה | ✓ JSON limit + תיעוד |
| Validation (Zod) ל-runs, tasks | לא | ✓ סכמות ו-safeParse ב-POST/PATCH |
| Pagination בכל list | לא | ✓ limit/offset + range בכל רשימות |
| Indexes (project_id, created_at, status, runs) | חלקית | ✓ runs_created_at, audit request_id |
| Audit (actor, entity, action, before/after, request_id) | חלקית | ✓ request_id בכל רשומה, before/after ב-task update |
| Backup אוטומטי | Supabase | לא במערכת – Supabase |
| Restore test | לא | תיעוד צעדים – יש לבצע ידנית פעם אחת |
