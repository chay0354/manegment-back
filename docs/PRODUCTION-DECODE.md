# Production: show decoded file names (not "קובץ" / "תיקייה")

If the SharePoint bucket list in production shows "קובץ" and "תיקייה" instead of real file/folder names:

1. **Run the display-names migration in your production Supabase**
   - In Supabase Dashboard → SQL Editor, run the contents of:
   - `migrations/005_sharepoint_display_names.sql`
   - This creates the `sharepoint_display_names` table so the backend can store and return Hebrew/English names.

2. **Redeploy backend and frontend**
   - Backend must include the `isManualAsciiPath` fix (paths like `xxxxx.txt`).
   - Frontend must include the change that prefers `displayNamesMap` when rendering.

3. **New uploads** will then get display names saved and will decode. Old files (uploaded before the table existed) have no row; re-upload them to get decoded names.
