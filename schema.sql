-- ================================================================
--  Invoice Workflow Tracker — Supabase SQL Schema
--  Run this ONCE in: Supabase Dashboard → SQL Editor → New Query
-- ================================================================

-- ── Main table ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS invoices (
  id                  BIGSERIAL     PRIMARY KEY,
  invoice_number      TEXT          NOT NULL,
  amount              NUMERIC(15,2) NOT NULL DEFAULT 0,

  -- Storage: Supabase Storage public URL (displayed in UI / modal)
  image_path          TEXT,

  -- Storage: bucket-relative path used to delete the file later
  -- e.g.  invoices/1748012345-receipt.jpg
  image_storage_path  TEXT,

  status              TEXT          NOT NULL
                      CHECK (status IN ('Processed','Pending','Postponed')),

  reason              TEXT,         -- nullable; required only for Pending / Postponed

  created_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- ── Indexes for dashboard queries ────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_invoices_status
  ON invoices(status);

CREATE INDEX IF NOT EXISTS idx_invoices_created_at
  ON invoices(created_at DESC);

-- ================================================================
--  Row Level Security (RLS)
--  Since we use the service_role key server-side, RLS is bypassed
--  automatically. These policies protect the table if anyone ever
--  uses the anon key directly (e.g. from the browser).
-- ================================================================

-- Enable RLS
ALTER TABLE invoices ENABLE ROW LEVEL SECURITY;

-- Block all direct browser/anon access (server uses service_role)
CREATE POLICY "No public access" ON invoices
  FOR ALL USING (false);
