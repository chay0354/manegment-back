# Deploy maneger-back to Vercel

1. **Push to GitHub** and import the repo in [Vercel](https://vercel.com) (or connect the `maneger-back` folder as root).

2. **Environment variables** (set in Vercel → Project → Settings → Environment Variables):
   - `SUPABASE_URL` or `NEXT_PUBLIC_SUPABASE_URL` – your Supabase project URL
   - `SUPABASE_SERVICE_ROLE_KEY` or `NEXT_PUBLIC_SUPABASE_ANON_KEY` – Supabase key (prefer service role for backend)
   - `MATRIYA_BACK_URL` – (optional) Matriya backend URL for RAG; leave empty to disable RAG

3. **Deploy.** The app runs as a serverless function. All routes (e.g. `/api/projects`, `/health`) are handled by `server.js`.

4. Use the generated URL (e.g. `https://maneger-back-xxx.vercel.app`) as `VITE_MANEGER_API_URL` in the frontend project.
