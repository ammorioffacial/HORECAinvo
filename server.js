// ================================================================
//  Invoice Workflow Tracker — Express + Supabase (DB + Storage)
//  • Database  : Supabase PostgreSQL via supabase-js client
//  • Storage   : Supabase Storage bucket "invoices"
//  • No raw pg / no local file writes in production
//  • Deployment: Render (monolithic — serves frontend + API)
// ================================================================
require('dotenv').config();

const express          = require('express');
const path             = require('path');
const fs               = require('fs');
const multer           = require('multer');
const { createClient } = require('@supabase/supabase-js');

// ════════════════════════════════════════════════════════════════
//  BOOT GUARD — crash early with a clear message if creds missing
// ════════════════════════════════════════════════════════════════
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_KEY) {
  console.error(
    '\n❌  SUPABASE_URL and SUPABASE_KEY must be set.\n' +
    '    Copy .env.example → .env and fill in your Supabase credentials.\n'
  );
  process.exit(1);
}

// ════════════════════════════════════════════════════════════════
//  1. SUPABASE CLIENT
//     Uses the service_role key → bypasses RLS for server-side ops
// ════════════════════════════════════════════════════════════════
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY,
  {
    auth: {
      // Running server-side — disable auto session / token refresh
      persistSession:    false,
      autoRefreshToken:  false,
      detectSessionInUrl:false,
    },
  }
);

const BUCKET = process.env.SUPABASE_BUCKET || 'invoices';

console.log(`☁️   Supabase connected  →  ${process.env.SUPABASE_URL}`);
console.log(`🪣   Storage bucket      →  "${BUCKET}"`);

// ════════════════════════════════════════════════════════════════
//  2. DATABASE BOOTSTRAP
//     Creates the invoices table if it does not exist.
//     Uses supabase.rpc to run raw SQL (service_role can do this).
// ════════════════════════════════════════════════════════════════
async function initDb() {
  // We use the REST API's rpc endpoint to execute DDL.
  // If you prefer, run this SQL once manually in Supabase SQL Editor.
  const { error } = await supabase.rpc('init_invoices_table').catch(() => ({ error: null }));
  // rpc may not exist yet — that's fine; table creation is below via raw query
  // Supabase doesn't expose raw DDL through the JS client directly, so we use
  // the pg-compatible query endpoint available via the REST API.
  // Best practice: run the CREATE TABLE in Supabase SQL Editor once.
  // We'll attempt it here via a workaround using a dummy select to check existence.

  const { error: checkError } = await supabase
    .from('invoices')
    .select('id')
    .limit(1);

  if (checkError && checkError.code === '42P01') {
    // Table does not exist — this should be created via Supabase SQL Editor.
    // Log the SQL so the user can run it manually.
    console.warn('\n⚠️   The "invoices" table does not exist in your Supabase database.');
    console.warn('    Please run the following SQL in Supabase Dashboard → SQL Editor:\n');
    console.warn(`
CREATE TABLE IF NOT EXISTS invoices (
  id                  BIGSERIAL     PRIMARY KEY,
  invoice_number      TEXT          NOT NULL,
  amount              NUMERIC(15,2) NOT NULL DEFAULT 0,
  image_path          TEXT,
  image_storage_path  TEXT,
  status              TEXT          NOT NULL
                      CHECK (status IN ('Processed','Pending','Postponed')),
  reason              TEXT,
  created_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_invoices_status     ON invoices(status);
CREATE INDEX IF NOT EXISTS idx_invoices_created_at ON invoices(created_at DESC);
    `);
    console.warn('    Then restart the server.\n');
    process.exit(1);
  }

  if (checkError && checkError.code !== '42P01') {
    throw new Error(`Database check failed: ${checkError.message}`);
  }

  console.log('✅  Database table "invoices" is ready');
}

// ════════════════════════════════════════════════════════════════
//  3. MULTER — memory storage (buffer → Supabase, no disk writes)
// ════════════════════════════════════════════════════════════════
const ALLOWED_EXT = /\.(jpe?g|png|gif|webp|pdf)$/i;
const MIME_MAP = {
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png':  'image/png',
  '.gif':  'image/gif',
  '.webp': 'image/webp',
  '.pdf':  'application/pdf',
};

const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 10 * 1024 * 1024 }, // 10 MB
  fileFilter: (_req, file, cb) => {
    ALLOWED_EXT.test(path.extname(file.originalname))
      ? cb(null, true)
      : cb(new Error('نوع الملف غير مدعوم. المسموح: JPG, PNG, GIF, WEBP, PDF'));
  },
});

// ════════════════════════════════════════════════════════════════
//  4. STORAGE HELPERS
// ════════════════════════════════════════════════════════════════

/**
 * uploadToSupabase(buffer, originalName)
 * Uploads a file buffer to Supabase Storage.
 * Returns { url, storagePath }
 *   url         — permanent public HTTPS URL → saved in image_path column
 *   storagePath — bucket-relative path       → saved in image_storage_path column
 *                 (used later to delete the file when invoice is updated/deleted)
 */
async function uploadToSupabase(buffer, originalName) {
  const ext         = path.extname(originalName).toLowerCase();
  const contentType = MIME_MAP[ext] || 'application/octet-stream';

  // Unique, safe filename: timestamp + sanitised original name
  const safeName    = originalName.replace(/[^a-zA-Z0-9._-]/g, '_');
  const storagePath = `invoices/${Date.now()}-${safeName}`;

  console.log(`📤  Uploading "${originalName}" (${(buffer.length / 1024).toFixed(1)} KB) → Supabase bucket "${BUCKET}"…`);

  const { error: uploadError } = await supabase.storage
    .from(BUCKET)
    .upload(storagePath, buffer, { contentType, upsert: false });

  if (uploadError) {
    throw new Error(`Supabase Storage upload failed: ${uploadError.message}`);
  }

  // getPublicUrl is synchronous — it constructs the URL locally, no network call
  const { data } = supabase.storage.from(BUCKET).getPublicUrl(storagePath);

  console.log(`✅  Stored → ${data.publicUrl}`);
  return { url: data.publicUrl, storagePath };
}

/**
 * deleteFromSupabase(storagePath)
 * Deletes a file from Supabase Storage. Never throws — a failed delete
 * should not block the user's main action (edit/delete invoice).
 */
async function deleteFromSupabase(storagePath) {
  if (!storagePath) return;
  try {
    const { error } = await supabase.storage.from(BUCKET).remove([storagePath]);
    if (error) {
      console.warn(`⚠️   Could not delete storage object "${storagePath}": ${error.message}`);
    } else {
      console.log(`🗑️   Deleted storage object: ${storagePath}`);
    }
  } catch (err) {
    console.warn(`⚠️   deleteFromSupabase exception: ${err.message}`);
  }
}

// ════════════════════════════════════════════════════════════════
//  5. EXPRESS APP + MIDDLEWARE
// ════════════════════════════════════════════════════════════════
const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// ════════════════════════════════════════════════════════════════
//  6. API ROUTES
// ════════════════════════════════════════════════════════════════

// ── GET /api/stats ────────────────────────────────────────────
app.get('/api/stats', async (_req, res) => {
  try {
    // Fetch all invoices (small dataset — single clerk system)
    const { data, error } = await supabase
      .from('invoices')
      .select('status, amount');

    if (error) throw new Error(error.message);

    const total      = data.length;
    const processed  = data.filter(r => r.status === 'Processed').length;
    const pending    = data.filter(r => r.status === 'Pending').length;
    const postponed  = data.filter(r => r.status === 'Postponed').length;
    const totalAmount = data.reduce((sum, r) => sum + parseFloat(r.amount || 0), 0);

    res.json({ total, processed, pending, postponed, totalAmount });
  } catch (err) {
    console.error('GET /api/stats:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/invoices ─────────────────────────────────────────
app.get('/api/invoices', async (_req, res) => {
  try {
    const { data, error } = await supabase
      .from('invoices')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) throw new Error(error.message);
    res.json(data);
  } catch (err) {
    console.error('GET /api/invoices:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/invoices/:id ─────────────────────────────────────
app.get('/api/invoices/:id', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('invoices')
      .select('*')
      .eq('id', req.params.id)
      .single();

    if (error) return res.status(404).json({ error: 'الفاتورة غير موجودة' });
    res.json(data);
  } catch (err) {
    console.error('GET /api/invoices/:id:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/invoices — CREATE ───────────────────────────────
app.post('/api/invoices', upload.single('image'), async (req, res) => {
  try {
    const { invoice_number, amount, status, reason } = req.body;

    // ── Input validation ────────────────────────────────────
    if (!invoice_number?.trim())
      return res.status(400).json({ error: 'رقم الفاتورة مطلوب' });
    if (amount === undefined || amount === null || amount === '')
      return res.status(400).json({ error: 'مبلغ الفاتورة مطلوب' });
    if (!status)
      return res.status(400).json({ error: 'حالة الفاتورة مطلوبة' });

    const VALID = ['Processed', 'Pending', 'Postponed'];
    if (!VALID.includes(status))
      return res.status(400).json({ error: 'قيمة الحالة غير صحيحة' });

    // ── Upload image to Supabase Storage ────────────────────
    let image_path         = null;
    let image_storage_path = null;

    if (req.file) {
      const saved        = await uploadToSupabase(req.file.buffer, req.file.originalname);
      image_path         = saved.url;          // public URL → displayed in UI
      image_storage_path = saved.storagePath;  // bucket path → used for deletion later
    }

    const finalReason = (status === 'Pending' || status === 'Postponed')
      ? (reason?.trim() || null)
      : null;

    // ── Insert into Supabase DB ─────────────────────────────
    const { data, error } = await supabase
      .from('invoices')
      .insert({
        invoice_number: invoice_number.trim(),
        amount:         parseFloat(amount),
        image_path,
        image_storage_path,
        status,
        reason:         finalReason,
      })
      .select()
      .single();

    if (error) throw new Error(error.message);
    res.status(201).json(data);
  } catch (err) {
    console.error('POST /api/invoices:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── PUT /api/invoices/:id — UPDATE ───────────────────────────
app.put('/api/invoices/:id', upload.single('image'), async (req, res) => {
  try {
    const id = req.params.id;
    const { invoice_number, amount, status, reason } = req.body;

    // ── Fetch current record ────────────────────────────────
    const { data: current, error: fetchErr } = await supabase
      .from('invoices')
      .select('*')
      .eq('id', id)
      .single();

    if (fetchErr) return res.status(404).json({ error: 'الفاتورة غير موجودة' });

    const VALID = ['Processed', 'Pending', 'Postponed'];
    if (status && !VALID.includes(status))
      return res.status(400).json({ error: 'قيمة الحالة غير صحيحة' });

    // ── Handle image replacement ────────────────────────────
    let image_path         = current.image_path;
    let image_storage_path = current.image_storage_path;

    if (req.file) {
      // Step 1: delete old file from Supabase Storage
      if (current.image_storage_path) {
        await deleteFromSupabase(current.image_storage_path);
      }
      // Step 2: upload new file
      const saved        = await uploadToSupabase(req.file.buffer, req.file.originalname);
      image_path         = saved.url;
      image_storage_path = saved.storagePath;
    }

    const finalStatus = status || current.status;
    const finalReason = (finalStatus === 'Pending' || finalStatus === 'Postponed')
      ? (reason?.trim() ?? current.reason)
      : null;

    // ── Update in Supabase DB ───────────────────────────────
    const { data, error: updateErr } = await supabase
      .from('invoices')
      .update({
        invoice_number:     invoice_number?.trim()  || current.invoice_number,
        amount:             (amount !== undefined && amount !== '')
                              ? parseFloat(amount)
                              : current.amount,
        image_path,
        image_storage_path,
        status:             finalStatus,
        reason:             finalReason,
      })
      .eq('id', id)
      .select()
      .single();

    if (updateErr) throw new Error(updateErr.message);
    res.json(data);
  } catch (err) {
    console.error('PUT /api/invoices/:id:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE /api/invoices/:id ──────────────────────────────────
app.delete('/api/invoices/:id', async (req, res) => {
  try {
    // Fetch first so we have the storage path to delete
    const { data: inv, error: fetchErr } = await supabase
      .from('invoices')
      .select('image_storage_path')
      .eq('id', req.params.id)
      .single();

    if (fetchErr) return res.status(404).json({ error: 'الفاتورة غير موجودة' });

    // Delete image from Supabase Storage (if any)
    if (inv.image_storage_path) {
      await deleteFromSupabase(inv.image_storage_path);
    }

    // Delete DB row
    const { error: deleteErr } = await supabase
      .from('invoices')
      .delete()
      .eq('id', req.params.id);

    if (deleteErr) throw new Error(deleteErr.message);
    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /api/invoices/:id:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── SPA fallback ──────────────────────────────────────────────
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ════════════════════════════════════════════════════════════════
//  7. BOOT
// ════════════════════════════════════════════════════════════════
initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`\n🚀  متتبع الفواتير يعمل على http://localhost:${PORT}\n`);
    });
  })
  .catch(err => {
    console.error('❌  Boot failed:', err.message);
    process.exit(1);
  });
