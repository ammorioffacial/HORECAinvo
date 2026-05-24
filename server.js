// ================================================================
//  Invoice Workflow Tracker — Express + Supabase (DB + Storage)
//  Auth    : express-session + ADMIN_USERNAME / ADMIN_PASSWORD env vars
//  Database: Supabase PostgreSQL via supabase-js client
//  Storage : Supabase Storage bucket "invoices"
//  Deploy  : Render (monolithic — serves frontend + API)
// ================================================================
require('dotenv').config();

const express          = require('express');
const session          = require('express-session');
const path             = require('path');
const multer           = require('multer');
const { createClient } = require('@supabase/supabase-js');

// ════════════════════════════════════════════════════════════════
//  BOOT GUARD — fail fast with actionable messages
// ════════════════════════════════════════════════════════════════
const REQUIRED_ENV = [
  'SUPABASE_URL',
  'SUPABASE_KEY',
  'ADMIN_USERNAME',
  'ADMIN_PASSWORD',
  'SESSION_SECRET',
];
const missing = REQUIRED_ENV.filter(k => !process.env[k]);
if (missing.length) {
  console.error('\n❌  Missing required environment variables:');
  missing.forEach(k => console.error(`    • ${k}`));
  console.error('\n    Set them in your .env file (local) or Render dashboard (production).\n');
  process.exit(1);
}

// ════════════════════════════════════════════════════════════════
//  1. SUPABASE CLIENT (service_role key → bypasses RLS)
// ════════════════════════════════════════════════════════════════
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY,
  {
    auth: {
      persistSession:     false,
      autoRefreshToken:   false,
      detectSessionInUrl: false,
    },
  }
);

const BUCKET = process.env.SUPABASE_BUCKET || 'invoices';

console.log(`☁️   Supabase  →  ${process.env.SUPABASE_URL}`);
console.log(`🪣   Bucket    →  "${BUCKET}"`);

// ════════════════════════════════════════════════════════════════
//  2. DATABASE BOOTSTRAP — verify table exists on startup
// ════════════════════════════════════════════════════════════════
async function initDb() {
  const { error } = await supabase
    .from('invoices')
    .select('id')
    .limit(1);

  if (error) {
    if (error.code === '42P01' || error.message?.includes('does not exist')) {
      console.error('\n❌  Table "invoices" not found.');
      console.error('    Run schema.sql once in Supabase → SQL Editor, then redeploy.\n');
    } else {
      console.error('\n❌  Database error:', error.message);
      console.error('    Check SUPABASE_URL and SUPABASE_KEY.\n');
    }
    process.exit(1);
  }

  console.log('✅  Database ready');
}

// ════════════════════════════════════════════════════════════════
//  3. MULTER — memory storage (no disk writes ever)
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
  limits:  { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    ALLOWED_EXT.test(path.extname(file.originalname))
      ? cb(null, true)
      : cb(new Error('نوع الملف غير مدعوم. المسموح: JPG, PNG, GIF, WEBP, PDF'));
  },
});

// ════════════════════════════════════════════════════════════════
//  4. STORAGE HELPERS
// ════════════════════════════════════════════════════════════════
async function uploadToSupabase(buffer, originalName) {
  const ext         = path.extname(originalName).toLowerCase();
  const contentType = MIME_MAP[ext] || 'application/octet-stream';
  const safeName    = originalName.replace(/[^a-zA-Z0-9._-]/g, '_');
  const storagePath = `invoices/${Date.now()}-${safeName}`;

  console.log(`📤  Uploading "${originalName}" (${(buffer.length / 1024).toFixed(1)} KB)…`);

  const { error } = await supabase.storage
    .from(BUCKET)
    .upload(storagePath, buffer, { contentType, upsert: false });

  if (error) throw new Error(`Storage upload failed: ${error.message}`);

  const { data } = supabase.storage.from(BUCKET).getPublicUrl(storagePath);
  console.log(`✅  Stored → ${data.publicUrl}`);
  return { url: data.publicUrl, storagePath };
}

async function deleteFromSupabase(storagePath) {
  if (!storagePath) return;
  try {
    const { error } = await supabase.storage.from(BUCKET).remove([storagePath]);
    if (error) console.warn(`⚠️   Storage delete warning "${storagePath}": ${error.message}`);
    else       console.log(`🗑️   Deleted: ${storagePath}`);
  } catch (err) {
    console.warn(`⚠️   deleteFromSupabase: ${err.message}`);
  }
}

// ════════════════════════════════════════════════════════════════
//  5. EXPRESS APP + MIDDLEWARE
// ════════════════════════════════════════════════════════════════
const app  = express();
const PORT = process.env.PORT || 3000;

// Trust proxy — required on Render (HTTPS reverse proxy)
// Without this, secure cookies are never set because Express sees HTTP internally
app.set('trust proxy', 1);

// Body parsers — MUST come before any route that reads req.body
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Session — server-side, cookie-based
// SESSION_SECRET must be a long random string set in env vars
app.use(session({
  secret:            process.env.SESSION_SECRET,
  resave:            false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure:   process.env.NODE_ENV === 'production', // HTTPS-only on Render
    maxAge:   8 * 60 * 60 * 1000,                   // 8 hours
    sameSite: 'lax',
  },
}));

// Static files (frontend)
app.use(express.static(path.join(__dirname, 'public')));

// ════════════════════════════════════════════════════════════════
//  6. AUTH ROUTES (public — no session required)
// ════════════════════════════════════════════════════════════════

// POST /api/login
// Accepts JSON: { username, password }
// The frontend sends fetch('/api/login', { method:'POST', body: JSON.stringify({...}),
//   headers:{'Content-Type':'application/json'} })
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;

  // Trim whitespace so copy-paste accidents don't cause failures
  const submittedUser = (username || '').trim();
  const submittedPass = (password || '').trim();

  const correctUser = (process.env.ADMIN_USERNAME || '').trim();
  const correctPass = (process.env.ADMIN_PASSWORD || '').trim();

  // Strict comparison against env vars — NO hardcoded fallback
  if (submittedUser === correctUser && submittedPass === correctPass) {
    req.session.authenticated = true;
    req.session.username      = submittedUser;
    console.log(`🔐  Login successful: ${submittedUser}`);
    return res.json({ success: true });
  }

  console.warn(`⚠️   Failed login attempt for username: "${submittedUser}"`);
  // Use the same generic message for both wrong user AND wrong password
  // (don't reveal which one was wrong)
  return res.status(401).json({ error: 'اسم المستخدم أو كلمة المرور غير صحيحة' });
});

// POST /api/logout
app.post('/api/logout', (req, res) => {
  req.session.destroy(err => {
    if (err) console.warn('Session destroy error:', err.message);
    res.clearCookie('connect.sid');
    res.json({ success: true });
  });
});

// GET /api/me — lets the frontend check if a session is still valid on page load
app.get('/api/me', (req, res) => {
  if (req.session.authenticated) {
    return res.json({ authenticated: true, username: req.session.username });
  }
  res.status(401).json({ authenticated: false });
});

// ════════════════════════════════════════════════════════════════
//  7. AUTH GUARD MIDDLEWARE
//     Protects all /api/* routes that come AFTER this point.
//     Login/logout/me are already defined above, so they are unaffected.
// ════════════════════════════════════════════════════════════════
function requireAuth(req, res, next) {
  if (req.session.authenticated) return next();
  res.status(401).json({ error: 'غير مصرح. يرجى تسجيل الدخول أولاً.' });
}

app.use('/api', requireAuth);

// ════════════════════════════════════════════════════════════════
//  8. PROTECTED API ROUTES
// ════════════════════════════════════════════════════════════════

// ── GET /api/stats ────────────────────────────────────────────
app.get('/api/stats', async (_req, res) => {
  try {
    const { data, error } = await supabase
      .from('invoices')
      .select('status, amount');

    if (error) throw new Error(error.message);

    const total       = data.length;
    const processed   = data.filter(r => r.status === 'Processed').length;
    const pending     = data.filter(r => r.status === 'Pending').length;
    const postponed   = data.filter(r => r.status === 'Postponed').length;
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

    if (!invoice_number?.trim())
      return res.status(400).json({ error: 'رقم الفاتورة مطلوب' });
    if (amount === undefined || amount === null || amount === '')
      return res.status(400).json({ error: 'مبلغ الفاتورة مطلوب' });
    if (!status)
      return res.status(400).json({ error: 'حالة الفاتورة مطلوبة' });

    const VALID = ['Processed', 'Pending', 'Postponed'];
    if (!VALID.includes(status))
      return res.status(400).json({ error: 'قيمة الحالة غير صحيحة' });

    let image_path = null, image_storage_path = null;
    if (req.file) {
      const saved        = await uploadToSupabase(req.file.buffer, req.file.originalname);
      image_path         = saved.url;
      image_storage_path = saved.storagePath;
    }

    const finalReason = (status === 'Pending' || status === 'Postponed')
      ? (reason?.trim() || null) : null;

    const { data, error } = await supabase
      .from('invoices')
      .insert({ invoice_number: invoice_number.trim(), amount: parseFloat(amount),
                image_path, image_storage_path, status, reason: finalReason })
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

    const { data: current, error: fetchErr } = await supabase
      .from('invoices').select('*').eq('id', id).single();
    if (fetchErr) return res.status(404).json({ error: 'الفاتورة غير موجودة' });

    const VALID = ['Processed', 'Pending', 'Postponed'];
    if (status && !VALID.includes(status))
      return res.status(400).json({ error: 'قيمة الحالة غير صحيحة' });

    let image_path = current.image_path, image_storage_path = current.image_storage_path;

    if (req.file) {
      if (current.image_storage_path) await deleteFromSupabase(current.image_storage_path);
      const saved    = await uploadToSupabase(req.file.buffer, req.file.originalname);
      image_path         = saved.url;
      image_storage_path = saved.storagePath;
    }

    const finalStatus = status || current.status;
    const finalReason = (finalStatus === 'Pending' || finalStatus === 'Postponed')
      ? (reason?.trim() ?? current.reason) : null;

    const { data, error: updateErr } = await supabase
      .from('invoices')
      .update({
        invoice_number:     invoice_number?.trim() || current.invoice_number,
        amount:             (amount !== undefined && amount !== '') ? parseFloat(amount) : current.amount,
        image_path, image_storage_path,
        status: finalStatus, reason: finalReason,
      })
      .eq('id', id).select().single();

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
    const { data: inv, error: fetchErr } = await supabase
      .from('invoices').select('image_storage_path').eq('id', req.params.id).single();
    if (fetchErr) return res.status(404).json({ error: 'الفاتورة غير موجودة' });

    if (inv.image_storage_path) await deleteFromSupabase(inv.image_storage_path);

    const { error: deleteErr } = await supabase
      .from('invoices').delete().eq('id', req.params.id);
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
//  9. BOOT
// ════════════════════════════════════════════════════════════════
initDb()
  .then(() => {
    app.listen(PORT, () =>
      console.log(`\n🚀  متتبع الفواتير يعمل على http://localhost:${PORT}\n`)
    );
  })
  .catch(err => {
    console.error('❌  Boot failed:', err.message);
    process.exit(1);
  });
