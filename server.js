const express  = require('express');
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');
const cors     = require('cors');
const path     = require('path');
const { Pool } = require('pg');

const app        = express();
const PORT       = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'storage-crm-dev-secret';

// Stripe is optional — only active when STRIPE_SECRET_KEY is set
const STRIPE_SECRET = process.env.STRIPE_SECRET_KEY || null;
const STRIPE_PRICE_ID = process.env.STRIPE_PRICE_ID || null;   // monthly subscription price
const APP_URL = process.env.APP_URL || `http://localhost:${PORT}`;

let stripe = null;
if (STRIPE_SECRET) {
  try { stripe = require('stripe')(STRIPE_SECRET); }
  catch { console.warn('stripe package not installed — billing disabled'); }
}

// Resend email is optional — only active when RESEND_API_KEY is set
const RESEND_API_KEY = process.env.RESEND_API_KEY || null;
const FROM_EMAIL = process.env.FROM_EMAIL || 'notifications@example.com';

let resendClient = null;
if (RESEND_API_KEY) {
  try {
    const { Resend } = require('resend');
    resendClient = new Resend(RESEND_API_KEY);
    console.log('✅ Resend email client initialised. FROM_EMAIL:', FROM_EMAIL);
  } catch (e) {
    console.warn('⚠️  resend package not installed — email disabled. Error:', e.message);
  }
} else {
  console.warn('⚠️  RESEND_API_KEY not set — email sending disabled');
}

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Database ──────────────────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});
const db = { query: (text, params) => pool.query(text, params) };

// ── Schema ────────────────────────────────────────────────────────────────────
async function initDb() {
  await db.query(`
    -- ── Companies (one row per storage business) ───────────────────────────
    CREATE TABLE IF NOT EXISTS companies (
      id                  SERIAL PRIMARY KEY,
      name                TEXT NOT NULL DEFAULT '',
      slug                TEXT UNIQUE NOT NULL,        -- short URL-safe identifier
      plan                TEXT DEFAULT 'trial',        -- trial | active | suspended
      stripe_customer_id  TEXT DEFAULT NULL,
      stripe_sub_id       TEXT DEFAULT NULL,
      trial_ends_at       TIMESTAMPTZ DEFAULT NOW() + INTERVAL '14 days',
      created_at          TIMESTAMPTZ DEFAULT NOW()
    );

    -- ── Users (scoped to a company) ────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS users (
      id            SERIAL PRIMARY KEY,
      company_id    INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      username      TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      full_name     TEXT DEFAULT '',
      role          TEXT DEFAULT 'user',   -- admin | user
      created_at    TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (company_id, username)
    );

    -- ── Per-tenant dropdown settings (stored in DB, not localStorage) ──────
    CREATE TABLE IF NOT EXISTS company_settings (
      id          SERIAL PRIMARY KEY,
      company_id  INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE UNIQUE,
      settings    JSONB DEFAULT '{}'::jsonb,
      updated_at  TIMESTAMPTZ DEFAULT NOW()
    );

    -- ── Containers ─────────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS containers (
      id                  SERIAL PRIMARY KEY,
      company_id          INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      container_number    TEXT NOT NULL,
      container_size      TEXT DEFAULT '20ft',
      location            TEXT DEFAULT 'Back Row',
      order_date          DATE,
      start_date          DATE,
      end_date            DATE,
      customer_name       TEXT DEFAULT '',
      joining_email_sent  BOOLEAN DEFAULT FALSE,
      id_check            BOOLEAN DEFAULT FALSE,
      phone               TEXT DEFAULT '',
      email               TEXT DEFAULT '',
      address1            TEXT DEFAULT '',
      address2            TEXT DEFAULT '',
      postcode            TEXT DEFAULT '',
      contract_signed     BOOLEAN DEFAULT FALSE,
      insurance           BOOLEAN DEFAULT FALSE,
      monthly_rate        NUMERIC(10,2) DEFAULT 0,
      intro_rate          NUMERIC(10,2) DEFAULT NULL,
      intro_months        INTEGER DEFAULT NULL,
      payment_status      TEXT DEFAULT 'Pending',
      notes               TEXT DEFAULT '',
      converted_from_prospect_id INTEGER DEFAULT NULL,
      created_at          TIMESTAMPTZ DEFAULT NOW(),
      updated_at          TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (company_id, container_number)
    );

    -- ── Prospects ──────────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS prospects (
      id          SERIAL PRIMARY KEY,
      company_id  INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      name        TEXT NOT NULL DEFAULT '',
      email       TEXT DEFAULT '',
      phone       TEXT DEFAULT '',
      address1    TEXT DEFAULT '',
      address2    TEXT DEFAULT '',
      postcode    TEXT DEFAULT '',
      source      TEXT DEFAULT '',
      status      TEXT DEFAULT 'New',
      notes       TEXT DEFAULT '',
      created_at  TIMESTAMPTZ DEFAULT NOW(),
      updated_at  TIMESTAMPTZ DEFAULT NOW()
    );

    -- ── Payments (recorded payments against containers) ───────────────────
    CREATE TABLE IF NOT EXISTS payments (
      id            SERIAL PRIMARY KEY,
      company_id    INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      container_id  INTEGER REFERENCES containers(id) ON DELETE SET NULL,
      container_number TEXT NOT NULL DEFAULT '',
      customer_name TEXT NOT NULL DEFAULT '',
      amount        NUMERIC(10,2) NOT NULL DEFAULT 0,
      payment_date  DATE NOT NULL DEFAULT CURRENT_DATE,
      method        TEXT DEFAULT 'Bank Transfer',
      notes         TEXT DEFAULT '',
      recorded_by   TEXT DEFAULT '',
      created_at    TIMESTAMPTZ DEFAULT NOW()
    );

    -- ── Prospect Emails (log of sent emails) ──────────────────────────────
    CREATE TABLE IF NOT EXISTS prospect_emails (
      id          SERIAL PRIMARY KEY,
      company_id  INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      prospect_id INTEGER NOT NULL REFERENCES prospects(id) ON DELETE CASCADE,
      to_email    TEXT NOT NULL,
      reply_to    TEXT DEFAULT '',
      subject     TEXT NOT NULL,
      body        TEXT NOT NULL,
      sent_by     TEXT DEFAULT '',
      sent_at     TIMESTAMPTZ DEFAULT NOW()
    );

        -- ── Rental History ─────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS rental_history (
      id                  SERIAL PRIMARY KEY,
      company_id          INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      container_number    TEXT NOT NULL,
      container_size      TEXT,
      location            TEXT,
      order_date          DATE,
      start_date          DATE,
      end_date            DATE,
      customer_name       TEXT DEFAULT '',
      joining_email_sent  BOOLEAN DEFAULT FALSE,
      id_check            BOOLEAN DEFAULT FALSE,
      phone               TEXT DEFAULT '',
      email               TEXT DEFAULT '',
      address1            TEXT DEFAULT '',
      address2            TEXT DEFAULT '',
      postcode            TEXT DEFAULT '',
      contract_signed     BOOLEAN DEFAULT FALSE,
      insurance           BOOLEAN DEFAULT FALSE,
      monthly_rate        NUMERIC(10,2) DEFAULT 0,
      intro_rate          NUMERIC(10,2) DEFAULT NULL,
      intro_months        INTEGER DEFAULT NULL,
      payment_status      TEXT DEFAULT 'Pending',
      notes               TEXT DEFAULT '',
      archived_at         TIMESTAMPTZ DEFAULT NOW(),
      archived_by         TEXT DEFAULT ''
    );
  `);

  // ── Migrate existing single-tenant tables to multi-tenant ─────────────────
  // These ALTER TABLE statements are safe to run repeatedly (IF NOT EXISTS).
  // They add company_id to any tables created by older versions of the app,
  // and also backfill any other missing columns from previous upgrades.
  const migrations = [
    // Core multi-tenant column on every data table
    `ALTER TABLE IF EXISTS users           ADD COLUMN IF NOT EXISTS company_id INTEGER`,
    `ALTER TABLE IF EXISTS containers      ADD COLUMN IF NOT EXISTS company_id INTEGER`,
    `ALTER TABLE IF EXISTS rental_history  ADD COLUMN IF NOT EXISTS company_id INTEGER`,
    `ALTER TABLE IF EXISTS prospects       ADD COLUMN IF NOT EXISTS company_id INTEGER`,
    // Intro rate columns added in v12
    `ALTER TABLE IF EXISTS containers      ADD COLUMN IF NOT EXISTS intro_rate    NUMERIC(10,2) DEFAULT NULL`,
    `ALTER TABLE IF EXISTS containers      ADD COLUMN IF NOT EXISTS intro_months  INTEGER       DEFAULT NULL`,
    `ALTER TABLE IF EXISTS rental_history  ADD COLUMN IF NOT EXISTS intro_rate    NUMERIC(10,2) DEFAULT NULL`,
    `ALTER TABLE IF EXISTS rental_history  ADD COLUMN IF NOT EXISTS intro_months  INTEGER       DEFAULT NULL`,
    // Ensure updated_at exists on containers
    `ALTER TABLE IF EXISTS containers      ADD COLUMN IF NOT EXISTS updated_at    TIMESTAMPTZ   DEFAULT NOW()`,
    `ALTER TABLE IF EXISTS containers      ADD COLUMN IF NOT EXISTS created_at    TIMESTAMPTZ   DEFAULT NOW()`,
    // prospect_emails table (added in v17) — safe to run repeatedly
    `CREATE TABLE IF NOT EXISTS prospect_emails (id SERIAL PRIMARY KEY, company_id INTEGER NOT NULL, prospect_id INTEGER NOT NULL, to_email TEXT NOT NULL, reply_to TEXT DEFAULT '', subject TEXT NOT NULL, body TEXT NOT NULL, sent_by TEXT DEFAULT '', sent_at TIMESTAMPTZ DEFAULT NOW())`,
    // payments table (added in v18)
    `CREATE TABLE IF NOT EXISTS payments (id SERIAL PRIMARY KEY, company_id INTEGER NOT NULL, container_id INTEGER, container_number TEXT NOT NULL DEFAULT '', customer_name TEXT NOT NULL DEFAULT '', amount NUMERIC(10,2) NOT NULL DEFAULT 0, payment_date DATE NOT NULL DEFAULT CURRENT_DATE, method TEXT DEFAULT 'Bank Transfer', notes TEXT DEFAULT '', recorded_by TEXT DEFAULT '', created_at TIMESTAMPTZ DEFAULT NOW())`,
    // converted_from_prospect_id on containers (added in v19)
    `ALTER TABLE IF EXISTS containers ADD COLUMN IF NOT EXISTS converted_from_prospect_id INTEGER DEFAULT NULL`,
    // Ensure prospects has all fields
    `ALTER TABLE IF EXISTS prospects       ADD COLUMN IF NOT EXISTS address1      TEXT DEFAULT ''`,
    `ALTER TABLE IF EXISTS prospects       ADD COLUMN IF NOT EXISTS address2      TEXT DEFAULT ''`,
    `ALTER TABLE IF EXISTS prospects       ADD COLUMN IF NOT EXISTS postcode      TEXT DEFAULT ''`,
    `ALTER TABLE IF EXISTS prospects       ADD COLUMN IF NOT EXISTS updated_at    TIMESTAMPTZ DEFAULT NOW()`,
  ];
  for (const sql of migrations) {
    try { await db.query(sql); } catch (e) { console.warn('Migration skipped:', e.message); }
  }
  console.log('✓ Schema migrations applied');

  // ── Super-admin company (dev / demo) ───────────────────────────────────────
  const { rows: cos } = await db.query("SELECT id FROM companies WHERE slug='demo'");
  let demoCompanyId;
  if (cos.length === 0) {
    const { rows: newCo } = await db.query(
      `INSERT INTO companies (name, slug, plan) VALUES ($1,$2,$3) RETURNING id`,
      ['Demo Storage Co', 'demo', 'active']
    );
    demoCompanyId = newCo[0].id;
    console.log('✓ Demo company created (id=' + demoCompanyId + ')');
  } else {
    demoCompanyId = cos[0].id;
  }

  // ── Backfill company_id for all rows that pre-date multi-tenancy ────────────
  // Any row with NULL company_id belongs to the original single-tenant install
  // and is assigned to the demo company so existing data is preserved.
  const backfills = [
    `UPDATE users          SET company_id=$1 WHERE company_id IS NULL`,
    `UPDATE containers     SET company_id=$1 WHERE company_id IS NULL`,
    `UPDATE rental_history SET company_id=$1 WHERE company_id IS NULL`,
    `UPDATE prospects      SET company_id=$1 WHERE company_id IS NULL`,
  ];
  for (const sql of backfills) {
    try { const r = await db.query(sql, [demoCompanyId]); if (r.rowCount > 0) console.log('  Backfilled', r.rowCount, 'rows:', sql.split(' ')[1]); }
    catch (e) { console.warn('Backfill skipped:', e.message); }
  }

  // ── Default admin user for demo company ───────────────────────────────────
  const { rows: us } = await db.query(
    "SELECT id FROM users WHERE company_id=$1 AND username='admin'", [demoCompanyId]
  );
  if (us.length === 0) {
    // Check for a legacy admin user that existed before multi-tenancy (no company_id)
    const { rows: legacy } = await db.query(
      "SELECT id FROM users WHERE username='admin' AND (company_id IS NULL OR company_id=0)"
    );
    if (legacy.length > 0) {
      await db.query("UPDATE users SET company_id=$1, role='admin' WHERE id=$2",
        [demoCompanyId, legacy[0].id]);
      console.log('✓ Legacy admin user migrated to demo company');
    } else {
      const hash = bcrypt.hashSync('admin123', 10);
      await db.query(
        `INSERT INTO users (company_id,username,password_hash,full_name,role) VALUES ($1,$2,$3,$4,$5)`,
        [demoCompanyId, 'admin', hash, 'Administrator', 'admin']
      );
      console.log('✓ Default user: admin / admin123 (company: demo)');
    }
  }

  // ── Default settings for demo company ────────────────────────────────────
  const { rows: cs } = await db.query(
    'SELECT id FROM company_settings WHERE company_id=$1', [demoCompanyId]
  );
  if (cs.length === 0) {
    await db.query(
      `INSERT INTO company_settings (company_id, settings) VALUES ($1,$2)`,
      [demoCompanyId, JSON.stringify(DEFAULT_SETTINGS)]
    );
  }

  // ── Seed containers for demo company (only if none exist) ─────────────────
  const { rows: contRows } = await db.query(
    'SELECT COUNT(*) AS c FROM containers WHERE company_id=$1', [demoCompanyId]
  );
  if (parseInt(contRows[0].c) === 0) {
    const seed = [
      ['C-001','20ft','Back Row',null,'2026-02-28',null,'Mark Reid',true,true,'','','','','',true,false,87,'Paid',''],
      ['C-002','20ft','Back Row',null,'2026-03-21',null,'Jason Drake',true,true,'','','','','',true,false,87,'Paid',''],
      ['C-003','20ft','Back Row',null,'2026-03-06','2026-05-04','',true,true,'','','','','',true,false,220,'Overdue',''],
      ['C-004','20ft','Back Row',null,'2026-03-30',null,'Laszlo Kondas',true,true,'','','','','',true,false,0,'Pending','Had to manually give him access on the lock for 24/7'],
      ['C-005','20ft','Back Row',null,'2026-04-06',null,'Justin Dodsworth',true,true,'','','','','',true,false,85,'Paid',''],
      ['C-006','20ft','Back Row',null,'2026-05-16',null,'Paul Shelton',true,true,'','','','','',true,true,135,'Pending',''],
      ['C-007','20ft','Back Row',null,'2026-04-18',null,'Wayne Heath',true,true,'','','','','',true,true,0,'Paid',''],
      ['C-008','20ft','Back Row',null,'2026-06-06',null,'Richard Fofie',true,true,'','','','','',false,false,220,'Pending',''],
      ['C-009','20ft','Back Row',null,'2026-06-05','2026-05-05','Margaret Swanwick',false,false,'','','','','',false,true,150,'Pending',''],
      ['C-010','20ft','Back Row',null,'2026-03-12','2026-05-11','Graham Pretty',true,true,'','','','','',true,true,0,'Paid',''],
      ['C-011','20ft','Back Row',null,'2026-05-20',null,'Matt Statham',false,false,'','','','','',false,true,135,'',''],
      ['C-012','20ft','Back Row',null,'2026-04-18',null,'Uzma Hanif',true,true,'','','','','',true,false,0,'',''],
      ['C-013','20ft','Back Row',null,null,null,'',true,false,'','','','','',false,false,0,'Pending',''],
      ['C-014','20ft','Back Row',null,'2026-05-11',null,'Paul Ewing',true,true,'','','','','',true,false,0,'Paid',''],
      ['C-015','20ft','Back Row',null,'2026-05-16',null,'Paul Shelton',true,true,'','','','','',true,true,135,'Pending',''],
      ['C-016','8ft','Front Row',null,'2026-03-28',null,'Katie Denton',true,true,'','','','','',true,false,0,'Paid',''],
      ['C-017','20ft','Back Row',null,'2026-06-02',null,'Ian Torbet',true,true,'','','','','',true,false,0,'Paid',''],
      ['C-018','20ft','Back Row',null,'2026-06-04',null,'Gyula Zsiga',true,true,'','','','','',true,false,0,'Paid',''],
      ['C-019','20ft','Back Row',null,null,null,'Peter Sanderson',false,false,'','','','','',false,false,0,'Pending',''],
      ['C-020','20ft','Back Row',null,null,null,'',true,true,'','','','','',true,false,0,'Paid',''],
      ['C-021','20ft','Back Row',null,null,null,'',true,true,'','','','','',true,false,0,'Paid',''],
      ['C-022','20ft','Back Row',null,null,null,'',true,true,'','','','','',true,false,0,'Paid',''],
      ['C-023','20ft','Back Row',null,null,null,'',true,true,'','','','','',true,false,0,'Paid',''],
      ['C-024','8ft','Back Row',null,null,null,'',true,true,'','','','','',true,false,0,'Paid',''],
    ];
    for (const row of seed) {
      await db.query(
        `INSERT INTO containers
          (company_id,container_number,container_size,location,order_date,start_date,end_date,
           customer_name,joining_email_sent,id_check,phone,email,address1,address2,
           postcode,contract_signed,insurance,monthly_rate,payment_status,notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
        [demoCompanyId, ...row]
      );
    }
    console.log(`✓ Seeded ${seed.length} containers for demo company`);
  }

  console.log('✓ Database ready (multi-tenant)');
}

// ── Default settings (used when no company settings exist yet) ────────────────
const DEFAULT_SETTINGS = {
  container_sizes:   ['8ft','20ft','30ft','45ft','','',''],
  locations:         ['Back Row','Topper Back','Front Row','Topper Front','','',''],
  rental_types:      ['Monthly','Weekly','Fixed-term','Annual','Recurring','',''],
  payment_statuses:  ['Paid','Overdue','Pending','Direct Debit','Credit Note','',''],
  lead_sources:      ['Social Media','Google','Passing By','Referral','Phone Enquiry','Website',''],
  prospect_statuses: ['New','Contacted','Interested','Converted','Not Interested',''],
};

// ── Helpers ───────────────────────────────────────────────────────────────────
function deriveStatus(start_date, end_date) {
  if (!start_date) return 'Vacant';
  const today = new Date(); today.setHours(0,0,0,0);
  const start = new Date(start_date);
  if (start > today) return 'Reserved';
  if (!end_date || new Date(end_date) >= today) return 'Occupied';
  return 'Vacant';
}

function enrichContainer(c) {
  const today = new Date(); today.setHours(0,0,0,0);
  c.monthly_rate       = parseFloat(c.monthly_rate) || 0;
  c.joining_email_sent = !!c.joining_email_sent;
  c.id_check           = !!c.id_check;
  c.contract_signed    = !!c.contract_signed;
  c.insurance          = !!c.insurance;
  c.status = deriveStatus(c.start_date, c.end_date);
  c.days_occupied = c.start_date
    ? Math.floor(((c.end_date ? new Date(c.end_date) : today) - new Date(c.start_date)) / 86400000) : null;
  c.days_until_expiry = (c.status === 'Occupied' && c.end_date)
    ? Math.floor((new Date(c.end_date) - today) / 86400000) : null;
  return c;
}

function orNull(v) { return (v === '' || v === undefined || v === null) ? null : v; }

// ── Auth middleware ────────────────────────────────────────────────────────────
// Decodes JWT and attaches req.user = { id, company_id, username, role }
function authRequired(req, res, next) {
  const h = req.headers.authorization;
  if (!h || !h.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorised' });
  try { req.user = jwt.verify(h.slice(7), JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Invalid or expired token' }); }
}

function adminOnly(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  next();
}

// ── Effective rate helper ─────────────────────────────────────────────────────
function effectiveRateForDate(c, refDate) {
  const d = refDate || new Date(); d.setHours(0,0,0,0);
  if (c.intro_rate && c.intro_months && c.start_date) {
    const monthsIn = (d.getFullYear() - new Date(c.start_date).getFullYear()) * 12
      + (d.getMonth() - new Date(c.start_date).getMonth());
    if (monthsIn < parseInt(c.intro_months)) return parseFloat(c.intro_rate) || 0;
  }
  return parseFloat(c.monthly_rate) || 0;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// PUBLIC ROUTES (no auth required)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// ── Company signup ────────────────────────────────────────────────────────────
app.post('/api/signup', async (req, res) => {
  try {
    const { company_name, username, password, full_name } = req.body || {};
    if (!company_name || !username || !password)
      return res.status(400).json({ error: 'Company name, username and password are required' });
    if (password.length < 8)
      return res.status(400).json({ error: 'Password must be at least 8 characters' });

    // Generate a URL-safe slug from company name
    const slug = company_name.toLowerCase()
      .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
      .substring(0, 40) + '-' + Date.now().toString(36);

    // Create company
    const { rows: coRows } = await db.query(
      `INSERT INTO companies (name, slug, plan) VALUES ($1,$2,'trial') RETURNING *`,
      [company_name.trim(), slug]
    );
    const company = coRows[0];

    // Create admin user
    const hash = bcrypt.hashSync(password, 10);
    const { rows: uRows } = await db.query(
      `INSERT INTO users (company_id,username,password_hash,full_name,role)
       VALUES ($1,$2,$3,$4,'admin') RETURNING id,username,full_name,role`,
      [company.id, username.trim().toLowerCase(), hash, full_name || username]
    );
    const user = uRows[0];

    // Create default settings
    await db.query(
      `INSERT INTO company_settings (company_id,settings) VALUES ($1,$2)`,
      [company.id, JSON.stringify(DEFAULT_SETTINGS)]
    );

    // Issue JWT
    const token = jwt.sign(
      { id: user.id, company_id: company.id, username: user.username, role: user.role },
      JWT_SECRET, { expiresIn: '8h' }
    );

    res.status(201).json({
      token,
      user: { id: user.id, username: user.username, full_name: user.full_name, role: user.role },
      company: { id: company.id, name: company.name, slug: company.slug, plan: company.plan,
                 trial_ends_at: company.trial_ends_at }
    });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'That username or company name is already taken' });
    res.status(500).json({ error: e.message });
  }
});

// ── Login ─────────────────────────────────────────────────────────────────────
app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password)
      return res.status(400).json({ error: 'Username and password required' });

    // Look up user — join company so we can return plan status
    const { rows } = await db.query(
      `SELECT u.*, c.name AS company_name, c.slug, c.plan, c.trial_ends_at, c.id AS cid
       FROM users u JOIN companies c ON c.id=u.company_id
       WHERE u.username=$1`,
      [username.trim().toLowerCase()]
    );
    const user = rows[0];
    if (!user || !bcrypt.compareSync(password, user.password_hash))
      return res.status(401).json({ error: 'Invalid credentials' });

    if (user.plan === 'suspended')
      return res.status(403).json({ error: 'Your account has been suspended. Please contact support.' });

    const token = jwt.sign(
      { id: user.id, company_id: user.cid, username: user.username, role: user.role },
      JWT_SECRET, { expiresIn: '8h' }
    );
    res.json({
      token,
      user: { id: user.id, username: user.username, full_name: user.full_name, role: user.role },
      company: { id: user.cid, name: user.company_name, slug: user.slug,
                 plan: user.plan, trial_ends_at: user.trial_ends_at }
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Stripe webhook (must be before json middleware for raw body) ───────────────
app.post('/api/stripe/webhook',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    if (!stripe) return res.status(400).json({ error: 'Stripe not configured' });
    const sig = req.headers['stripe-signature'];
    let event;
    try {
      event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
    } catch (e) {
      return res.status(400).json({ error: 'Webhook signature invalid' });
    }
    try {
      const sub = event.data.object;
      if (event.type === 'customer.subscription.created' || event.type === 'customer.subscription.updated') {
        const plan = sub.status === 'active' || sub.status === 'trialing' ? 'active' : 'suspended';
        await db.query(
          `UPDATE companies SET plan=$1, stripe_sub_id=$2 WHERE stripe_customer_id=$3`,
          [plan, sub.id, sub.customer]
        );
      }
      if (event.type === 'customer.subscription.deleted') {
        await db.query(
          `UPDATE companies SET plan='suspended' WHERE stripe_customer_id=$1`,
          [sub.customer]
        );
      }
      res.json({ received: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  }
);

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// AUTHENTICATED ROUTES  — all scoped to req.user.company_id
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

app.get('/api/auth/me', authRequired, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT u.id,u.username,u.full_name,u.role,
              c.id AS company_id,c.name AS company_name,c.plan,c.trial_ends_at
       FROM users u JOIN companies c ON c.id=u.company_id
       WHERE u.id=$1 AND u.company_id=$2`,
      [req.user.id, req.user.company_id]
    );
    rows[0] ? res.json(rows[0]) : res.status(404).json({ error: 'Not found' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/auth/change-password', authRequired, async (req, res) => {
  try {
    const { current_password, new_password } = req.body || {};
    if (!current_password || !new_password)
      return res.status(400).json({ error: 'Both passwords required' });
    if (new_password.length < 6)
      return res.status(400).json({ error: 'New password must be at least 6 characters' });
    const { rows } = await db.query(
      'SELECT * FROM users WHERE id=$1 AND company_id=$2',
      [req.user.id, req.user.company_id]
    );
    if (!bcrypt.compareSync(current_password, rows[0].password_hash))
      return res.status(401).json({ error: 'Current password incorrect' });
    await db.query('UPDATE users SET password_hash=$1 WHERE id=$2',
      [bcrypt.hashSync(new_password, 10), req.user.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Stripe: create checkout session ──────────────────────────────────────────
app.post('/api/billing/checkout', authRequired, adminOnly, async (req, res) => {
  if (!stripe || !STRIPE_PRICE_ID)
    return res.status(400).json({ error: 'Billing not configured on this server' });
  try {
    const { rows } = await db.query('SELECT * FROM companies WHERE id=$1', [req.user.company_id]);
    const company = rows[0];
    let customerId = company.stripe_customer_id;
    if (!customerId) {
      const customer = await stripe.customers.create({
        name: company.name,
        metadata: { company_id: String(company.id), slug: company.slug }
      });
      customerId = customer.id;
      await db.query('UPDATE companies SET stripe_customer_id=$1 WHERE id=$2',
        [customerId, company.id]);
    }
    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      mode: 'subscription',
      line_items: [{ price: STRIPE_PRICE_ID, quantity: 1 }],
      success_url: APP_URL + '/?billing=success',
      cancel_url:  APP_URL + '/?billing=cancelled',
    });
    res.json({ url: session.url });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Stripe: billing portal (manage/cancel subscription) ──────────────────────
app.post('/api/billing/portal', authRequired, adminOnly, async (req, res) => {
  if (!stripe) return res.status(400).json({ error: 'Billing not configured' });
  try {
    const { rows } = await db.query('SELECT stripe_customer_id FROM companies WHERE id=$1', [req.user.company_id]);
    if (!rows[0]?.stripe_customer_id)
      return res.status(400).json({ error: 'No billing account found' });
    const session = await stripe.billingPortal.sessions.create({
      customer: rows[0].stripe_customer_id,
      return_url: APP_URL + '/',
    });
    res.json({ url: session.url });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Company settings (dropdown options, stored in DB) ─────────────────────────
app.get('/api/settings', authRequired, async (req, res) => {
  try {
    const { rows } = await db.query(
      'SELECT settings FROM company_settings WHERE company_id=$1', [req.user.company_id]
    );
    res.json(rows[0]?.settings || DEFAULT_SETTINGS);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/settings', authRequired, adminOnly, async (req, res) => {
  try {
    await db.query(
      `INSERT INTO company_settings (company_id,settings) VALUES ($1,$2)
       ON CONFLICT (company_id) DO UPDATE SET settings=$2, updated_at=NOW()`,
      [req.user.company_id, JSON.stringify(req.body)]
    );
    res.json(req.body);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Users (within the same company) ──────────────────────────────────────────
app.get('/api/users', authRequired, adminOnly, async (req, res) => {
  try {
    const { rows } = await db.query(
      'SELECT id,username,full_name,role,created_at FROM users WHERE company_id=$1 ORDER BY id',
      [req.user.company_id]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/users', authRequired, adminOnly, async (req, res) => {
  try {
    const { username, password, full_name, role } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
    const { rows } = await db.query(
      `INSERT INTO users (company_id,username,password_hash,full_name,role)
       VALUES ($1,$2,$3,$4,$5) RETURNING id,username,full_name,role,created_at`,
      [req.user.company_id, username.trim().toLowerCase(),
       bcrypt.hashSync(password,10), full_name||'', role||'user']
    );
    res.status(201).json(rows[0]);
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Username already exists' });
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/users/:id', authRequired, adminOnly, async (req, res) => {
  if (parseInt(req.params.id) === req.user.id)
    return res.status(400).json({ error: 'Cannot delete your own account' });
  try {
    await db.query('DELETE FROM users WHERE id=$1 AND company_id=$2',
      [req.params.id, req.user.company_id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Dashboard ─────────────────────────────────────────────────────────────────
app.get('/api/dashboard', authRequired, async (req, res) => {
  try {
    const cid = req.user.company_id;
    const { rows } = await db.query(
      'SELECT * FROM containers WHERE company_id=$1 ORDER BY container_number', [cid]
    );
    const all = rows.map(enrichContainer);
    const occupied = all.filter(c => c.status === 'Occupied');
    const reserved = all.filter(c => c.status === 'Reserved');
    const expiring30 = occupied
      .filter(c => c.days_until_expiry !== null && c.days_until_expiry <= 30 && c.days_until_expiry >= 0)
      .sort((a,b) => a.days_until_expiry - b.days_until_expiry);
    const today = new Date(); today.setHours(0,0,0,0);
    res.json({
      total:            all.length,
      occupied:         occupied.length,
      reserved:         reserved.length,
      vacant:           all.filter(c => c.status === 'Vacant').length,
      occupancy_rate:   all.length ? occupied.length / all.length : 0,
      expiring_soon:    expiring30.length,
      overdue_payments: all.filter(c => c.payment_status === 'Overdue').length,
      monthly_revenue:  occupied.reduce((s,c) => s + effectiveRateForDate(c, today), 0),
      expiring_containers: expiring30
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Dashboard charts ──────────────────────────────────────────────────────────
app.get('/api/dashboard/revenue-trend', authRequired, async (req, res) => {
  try {
    const cid = req.user.company_id;
    const months = parseInt(req.query.months) || 12;
    const result = [];
    for (let i = months - 1; i >= 0; i--) {
      const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - i);
      const y = d.getFullYear(), m = d.getMonth() + 1;
      const label = d.toLocaleString('en-GB', { month: 'short', year: '2-digit' });
      const first = `${y}-${String(m).padStart(2,'0')}-01`;
      const last  = new Date(y, m, 0).toISOString().split('T')[0];
      const { rows: r } = await db.query(
        `SELECT COALESCE(SUM(monthly_rate),0) AS revenue FROM containers
         WHERE company_id=$1 AND start_date<=$2 AND (end_date IS NULL OR end_date>=$3) AND start_date IS NOT NULL`,
        [cid, last, first]);
      const { rows: h } = await db.query(
        `SELECT COALESCE(SUM(monthly_rate),0) AS revenue FROM rental_history
         WHERE company_id=$1 AND start_date<=$2 AND (end_date IS NULL OR end_date>=$3) AND start_date IS NOT NULL`,
        [cid, last, first]);
      result.push({ label, year: y, month: m, revenue: parseFloat(r[0].revenue) + parseFloat(h[0].revenue) });
    }
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/dashboard/occupancy-trend', authRequired, async (req, res) => {
  try {
    const cid = req.user.company_id;
    const months = parseInt(req.query.months) || 12;
    const result = [];
    for (let i = months - 1; i >= 0; i--) {
      const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - i);
      const y = d.getFullYear(), m = d.getMonth() + 1;
      const label = d.toLocaleString('en-GB', { month: 'short', year: '2-digit' });
      const first = `${y}-${String(m).padStart(2,'0')}-01`;
      const last  = new Date(y, m, 0).toISOString().split('T')[0];
      const { rows: c } = await db.query(
        `SELECT COUNT(*) AS n FROM containers
         WHERE company_id=$1 AND start_date<=$2 AND (end_date IS NULL OR end_date>=$3) AND start_date IS NOT NULL`,
        [cid, last, first]);
      const { rows: h } = await db.query(
        `SELECT COUNT(*) AS n FROM rental_history
         WHERE company_id=$1 AND start_date<=$2 AND (end_date IS NULL OR end_date>=$3) AND start_date IS NOT NULL`,
        [cid, last, first]);
      result.push({ label, year: y, month: m, occupied: parseInt(c[0].n) + parseInt(h[0].n) });
    }
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Containers ────────────────────────────────────────────────────────────────
app.get('/api/containers', authRequired, async (req, res) => {
  try {
    const cid = req.user.company_id;
    const { search, status, payment_status, location } = req.query;
    let sql = 'SELECT * FROM containers WHERE company_id=$1';
    const params = [cid];
    if (search) {
      params.push(`%${search}%`);
      sql += ` AND (container_number ILIKE $${params.length} OR customer_name ILIKE $${params.length} OR notes ILIKE $${params.length} OR email ILIKE $${params.length})`;
    }
    if (payment_status) { params.push(payment_status); sql += ` AND payment_status=$${params.length}`; }
    if (location)       { params.push(location);        sql += ` AND location=$${params.length}`; }
    sql += ' ORDER BY container_number';
    const { rows } = await db.query(sql, params);
    let result = rows.map(enrichContainer);
    if (status) result = result.filter(c => c.status === status);
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/containers/:id', authRequired, async (req, res) => {
  try {
    const { rows } = await db.query(
      'SELECT * FROM containers WHERE id=$1 AND company_id=$2',
      [req.params.id, req.user.company_id]
    );
    rows[0] ? res.json(enrichContainer(rows[0])) : res.status(404).json({ error: 'Not found' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/containers', authRequired, async (req, res) => {
  try {
    const d = req.body; const cid = req.user.company_id;
    if (!d.container_number) return res.status(400).json({ error: 'Container number required' });
    const { rows } = await db.query(
      `INSERT INTO containers
        (company_id,container_number,container_size,location,order_date,start_date,end_date,
         customer_name,joining_email_sent,id_check,phone,email,address1,address2,
         postcode,contract_signed,insurance,monthly_rate,intro_rate,intro_months,payment_status,notes,converted_from_prospect_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)
       RETURNING *`,
      [cid, d.container_number, d.container_size||'20ft', d.location||'Back Row',
       orNull(d.order_date), orNull(d.start_date), orNull(d.end_date),
       d.customer_name||'', !!d.joining_email_sent, !!d.id_check,
       d.phone||'', d.email||'', d.address1||'', d.address2||'', d.postcode||'',
       !!d.contract_signed, !!d.insurance, parseFloat(d.monthly_rate)||0,
       orNull(d.intro_rate) ? parseFloat(d.intro_rate) : null,
       orNull(d.intro_months) ? parseInt(d.intro_months) : null,
       d.payment_status||'Pending', d.notes||'',
       d.converted_from_prospect_id ? parseInt(d.converted_from_prospect_id) : null]
    );
    // If converted from a prospect, mark that prospect as Converted
    if (d.converted_from_prospect_id) {
      await db.query(
        `UPDATE prospects SET status='Converted' WHERE id=$1 AND company_id=$2`,
        [d.converted_from_prospect_id, cid]
      );
    }
    res.status(201).json(enrichContainer(rows[0]));
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Container number already exists' });
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/containers/:id', authRequired, async (req, res) => {
  try {
    const d = req.body; const cid = req.user.company_id;
    const { rows } = await db.query(
      `UPDATE containers SET
        container_number=$1,container_size=$2,location=$3,order_date=$4,start_date=$5,
        end_date=$6,customer_name=$7,joining_email_sent=$8,id_check=$9,phone=$10,
        email=$11,address1=$12,address2=$13,postcode=$14,contract_signed=$15,
        insurance=$16,monthly_rate=$17,intro_rate=$18,intro_months=$19,
        payment_status=$20,notes=$21,
        converted_from_prospect_id=COALESCE($24,converted_from_prospect_id),
        updated_at=NOW()
       WHERE id=$22 AND company_id=$23 RETURNING *`,
      [d.container_number, d.container_size, d.location,
       orNull(d.order_date), orNull(d.start_date), orNull(d.end_date),
       d.customer_name||'', !!d.joining_email_sent, !!d.id_check,
       d.phone||'', d.email||'', d.address1||'', d.address2||'', d.postcode||'',
       !!d.contract_signed, !!d.insurance, parseFloat(d.monthly_rate)||0,
       orNull(d.intro_rate) ? parseFloat(d.intro_rate) : null,
       orNull(d.intro_months) ? parseInt(d.intro_months) : null,
       d.payment_status||'Pending', d.notes||'', req.params.id, cid,
       d.converted_from_prospect_id ? parseInt(d.converted_from_prospect_id) : null]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Not found' });
    res.json(enrichContainer(rows[0]));
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Container number already exists' });
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/containers/:id', authRequired, async (req, res) => {
  try {
    const { rows } = await db.query(
      'DELETE FROM containers WHERE id=$1 AND company_id=$2 RETURNING id',
      [req.params.id, req.user.company_id]
    );
    rows[0] ? res.json({ success: true }) : res.status(404).json({ error: 'Not found' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/containers/:id/confirm-movein', authRequired, async (req, res) => {
  try {
    const { rows } = await db.query(
      'SELECT * FROM containers WHERE id=$1 AND company_id=$2',
      [req.params.id, req.user.company_id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Not found' });
    const c = enrichContainer(rows[0]);
    if (c.status !== 'Reserved') return res.status(400).json({ error: 'Container is not Reserved' });
    const today = new Date().toISOString().split('T')[0];
    const { rows: updated } = await db.query(
      `UPDATE containers SET start_date=$1,updated_at=NOW() WHERE id=$2 AND company_id=$3 RETURNING *`,
      [today, req.params.id, req.user.company_id]
    );
    res.json(enrichContainer(updated[0]));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/containers/:id/archive', authRequired, async (req, res) => {
  try {
    const cid = req.user.company_id;
    const { rows } = await db.query(
      'SELECT * FROM containers WHERE id=$1 AND company_id=$2', [req.params.id, cid]
    );
    const c = rows[0];
    if (!c) return res.status(404).json({ error: 'Not found' });
    if (!c.customer_name && !c.start_date)
      return res.status(400).json({ error: 'Container is already empty' });
    await db.query(
      `INSERT INTO rental_history
        (company_id,container_number,container_size,location,order_date,start_date,end_date,
         customer_name,joining_email_sent,id_check,phone,email,address1,address2,
         postcode,contract_signed,insurance,monthly_rate,payment_status,notes,archived_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)`,
      [cid, c.container_number, c.container_size, c.location,
       c.order_date, c.start_date, c.end_date, c.customer_name,
       c.joining_email_sent, c.id_check, c.phone, c.email,
       c.address1, c.address2, c.postcode, c.contract_signed, c.insurance,
       c.monthly_rate, c.payment_status, c.notes, req.user.username]
    );
    const { rows: updated } = await db.query(
      `UPDATE containers SET
        order_date=NULL,start_date=NULL,end_date=NULL,customer_name='',
        joining_email_sent=FALSE,id_check=FALSE,phone='',email='',
        address1='',address2='',postcode='',contract_signed=FALSE,
        insurance=FALSE,monthly_rate=0,intro_rate=NULL,intro_months=NULL,
        payment_status='Pending',notes='',updated_at=NOW()
       WHERE id=$1 AND company_id=$2 RETURNING *`,
      [req.params.id, cid]
    );
    res.json({ container: enrichContainer(updated[0]), message: 'Tenant archived' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Rental History ─────────────────────────────────────────────────────────────
app.get('/api/history', authRequired, async (req, res) => {
  try {
    const cid = req.user.company_id;
    const { search, container_number } = req.query;
    let sql = 'SELECT * FROM rental_history WHERE company_id=$1';
    const params = [cid];
    if (search) {
      params.push(`%${search}%`);
      sql += ` AND (customer_name ILIKE $${params.length} OR container_number ILIKE $${params.length} OR email ILIKE $${params.length} OR notes ILIKE $${params.length})`;
    }
    if (container_number) { params.push(container_number); sql += ` AND container_number=$${params.length}`; }
    sql += ' ORDER BY archived_at DESC';
    const { rows } = await db.query(sql, params);
    res.json(rows.map(r => ({
      ...r,
      monthly_rate: parseFloat(r.monthly_rate) || 0,
      joining_email_sent: !!r.joining_email_sent,
      id_check: !!r.id_check,
      contract_signed: !!r.contract_signed,
      insurance: !!r.insurance,
    })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/history/:id', authRequired, adminOnly, async (req, res) => {
  try {
    await db.query('DELETE FROM rental_history WHERE id=$1 AND company_id=$2',
      [req.params.id, req.user.company_id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Prospects ──────────────────────────────────────────────────────────────────
app.get('/api/prospects', authRequired, async (req, res) => {
  try {
    const cid = req.user.company_id;
    const { search, status } = req.query;
    const params = [cid];
    const conds = ['company_id=$1'];
    if (search) { params.push(`%${search}%`); conds.push(`(name ILIKE $${params.length} OR email ILIKE $${params.length} OR phone ILIKE $${params.length})`); }
    if (status && status !== 'all') { params.push(status); conds.push(`status=$${params.length}`); }
    const { rows } = await db.query(
      `SELECT * FROM prospects WHERE ${conds.join(' AND ')} ORDER BY created_at DESC`, params
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/prospects', authRequired, async (req, res) => {
  try {
    const { name, email, phone, address1, address2, postcode, source, status, notes } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: 'Name is required' });
    const { rows } = await db.query(
      `INSERT INTO prospects (company_id,name,email,phone,address1,address2,postcode,source,status,notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [req.user.company_id, name.trim(), email||'', phone||'', address1||'',
       address2||'', postcode||'', source||'', status||'New', notes||'']
    );
    res.status(201).json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/prospects/:id', authRequired, async (req, res) => {
  try {
    const { name, email, phone, address1, address2, postcode, source, status, notes } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: 'Name is required' });
    const { rows } = await db.query(
      `UPDATE prospects SET name=$1,email=$2,phone=$3,address1=$4,address2=$5,
       postcode=$6,source=$7,status=$8,notes=$9,updated_at=NOW()
       WHERE id=$10 AND company_id=$11 RETURNING *`,
      [name.trim(), email||'', phone||'', address1||'', address2||'',
       postcode||'', source||'', status||'New', notes||'',
       req.params.id, req.user.company_id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/prospects/:id', authRequired, async (req, res) => {
  try {
    await db.query('DELETE FROM prospects WHERE id=$1 AND company_id=$2',
      [req.params.id, req.user.company_id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Customers (aggregated view) ───────────────────────────────────────────────
app.get('/api/customers', authRequired, async (req, res) => {
  try {
    const cid = req.user.company_id;
    const { search, active_only } = req.query;
    const params = [cid];
    const searchCond = search ? (params.push(`%${search}%`), `AND (customer_name ILIKE $${params.length} OR email ILIKE $${params.length} OR phone ILIKE $${params.length})`) : '';
    const having = active_only === 'true'
      ? `HAVING SUM(CASE WHEN src='active' AND start_date IS NOT NULL AND (end_date IS NULL OR end_date>=CURRENT_DATE) THEN 1 ELSE 0 END) > 0`
      : '';
    const { rows } = await db.query(`
      WITH all_tenants AS (
        SELECT customer_name,email,phone,address1,address2,postcode,start_date,end_date,'active' AS src
        FROM containers WHERE company_id=$1 AND customer_name IS NOT NULL AND customer_name<>'' ${searchCond}
        UNION ALL
        SELECT customer_name,email,phone,address1,address2,postcode,start_date,end_date,'history' AS src
        FROM rental_history WHERE company_id=$1 AND customer_name IS NOT NULL AND customer_name<>'' ${searchCond}
      )
      SELECT customer_name, MAX(email) AS email, MAX(phone) AS phone,
             MAX(address1) AS address1, MAX(address2) AS address2, MAX(postcode) AS postcode,
             COUNT(*) AS total_rentals,
             SUM(CASE WHEN src='active' AND start_date IS NOT NULL AND (end_date IS NULL OR end_date>=CURRENT_DATE) THEN 1 ELSE 0 END) AS active_rentals,
             MIN(start_date) AS first_rental
      FROM all_tenants
      GROUP BY customer_name ${having}
      ORDER BY MIN(start_date) ASC NULLS LAST
    `, params);
    res.json(rows.map(r => ({ ...r, total_rentals: parseInt(r.total_rentals), active_rentals: parseInt(r.active_rentals) })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/customers/detail', authRequired, async (req, res) => {
  try {
    const cid = req.user.company_id;
    const name = req.query.name;
    if (!name) return res.status(400).json({ error: 'Name required' });
    const { rows: active } = await db.query(
      `SELECT *,'active' AS src FROM containers WHERE company_id=$1 AND customer_name=$2 ORDER BY start_date DESC NULLS LAST`,
      [cid, name]);
    const { rows: hist } = await db.query(
      `SELECT *,'history' AS src FROM rental_history WHERE company_id=$1 AND customer_name=$2 ORDER BY start_date DESC NULLS LAST`,
      [cid, name]);
    if (!active.length && !hist.length) return res.status(404).json({ error: 'Customer not found' });
    const all = [...active, ...hist];
    const recent = all.find(r => r.email || r.phone) || all[0];
    const customer = {
      name, email: recent.email||'', phone: recent.phone||'',
      address1: recent.address1||'', address2: recent.address2||'', postcode: recent.postcode||'',
      first_rental: all.reduce((m,r) => r.start_date&&(!m||r.start_date<m)?r.start_date:m, null),
    };
    const today = new Date(); today.setHours(0,0,0,0);
    const rentals = all.map(r => {
      let status;
      if (r.src==='history') status='Ended';
      else if (!r.start_date) status='Pending';
      else if (!r.end_date||new Date(r.end_date)>=today) status='Active';
      else status='Ended';
      return { id:r.id, src:r.src, container_number:r.container_number,
               container_size:r.container_size, location:r.location,
               start_date:r.start_date, end_date:r.end_date,
               monthly_rate:parseFloat(r.monthly_rate)||0,
               payment_status:r.payment_status||'', contract_signed:!!r.contract_signed,
               insurance:!!r.insurance, status };
    });
    const totalMonthly = active
      .filter(r => r.start_date && (!r.end_date||new Date(r.end_date)>=today))
      .reduce((s,r) => s+(parseFloat(r.monthly_rate)||0), 0);
    res.json({ customer, rentals, totalMonthly });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Income ─────────────────────────────────────────────────────────────────────
app.get('/api/income', authRequired, async (req, res) => {
  try {
    const cid = req.user.company_id;
    const y = parseInt(req.query.year)  || new Date().getFullYear();
    const m = parseInt(req.query.month) || new Date().getMonth() + 1;
    const ps = `${y}-${String(m).padStart(2,'0')}-01`;
    const pe = new Date(y, m, 0).toISOString().split('T')[0];

    const { rows: active } = await db.query(
      `SELECT id,container_number,container_size,location,customer_name,email,phone,
              monthly_rate,intro_rate,intro_months,payment_status,start_date,end_date,'active' AS src
       FROM containers WHERE company_id=$1 AND customer_name IS NOT NULL AND customer_name<>''
         AND start_date IS NOT NULL AND start_date<=$2 AND (end_date IS NULL OR end_date>=$3)`,
      [cid, pe, ps]);
    const { rows: hist } = await db.query(
      `SELECT id,container_number,container_size,location,customer_name,email,phone,
              monthly_rate,intro_rate,intro_months,payment_status,start_date,end_date,'history' AS src
       FROM rental_history WHERE company_id=$1 AND customer_name IS NOT NULL AND customer_name<>''
         AND start_date IS NOT NULL AND start_date<=$2 AND (end_date IS NULL OR end_date>=$3)`,
      [cid, pe, ps]);

    const effRate = (c) => {
      if (c.intro_rate && c.intro_months && c.start_date) {
        const mIn = (y - new Date(c.start_date).getFullYear()) * 12 + (m - 1 - new Date(c.start_date).getMonth());
        if (mIn < parseInt(c.intro_months)) return parseFloat(c.intro_rate) || 0;
      }
      return parseFloat(c.monthly_rate) || 0;
    };
    const nextBilling = (c) => {
      if (!c.start_date) return null;
      const day = Math.min(new Date(c.start_date).getDate(), new Date(y, m, 0).getDate());
      return new Date(y, m - 1, day).toISOString().split('T')[0];
    };

    const rows = [...active, ...hist].map(c => ({
      id: c.id, src: c.src, container_number: c.container_number,
      container_size: c.container_size, location: c.location,
      customer_name: c.customer_name, email: c.email, phone: c.phone,
      payment_status: c.payment_status, start_date: c.start_date, end_date: c.end_date,
      monthly_rate: parseFloat(c.monthly_rate)||0,
      intro_rate: c.intro_rate ? parseFloat(c.intro_rate) : null,
      intro_months: c.intro_months ? parseInt(c.intro_months) : null,
      effective_rate: effRate(c),
      next_billing_date: nextBilling(c),
      billing_day: c.start_date ? new Date(c.start_date).getDate() : null,
    }));
    rows.sort((a,b) => a.customer_name.localeCompare(b.customer_name) || a.container_number.localeCompare(b.container_number));

    const daysInMonth = new Date(y, m, 0).getDate();
    const daily = {};
    for (let d = 1; d <= daysInMonth; d++) daily[d] = { expected: 0, count: 0, tenants: [] };
    rows.forEach(r => {
      if (r.billing_day) {
        const d = Math.min(r.billing_day, daysInMonth);
        daily[d].expected += r.effective_rate;
        daily[d].count++;
        daily[d].tenants.push({ name: r.customer_name, container: r.container_number, rate: r.effective_rate });
      }
    });

    res.json({
      rows, year: y, month: m,
      summary: {
        total_expected: rows.reduce((s,r) => s+r.effective_rate, 0),
        total_paid:     rows.filter(r => r.payment_status==='Paid'||r.payment_status==='Direct Debit').reduce((s,r) => s+r.effective_rate, 0),
        total_overdue:  rows.filter(r => r.payment_status==='Overdue').reduce((s,r) => s+r.effective_rate, 0),
        total_pending:  rows.filter(r => r.payment_status==='Pending').reduce((s,r) => s+r.effective_rate, 0),
        count: rows.length, daily,
      }
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Prospect Emails ───────────────────────────────────────────────────────────

// GET  /api/prospects/:id/emails  — list all emails sent to this prospect
app.get('/api/prospects/:id/emails', authRequired, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT * FROM prospect_emails WHERE prospect_id=$1 AND company_id=$2 ORDER BY sent_at DESC`,
      [req.params.id, req.user.company_id]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/prospects/:id/email   — send an email and log it
app.post('/api/prospects/:id/email', authRequired, async (req, res) => {
  try {
    const cid = req.user.company_id;
    const { subject, body } = req.body || {};
    if (!subject?.trim() || !body?.trim())
      return res.status(400).json({ error: 'Subject and body are required' });

    // Fetch the prospect (must belong to this company)
    const { rows: pRows } = await db.query(
      'SELECT * FROM prospects WHERE id=$1 AND company_id=$2',
      [req.params.id, cid]
    );
    if (!pRows[0]) return res.status(404).json({ error: 'Prospect not found' });
    const prospect = pRows[0];
    if (!prospect.email?.trim())
      return res.status(400).json({ error: 'This prospect has no email address' });

    // Fetch the company's reply-to email from settings
    const { rows: sRows } = await db.query(
      'SELECT settings FROM company_settings WHERE company_id=$1', [cid]
    );
    const settings = sRows[0]?.settings || {};
    const replyTo = settings.reply_to_email || '';

    // Fetch company name for the From display name
    const { rows: coRows } = await db.query(
      'SELECT name FROM companies WHERE id=$1', [cid]
    );
    const companyName = coRows[0]?.name || 'Storage CRM';

    // Send via Resend (if configured)
    let emailSent = false;
    let sendError = null;
    if (resendClient) {
      try {
        const emailPayload = {
          from: `${companyName} <${FROM_EMAIL}>`,
          to: [prospect.email.trim()],
          subject: subject.trim(),
          text: body.trim(),
        };
        if (replyTo) emailPayload.reply_to = replyTo;
        await resendClient.emails.send(emailPayload);
        emailSent = true;
      } catch (e) {
        sendError = e.message;
        console.error('Resend error:', e.message);
      }
    } else {
      // Email not configured — log it anyway as a draft/manual record
      sendError = 'Email sending not configured (RESEND_API_KEY not set)';
    }

    // Log the email regardless of whether it actually sent
    const { rows: logRows } = await db.query(
      `INSERT INTO prospect_emails (company_id,prospect_id,to_email,reply_to,subject,body,sent_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [cid, req.params.id, prospect.email.trim(), replyTo,
       subject.trim(), body.trim(), req.user.username]
    );

    if (!emailSent && resendClient) {
      return res.status(500).json({ error: sendError, logged: logRows[0] });
    }
    res.status(201).json({
      success: true,
      sent: emailSent,
      logged: logRows[0],
      note: emailSent ? null : sendError
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Payments ───────────────────────────────────────────────────────────────────

// GET /api/payments?container_id=X   — payments for one container
// GET /api/payments?customer_name=X  — payments for a customer (all containers)
app.get('/api/payments', authRequired, async (req, res) => {
  try {
    const cid = req.user.company_id;
    const { container_id, customer_name } = req.query;
    const params = [cid];
    const conds = ['company_id=$1'];
    if (container_id) { params.push(container_id); conds.push(`container_id=$${params.length}`); }
    if (customer_name) { params.push(customer_name); conds.push(`customer_name=$${params.length}`); }
    const { rows } = await db.query(
      `SELECT * FROM payments WHERE ${conds.join(' AND ')} ORDER BY payment_date DESC, created_at DESC`,
      params
    );
    res.json(rows.map(r => ({ ...r, amount: parseFloat(r.amount) || 0 })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/payments  — record a new payment
app.post('/api/payments', authRequired, async (req, res) => {
  try {
    const cid = req.user.company_id;
    const { container_id, container_number, customer_name, amount, payment_date, method, notes } = req.body || {};
    if (!amount || parseFloat(amount) <= 0)
      return res.status(400).json({ error: 'Amount must be greater than zero' });
    if (!payment_date)
      return res.status(400).json({ error: 'Payment date is required' });

    // If container_id given, verify it belongs to this company and pull details
    let cn = container_number || '';
    let cust = customer_name || '';
    if (container_id) {
      const { rows } = await db.query(
        'SELECT container_number, customer_name FROM containers WHERE id=$1 AND company_id=$2',
        [container_id, cid]
      );
      if (rows[0]) { cn = rows[0].container_number; cust = rows[0].customer_name || cust; }
    }

    const { rows } = await db.query(
      `INSERT INTO payments (company_id, container_id, container_number, customer_name, amount, payment_date, method, notes, recorded_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [cid, container_id || null, cn, cust,
       parseFloat(amount), payment_date,
       method || 'Bank Transfer', notes || '', req.user.username]
    );
    // Update the container's payment_status to Paid
    if (container_id) {
      await db.query(
        `UPDATE containers SET payment_status='Paid' WHERE id=$1 AND company_id=$2`,
        [container_id, cid]
      );
    }
    res.status(201).json({ ...rows[0], amount: parseFloat(rows[0].amount) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/payments/:id  — remove a payment record
app.delete('/api/payments/:id', authRequired, async (req, res) => {
  try {
    await db.query('DELETE FROM payments WHERE id=$1 AND company_id=$2',
      [req.params.id, req.user.company_id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── SPA fallback ──────────────────────────────────────────────────────────────
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ── Boot ──────────────────────────────────────────────────────────────────────
initDb()
  .then(() => app.listen(PORT, () => {
    console.log(`\n🚛  Storage CRM (multi-tenant) → http://localhost:${PORT}`);
    console.log(`   Demo login: admin / admin123\n`);
  }))
  .catch(err => { console.error('DB init failed:', err.message); process.exit(1); });
