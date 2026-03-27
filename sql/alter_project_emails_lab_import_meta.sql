-- =============================================================================
-- Safe one-shot: creates project_emails if missing, then ensures lab_import_meta.
-- Use this if you only ran ALTER before and got "relation does not exist".
-- Idempotent: safe to run multiple times.
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

ALTER TABLE public.project_emails
  ADD COLUMN IF NOT EXISTS lab_import_meta jsonb DEFAULT NULL;

COMMENT ON TABLE public.project_emails IS 'Inbox/outbox per project (Resend). lab_import_meta: incomplete Lab email attachment handling.';

COMMENT ON COLUMN public.project_emails.lab_import_meta IS 'Lab email import: { status, missing[], updated_at, attachment_id, completion_email_sent }';
