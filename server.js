// ================================================================
//  Invoice Workflow Tracker — Express + Supabase (DB + Storage)
//  Auth    : express-session + multi-user role-based (manager / employee)
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
  'MANAGER_USERNAME',
  'MANAGER_PASSWORD',
  'DANIEL_USERNAME',
  'DANIEL_PASSWORD',
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

const BUCKET = 'invoices'; // hardcoded — must match the bucket name in Supabase Storage

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
  const storagePath = `${Date.now()}-${safeName}`;

  console.log(`📤  Uploading "${originalName}" (${(buffer.length / 1024).toFixed(1)} KB)…`);

  const { error } = await supabase.storage
    .from('invoices')
    .upload(storagePath, buffer, { contentType, upsert: false });

  if (error) throw new Error(`Storage upload failed: ${error.message}`);

  const { data } = supabase.storage.from('invoices').getPublicUrl(storagePath);
  console.log(`✅  Stored → ${data.publicUrl}`);
  return { url: data.publicUrl, storagePath };
}

async function deleteFromSupabase(storagePath) {
  if (!storagePath) return;
  try {
    const { error } = await supabase.storage.from('invoices').remove([storagePath]);
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
app.set('trust proxy', 1);

// Body parsers
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Session
app.use(session({
  secret:            process.env.SESSION_SECRET,
  resave:            false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure:   process.env.NODE_ENV === 'production',
    maxAge:   8 * 60 * 60 * 1000,   // 8 hours
    sameSite: 'lax',
  },
}));

// Static files (frontend)
app.use(express.static(path.join(__dirname, 'public')));

// ════════════════════════════════════════════════════════════════
//  6. AUTH ROUTES (public — no session required)
// ════════════════════════════════════════════════════════════════

// POST /api/login
// Checks credentials against two user accounts:
//   manager  → MANAGER_USERNAME / MANAGER_PASSWORD  (role: 'manager')
//   employee → DANIEL_USERNAME  / DANIEL_PASSWORD   (role: 'employee')
app.post('/api/login', (req, res) => {
  const submittedUser = (req.body.username || '').trim();
  const submittedPass = (req.body.password || '').trim();

  const managerUser = (process.env.MANAGER_USERNAME || '').trim();
  const managerPass = (process.env.MANAGER_PASSWORD || '').trim();
  const danielUser  = (process.env.DANIEL_USERNAME  || '').trim();
  const danielPass  = (process.env.DANIEL_PASSWORD  || '').trim();

  let role = null;

  if (submittedUser === managerUser && submittedPass === managerPass) {
    role = 'manager';
  } else if (submittedUser === danielUser && submittedPass === danielPass) {
    role = 'employee';
  }

  if (role) {
    req.session.authenticated = true;
    req.session.username      = submittedUser;
    req.session.role          = role;
    console.log(`🔐  Login successful: ${submittedUser} (${role})`);
    return res.json({ success: true, role });
  }

  console.warn(`⚠️   Failed login attempt for username: "${submittedUser}"`);
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

// GET /api/me — frontend session check on page load
app.get('/api/me', (req, res) => {
  if (req.session.authenticated) {
    return res.json({
      authenticated: true,
      username:      req.session.username,
      role:          req.session.role,
    });
  }
  res.status(401).json({ authenticated: false });
});

// ════════════════════════════════════════════════════════════════
//  7. AUTH GUARD MIDDLEWARE
// ════════════════════════════════════════════════════════════════
function requireAuth(req, res, next) {
  if (req.session.authenticated) return next();
  res.status(401).json({ error: 'غير مصرح. يرجى تسجيل الدخول أولاً.' });
}

// Only-manager guard — rejects employees with 403
function requireManager(req, res, next) {
  if (req.session.role === 'manager') return next();
  console.warn(`🚫  Employee "${req.session.username}" attempted a manager-only action.`);
  res.status(403).json({ error: 'هذا الإجراء مخصص للمدير فقط.' });
}

app.use('/api', requireAuth);

// ════════════════════════════════════════════════════════════════
//  8. PROTECTED API ROUTES
// ════════════════════════════════════════════════════════════════

// Valid status values (4 current + 1 legacy read-only alias)
// 'Postponed' is a legacy value from old DB records — treated same as 'Pending'
const VALID_STATUSES = ['Processed', 'Pending', 'PartialReturn', 'FullReturn', 'Postponed'];

// ── GET /api/stats ────────────────────────────────────────────
app.get('/api/stats', async (_req, res) => {
  try {
    const { data, error } = await supabase
      .from('invoices')
      .select('status, amount');

    if (error) throw new Error(error.message);

    const total         = data.length;
    const processed     = data.filter(r => r.status === 'Processed').length;
    // 'Postponed' is a legacy alias for 'Pending' — count both together
    const pending       = data.filter(r => r.status === 'Pending' || r.status === 'Postponed').length;
    const partialReturn = data.filter(r => r.status === 'PartialReturn').length;
    const fullReturn    = data.filter(r => r.status === 'FullReturn').length;
    const totalAmount   = data.reduce((sum, r) => sum + parseFloat(r.amount || 0), 0);

    res.json({ total, processed, pending, partialReturn, fullReturn, totalAmount });
  } catch (err) {
    console.error('GET /api/stats:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/invoices ─────────────────────────────────────────
// Optional query params:
//   status    — one of the 4 valid statuses
//   dateFrom  — ISO date string, inclusive (e.g. 2025-01-01)
//   dateTo    — ISO date string, inclusive (e.g. 2025-12-31)
app.get('/api/invoices', async (req, res) => {
  try {
    let query = supabase
      .from('invoices')
      .select('*')
      .order('created_at', { ascending: false });

    const { status, dateFrom, dateTo } = req.query;

    if (status && VALID_STATUSES.includes(status)) {
      // 'Pending' filter also returns legacy 'Postponed' rows from old DB records
      if (status === 'Pending') {
        query = query.in('status', ['Pending', 'Postponed']);
      } else {
        query = query.eq('status', status);
      }
    }
    if (dateFrom) {
      query = query.gte('created_at', new Date(dateFrom).toISOString());
    }
    if (dateTo) {
      const end = new Date(dateTo);
      end.setHours(23, 59, 59, 999);
      query = query.lte('created_at', end.toISOString());
    }

    const { data, error } = await query;
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
    if (!VALID_STATUSES.includes(status))
      return res.status(400).json({ error: 'قيمة الحالة غير صحيحة' });

    // ── Duplicate check ───────────────────────────────────────
    const { data: existing, error: dupErr } = await supabase
      .from('invoices')
      .select('id')
      .eq('invoice_number', invoice_number.trim())
      .maybeSingle();
    if (dupErr) throw new Error(dupErr.message);
    if (existing) return res.status(400).json({ error: 'duplicate_invoice' });

    let image_path = null;
    if (req.file) {
      const saved = await uploadToSupabase(req.file.buffer, req.file.originalname);
      image_path  = saved.url;
    }

    // Reason is required only for PartialReturn and FullReturn
    const needsReason = status === 'PartialReturn' || status === 'FullReturn';
    const finalReason = needsReason ? (reason?.trim() || null) : null;

    const { data, error } = await supabase
      .from('invoices')
      .insert({
        invoice_number: invoice_number.trim(),
        amount:         parseFloat(amount),
        image_path,
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

    const { data: current, error: fetchErr } = await supabase
      .from('invoices').select('*').eq('id', id).single();
    if (fetchErr) return res.status(404).json({ error: 'الفاتورة غير موجودة' });

    if (status && !VALID_STATUSES.includes(status))
      return res.status(400).json({ error: 'قيمة الحالة غير صحيحة' });

    let image_path = current.image_path;
    if (req.file) {
      const saved = await uploadToSupabase(req.file.buffer, req.file.originalname);
      image_path  = saved.url;
    }

    const finalStatus = status || current.status;
    const needsReason = finalStatus === 'PartialReturn' || finalStatus === 'FullReturn';
    const finalReason = needsReason
      ? (reason?.trim() ?? current.reason)
      : null;

    const { data, error: updateErr } = await supabase
      .from('invoices')
      .update({
        invoice_number: invoice_number?.trim() || current.invoice_number,
        amount:         (amount !== undefined && amount !== '') ? parseFloat(amount) : current.amount,
        image_path,
        status:         finalStatus,
        reason:         finalReason,
      })
      .eq('id', id).select().single();

    if (updateErr) throw new Error(updateErr.message);
    res.json(data);
  } catch (err) {
    console.error('PUT /api/invoices/:id:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE /api/invoices/:id — MANAGER ONLY ──────────────────
app.delete('/api/invoices/:id', requireManager, async (req, res) => {
  try {
    const { data: inv, error: fetchErr } = await supabase
      .from('invoices').select('image_path').eq('id', req.params.id).single();
    if (fetchErr) return res.status(404).json({ error: 'الفاتورة غير موجودة' });

    if (inv.image_path) await deleteFromSupabase(inv.image_path);

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
