# לק ב' – מערכת בקרת מעבדה (Laboratory Control System)

**מערכת חדשה, עצמאית, המתממשקת ל-MATRIYA.**

---

## זהות המערכת

| רכיב | עמדה |
|------|------|
| **Service** | עצמאי |
| **DB** | עצמאי |
| **Backend** | עצמאי |
| **API** | עצמאי |
| **Frontend** | עצמאי |

- מתממשק ל-MATRIYA **דרך API בלבד**.
- **אין גישה ישירה ל-DB של מטריה**.
- **לא מסך נוסף בתוך מטריה** – אפליקציה נפרדת.

---

## ארכיטקטורה בסיסית מחויבת

### Multi-Tenant בסיסי

- **Organization** (ארגון)
- **Projects** (פרויקטים)
- **Isolation אמיתי ברמת DB** – נתונים ממוקדים לפי ארגון/פרויקט.

### Data Model מתוכנן

- **Experiment** (ניסוי)
- **Run** (הרצה)
- **Feature** (תכונה)
- **Feature Version** (גרסת תכונה)
- **Governance Snapshot** (צילום ממשל)
- **Audit Log** (יומן ביקורת)

### הפרדה ברורה בין

- **Infrastructure** (תשתית)
- **Governance** (ממשל)
- **Domain Logic** (לוגיקת דומיין)
- **API Layer** (שכבת API)

---

## אינטגרציה למטריה

המערכת מתממשקת ל-MATRIYA **רק דרך API**. אין גישה ל-DB של מטריה.

### ממשקי MATRIYA שהמערכת תספק / תשתמש בהם

| פעולה | תיאור |
|--------|--------|
| **GET Experiments** | קבלת ניסויים ממטריה |
| **POST Run** | שליחת הרצה למטריה |
| **GET Snapshots** | קבלת צילומי ממשל |
| **GET Violations** | קבלת הפרות |
| **POST Governance Action** | ביצוע פעולת ממשל |

*מימוש עתידי: כל הקריאות למטריה יבוצעו דרך ה-API של מטריה (MATRIYA_BACK_URL), ללא גישה ל-DB.*

### אינטגרציה קיימת כיום (דרך API בלבד)

- **Auth**: התחברות/הרשמה/משתמש נוכחי – פרוקסי ל-`MATRIYA_BACK_URL/auth/*`
- **Ingest**: העלאת קבצים ל-RAG – `POST MATRIYA_BACK_URL/ingest/file`
- **Research**: יצירת סשן ושאילתות – `POST MATRIYA_BACK_URL/research/session`, `POST MATRIYA_BACK_URL/api/research/run`
- **Users list**: רשימת משתמשים – `GET MATRIYA_BACK_URL/auth/users`

---

## מבנה המערכת הנוכחי

- **maneger-back**: Backend עצמאי (Node/Express), DB ב-Supabase (סכמה ב-`supabase_schema.sql`).
- **maneger-front**: Frontend עצמאי (React), מתחבר ל-API של maneger-back בלבד.
- **MATRIYA**: נגיש רק דרך `MATRIYA_BACK_URL` – אין שיתוף DB או קוד.

---

*מסמך זה מגדיר את עקרונות הארכיטקטורה והאינטגרציה של מערכת בקרת המעבדה (לק ב') עם MATRIYA.*
