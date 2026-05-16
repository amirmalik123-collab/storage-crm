const express  = require('express');
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');
const cors     = require('cors');
const path     = require('path');
const { Pool } = require('pg');

const app        = express();
const PORT       = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'storage-crm-dev-secret';

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Database connection ───────────────────────────────────────────────────────
// Railway provides DATABASE_URL automatically. For local dev you can set it too.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

const db = {
  query: (text, params) => pool.query(text, params)
};

// ── Schema + seed data ────────────────────────────────────────────────────────
async function initDb() {
  // Create tables
  await db.query(`
    CREATE TABLE IF NOT EXISTS users (
      id          SERIAL PRIMARY KEY,
      username    TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      full_name   TEXT DEFAULT '',
      role        TEXT DEFAULT 'user',
      created_at  TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS containers (
      id                  SERIAL PRIMARY KEY,
      container_number    TEXT UNIQUE NOT NULL,
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
      payment_status      TEXT DEFAULT 'Pending',
      notes               TEXT DEFAULT '',
      created_at          TIMESTAMPTZ DEFAULT NOW(),
      updated_at          TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // Seed admin user if no users exist
  const { rows: userRows } = await db.query('SELECT COUNT(*) AS c FROM users');
  if (parseInt(userRows[0].c) === 0) {
    const hash = bcrypt.hashSync('admin123', 10);
    await db.query(
      `INSERT INTO users (username, password_hash, full_name, role)
       VALUES ($1, $2, $3, $4)`,
      ['admin', hash, 'Administrator', 'admin']
    );
    console.log('✓ Default user created: admin / admin123');
  }

  // Seed container data if no containers exist
  const { rows: contRows } = await db.query('SELECT COUNT(*) AS c FROM containers');
  if (parseInt(contRows[0].c) === 0) {
    const seed = [
      ['C-001','20ft','Back Row',null,'2026-02-28',null,'Mark Reid',true,true,'','','','','',true,false,87,'Paid',''],
      ['C-002','20ft','Back Row',null,'2026-03-21',null,'Jason Drake',true,true,'','','','','',true,false,87,'Paid',''],
      ['C-003','20ft','Back Row',null,'2026-03-06','2026-05-04','',true,true,'','','','','',true,false,220,'Overdue',''],
      ['C-004','20ft','Back Row',null,'2026-03-30',null,'Laszlo Kondas',true,true,'','','','','',true,false,0,'Pending','Had to manually give him access on the lock for 24/7. Review, as it expires 30th May'],
      ['C-005','20ft','Back Row',null,'2026-04-06',null,'Justin Dodsworth',true,true,'','','','','',true,false,85,'Paid',''],
      ['C-006','20ft','Back Row',null,'2026-05-16',null,'Paul Shelton',true,true,'','','','','',true,true,135,'Pending',''],
      ['C-007','20ft','Back Row',null,'2026-04-18',null,'Wayne Heath',true,true,'','','','','',true,true,0,'Paid',''],
      ['C-008','20ft','Back Row',null,'2026-06-06',null,'Richard Fofie',true,true,'','','','','',false,false,220,'Pending',''],
      ['C-009','20ft','Back Row',null,'2026-06-05','2026-05-05','Margaret Swanwick',false,false,'','','','','',false,true,150,'Pending',''],
      ['C-010','20ft','Back Row',null,'2026-03-12','2026-05-11','Graham Pretty',true,true,'','','','','',true,true,0,'Paid',''],
      ['C-011','20ft','Back Row',null,'2026-05-20',null,'Matt Statham',false,false,'','','','','',false,true,135,'',''],
      ['C-012','20ft','Back Row',null,'2026-04-18',null,'Uzma Hanif',true,true,'','','','','',true,false,0,'',''],
      ['C-013','20ft','Back Row',null,null,null,'',true,false,'','','','','',false,false,0,'Pending',''],
      ['C-014','20ft','Back Row',null,'2026-05-11',null,'Paul Ewing',true,true,'','','','','',true,false,0,'Paid','Had to manually give her access to lock. Review expiry date'],
      ['C-015','20ft','Back Row',null,'2026-05-16',null,'Paul Shelton',true,true,'','','','','',true,true,135,'Pending',''],
      ['C-016','8ft','Front Row',null,'2026-03-28',null,'Katie Denton',true,true,'','','','','',true,false,0,'Paid',''],
      ['C-017','20ft','Back Row',null,'2026-06-02',null,'Ian Torbet',true,true,'','','','','',true,false,0,'Paid','Have to assign lock'],
      ['C-018','20ft','Back Row',null,'2026-06-04',null,'Gyula Zsiga',true,true,'','','','','',true,false,0,'Paid','Have to assign lock'],
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
          (container_number,container_size,location,order_date,start_date,end_date,
           customer_name,joining_email_sent,id_check,phone,email,address1,address2,
           postcode,contract_signed,insurance,monthly_rate,payment_status,notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
        row
      );
    }
    console.log(`✓ Seeded ${seed.length} containers`);
  }

  console.log('✓ Database ready');
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function deriveStatus(start_date, end_date) {
  if (!start_date) return 'Vacant';
  const today = new Date(); today.setHours(0,0,0,0);
  if (!end_date || new Date(end_date) >= today) return 'Occupied';
  return 'Vacant';
}

function enrichContainer(c) {
  const today = new Date(); today.setHours(0,0,0,0);
  c.status = deriveStatus(c.start_date, c.end_date);
  c.days_occupied = c.start_date
    ? Math.floor(((c.end_date ? new Date(c.end_date) : today) - new Date(c.start_date)) / 86400000)
    : null;
  c.days_until_expiry = (c.status === 'Occupied' && c.end_date)
    ? Math.floor((new Date(c.end_date) - today) / 86400000)
    : null;
  return c;
}

function authRequired(req, res, next) {
  const h = req.headers.authorization;
  if (!h || !h.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorised' });
  try { req.user = jwt.verify(h.slice(7), JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Invalid or expired token' }); }
}

function orNull(v) { return (v === '' || v === undefined) ? null : v; }

// ── Auth ──────────────────────────────────────────────────────────────────────
app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
    const { rows } = await db.query('SELECT * FROM users WHERE username = $1', [username]);
    const user = rows[0];
    if (!user || !bcrypt.compareSync(password, user.password_hash))
      return res.status(401).json({ error: 'Invalid credentials' });
    const token = jwt.sign({ id: user.id, username: user.username, role: user.role }, JWT_SECRET, { expiresIn: '8h' });
    res.json({ token, user: { id: user.id, username: user.username, full_name: user.full_name, role: user.role } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/auth/me', authRequired, async (req, res) => {
  try {
    const { rows } = await db.query('SELECT id,username,full_name,role FROM users WHERE id=$1', [req.user.id]);
    rows[0] ? res.json(rows[0]) : res.status(404).json({ error: 'Not found' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/auth/change-password', authRequired, async (req, res) => {
  try {
    const { current_password, new_password } = req.body || {};
    if (!current_password || !new_password) return res.status(400).json({ error: 'Both passwords required' });
    if (new_password.length < 6) return res.status(400).json({ error: 'New password must be at least 6 characters' });
    const { rows } = await db.query('SELECT * FROM users WHERE id=$1', [req.user.id]);
    if (!bcrypt.compareSync(current_password, rows[0].password_hash))
      return res.status(401).json({ error: 'Current password incorrect' });
    await db.query('UPDATE users SET password_hash=$1 WHERE id=$2', [bcrypt.hashSync(new_password, 10), req.user.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Dashboard ─────────────────────────────────────────────────────────────────
app.get('/api/dashboard', authRequired, async (req, res) => {
  try {
    const { rows } = await db.query('SELECT * FROM containers ORDER BY container_number');
    const all = rows.map(enrichContainer);
    const occupied = all.filter(c => c.status === 'Occupied');
    const expiring30 = occupied
      .filter(c => c.days_until_expiry !== null && c.days_until_expiry <= 30 && c.days_until_expiry >= 0)
      .sort((a,b) => a.days_until_expiry - b.days_until_expiry);
    res.json({
      total: all.length,
      occupied: occupied.length,
      vacant: all.filter(c => c.status === 'Vacant').length,
      occupancy_rate: all.length ? occupied.length / all.length : 0,
      expiring_soon: expiring30.length,
      overdue_payments: all.filter(c => c.payment_status === 'Overdue').length,
      monthly_revenue: occupied.reduce((s,c) => s + (parseFloat(c.monthly_rate) || 0), 0),
      expiring_containers: expiring30
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Containers ────────────────────────────────────────────────────────────────
app.get('/api/containers', authRequired, async (req, res) => {
  try {
    const { search, status, payment_status, location } = req.query;
    let sql = 'SELECT * FROM containers WHERE 1=1';
    const params = [];
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
    const { rows } = await db.query('SELECT * FROM containers WHERE id=$1', [req.params.id]);
    rows[0] ? res.json(enrichContainer(rows[0])) : res.status(404).json({ error: 'Not found' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/containers', authRequired, async (req, res) => {
  try {
    const d = req.body;
    if (!d.container_number) return res.status(400).json({ error: 'Container number required' });
    const { rows } = await db.query(
      `INSERT INTO containers
        (container_number,container_size,location,order_date,start_date,end_date,
         customer_name,joining_email_sent,id_check,phone,email,address1,address2,
         postcode,contract_signed,insurance,monthly_rate,payment_status,notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
       RETURNING *`,
      [d.container_number, d.container_size||'20ft', d.location||'Back Row',
       orNull(d.order_date), orNull(d.start_date), orNull(d.end_date),
       d.customer_name||'', !!d.joining_email_sent, !!d.id_check,
       d.phone||'', d.email||'', d.address1||'', d.address2||'', d.postcode||'',
       !!d.contract_signed, !!d.insurance,
       parseFloat(d.monthly_rate)||0, d.payment_status||'Pending', d.notes||'']
    );
    res.status(201).json(enrichContainer(rows[0]));
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Container number already exists' });
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/containers/:id', authRequired, async (req, res) => {
  try {
    const d = req.body;
    const { rows } = await db.query(
      `UPDATE containers SET
        container_number=$1,container_size=$2,location=$3,order_date=$4,start_date=$5,
        end_date=$6,customer_name=$7,joining_email_sent=$8,id_check=$9,phone=$10,
        email=$11,address1=$12,address2=$13,postcode=$14,contract_signed=$15,
        insurance=$16,monthly_rate=$17,payment_status=$18,notes=$19,updated_at=NOW()
       WHERE id=$20 RETURNING *`,
      [d.container_number, d.container_size, d.location,
       orNull(d.order_date), orNull(d.start_date), orNull(d.end_date),
       d.customer_name||'', !!d.joining_email_sent, !!d.id_check,
       d.phone||'', d.email||'', d.address1||'', d.address2||'', d.postcode||'',
       !!d.contract_signed, !!d.insurance,
       parseFloat(d.monthly_rate)||0, d.payment_status||'Pending', d.notes||'',
       req.params.id]
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
    const { rows } = await db.query('DELETE FROM containers WHERE id=$1 RETURNING id', [req.params.id]);
    rows[0] ? res.json({ success: true }) : res.status(404).json({ error: 'Not found' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Users ─────────────────────────────────────────────────────────────────────
app.get('/api/users', authRequired, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  try {
    const { rows } = await db.query('SELECT id,username,full_name,role,created_at FROM users ORDER BY id');
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/users', authRequired, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  try {
    const { username, password, full_name, role } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
    const { rows } = await db.query(
      `INSERT INTO users (username,password_hash,full_name,role)
       VALUES ($1,$2,$3,$4) RETURNING id,username,full_name,role,created_at`,
      [username, bcrypt.hashSync(password,10), full_name||'', role||'user']
    );
    res.status(201).json(rows[0]);
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Username already exists' });
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/users/:id', authRequired, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  if (parseInt(req.params.id) === req.user.id) return res.status(400).json({ error: 'Cannot delete your own account' });
  try {
    await db.query('DELETE FROM users WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── SPA fallback ──────────────────────────────────────────────────────────────
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ── Start ─────────────────────────────────────────────────────────────────────
initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`\n🚛  Container Storage CRM → http://localhost:${PORT}`);
      console.log(`   Login: admin / admin123\n`);
    });
  })
  .catch(err => {
    console.error('Failed to initialise database:', err.message);
    process.exit(1);
  });
