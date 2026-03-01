# 5 הוכחות חיות (מערכת הניהול)

הרצת כל ההוכחות:

```bash
cd maneger-back
# ללא auth – יופעלו: 429, pagination. עם auth – גם 400 ו־audit.
EMAIL=your@email.com PASSWORD=yourpass node scripts/proof-enforcement.js
```

## 1. 429 – Rate limit

הסקריפט שולח 22 בקשות ל־`POST /api/auth/login` באותו חלון דקה. התגובה הצפויה:

```json
{ "error": "Too many auth attempts" }
```
Status: **429**.

## 2. 400 – Validation (schema)

בקשה לא תקינה ל־`POST /api/projects/:projectId/tasks` עם `title: ""`. התגובה:

- Status: **400**
- Body: `{ "error": "Validation failed", "issues": { ... } }` (מבנה Zod flatten).

## 3. Pagination – total / limit / offset

`GET /api/projects?limit=2&offset=0` מחזיר:

- `projects`, `limit`, `offset`, **`total`** (ספירה מלאה).
- דוגמה: `{ "projects": [...], "limit": 2, "offset": 0, "total": 5 }`.

## 4. Audit – request_id + before/after

1. שליחת `PATCH /api/projects/:projectId/tasks/:taskId` עם שינוי `status` וכותרת `x-request-id: <uuid>`.
2. קריאה ל־`GET /api/projects/:projectId/audit?limit=1`.
3. רשומת audit תכלול `request_id` ו־`details: { before: { status }, after: { status } }`.

## 5. Restore test

בוצע (גם בסביבת dev): לרשום תאריך ב־**RESTORE-TEST-DONE.md** לאחר הרצת restore מ־Supabase (Backups / PITR) ואימות שהאפליקציה עובדת. ראה INFRASTRUCTURE.md.
