# שכבת Import וסנכרון – מערכת הניהול (maneger)

כל המבנה הבא נמצא **במערכת הניהול (maneger)** בלבד – לא ב-MATRIYA.

## 1. Import Log

- **טבלה:** `import_log`
- **שדות:** `source_file_reference`, `source_type`, `created_count`, `updated_count`, `error_count`, `details` (JSONB), `project_id`, `created_at`
- **API:** `GET /api/projects/:projectId/import/log` – רשימת רשומות ייבוא (עם pagination)
- כל קריאה ל-`POST /api/projects/:projectId/import/sharepoint-file` כותבת רשומה ל-`import_log`.

## 2. מקור הנתונים (Source File Reference)

- **טבלה:** `lab_experiments`
- **שדה:** `source_file_reference` (TEXT) – מאפשר תמיד לחזור למסמך המקורי ב-SharePoint (או לנתיב הקובץ).
- נשמר בכל ניסוי שיובא דרך `POST /api/projects/:projectId/import/sharepoint-file`.

## 3. גרסאות ניסוי

- **שדה:** `experiment_version` (INTEGER) בטבלת `lab_experiments`.
- בעדכון ניסוי קיים (upsert לפי `experiment_id`) הגרסה עולה אוטומטית.
- מאפשר לדעת אם ניסוי עודכן או שונה לאורך זמן.

## 4. Import Endpoint

- **Endpoint:** `POST /api/projects/:projectId/import/sharepoint-file`
- **Body (JSON):**
  - `source_file_reference` (חובה) – מזהה הקובץ/מסמך ב-SharePoint (או נתיב).
  - `experiments` (מערך) – כל איבר: `experiment_id`, `technology_domain`, `formula`, `materials`, `percentages`, `results`, `experiment_outcome`, `is_production_formula`, `research_session_id` (אופציונלי), `experiment_version` (אופציונלי).
- מטפל ב-upsert ל-`lab_experiments` ורושם רשומה ל-`import_log` (created/updated/error counts + details).

## 5. Sync Validation

- **Endpoint:** `POST /api/projects/:projectId/experiments/sync-to-matriya`
- לפני שליחה ל-MATRIYA מתבצעת ולידציה שכל ניסוי כולל:
  - `technology_domain`
  - `experiment_outcome` (אחד מ: success, failure, partial, production_formula)
  - `is_production_formula`
  - `materials` (לפחות שדה קיים, גם מערך ריק)
  - `percentages` (לפחות שדה קיים, גם אובייקט ריק)
- אם יש שגיאות ולידציה – מחזיר 400 עם `validation_errors`. אחרת שולח ל-`MATRIYA_BACK_URL/sync/experiments` ומחזיר את תשובת MATRIYA.

## 6. Research Sessions

- **טבלה:** `research_sessions` (לפי פרויקט: `project_id`, `name`, `started_at`).
- **API:**
  - `GET /api/projects/:projectId/research-sessions` – רשימת סשנים.
  - `POST /api/projects/:projectId/research-sessions` – יצירת סשן (body: `name`).
- ב-`lab_experiments` שדה אופציונלי `research_session_id` – קישור ניסוי לסשן מחקרי, כדי לראות מסלול ניסויים ולא רק בודדים.

## 7. Material Library

- **טבלה:** `material_library` (לפי פרויקט: `project_id`, `name`, `role_or_function`).
- **API:**
  - `GET /api/projects/:projectId/material-library` – רשימת חומרי גלם.
  - `POST /api/projects/:projectId/material-library` – הוספה/עדכון (body: `name`, `role_or_function`).
- מאפשר ל-analysis להבין תפקידים של חומרים בפורמולציות (השימוש ב-analysis עצמו יכול להתווסף בהמשך).

---

## הרצת הסכמה

כדי ליצור את הטבלאות במערכת הניהול, להריץ ב-Supabase SQL Editor את החלק הרלוונטי מ-`supabase_schema.sql` (טבלאות: `import_log`, `research_sessions`, `lab_experiments`, `material_library`), או את הקובץ המלא אם זו התקנה חדשה.
