-- =============================================================================
-- Create public.project_emails (Resend inbound + sent mail log).
-- Run the whole script in Supabase SQL Editor.
-- project_id has no FK so this works even if your projects table/schema differs;
-- the app still validates the project.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.project_emails (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL,
  direction text NOT NULL CHECK (direction IN ('received', 'sent')),
  from_email text,
  to_emails jsonb NOT NULL DEFAULT '[]'::jsonb,
  subject text,
  body_text text,
  body_html text,
  resend_email_id text,
  sent_by_user_id uuid,
  sent_by_username text,
  attachments jsonb NOT NULL DEFAULT '[]'::jsonb,
  lab_import_meta jsonb DEFAULT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_project_emails_project_created
  ON public.project_emails (project_id, created_at DESC);

COMMENT ON TABLE public.project_emails IS 'Inbox/outbox per project (Resend). lab_import_meta: incomplete Lab email attachment handling.';

-- Optional: enforce FK to public.projects if that table exists (uncomment to apply)
-- ALTER TABLE public.project_emails
--   DROP CONSTRAINT IF EXISTS project_emails_project_id_fkey;
-- ALTER TABLE public.project_emails
--   ADD CONSTRAINT project_emails_project_id_fkey
--   FOREIGN KEY (project_id) REFERENCES public.projects (id) ON DELETE CASCADE;
