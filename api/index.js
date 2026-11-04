require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const { pool, query, genId, now, hashPassword, comparePassword } = require('../lib/db');

const app = express();
app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '1mb' }));

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const JWT_EXPIRES = process.env.JWT_EXPIRES || '7d';
const AI_PROVIDER = process.env.AI_PROVIDER || 'none';
const AI_API_KEY = process.env.AI_API_KEY || '';
const AI_BASE_URL = (process.env.AI_BASE_URL || process.env.KILO_OPENROUTER_BASE || 'https://openrouter.ai/api/v1').replace(/\/+$/, '');
const AI_MODEL = process.env.AI_MODEL || 'openai/gpt-4o-mini';

function signToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES });
}
function authenticate(req, res, next) {
  const header = req.headers.authorization || '';
  const parts = header.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer') {
    return res.status(401).json({ error: 'Token de autenticación requerido' });
  }
  try {
    const decoded = jwt.verify(parts[1], JWT_SECRET);
    req.user = { id: decoded.id, email: decoded.email, role: decoded.role };
    return next();
  } catch (err) {
    return res.status(401).json({ error: 'Token inválido o expirado' });
  }
}

// ---------- validation helpers ----------
function requiredString(val, name, { min = 1, max = 255, allowEmpty = false } = {}) {
  if (val === undefined || val === null) throw new Error(`${name} es requerido`);
  const s = String(val);
  if (!allowEmpty && s.length < min) throw new Error(`${name} es requerido`);
  if (s.length > max) throw new Error(`${name} excede ${max} caracteres`);
  return s;
}
function requiredEmail(val, name) {
  const s = requiredString(val, name).trim();
  const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!re.test(s)) throw new Error(`${name} inválido`);
  return s;
}
function positiveNumber(val, name) {
  const n = Number(val);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${name} debe ser un número válido`);
  return n;
}
function optionalString(val, name, { max = 255 } = {}) {
  if (val === undefined || val === null || val === '') return '';
  const s = String(val);
  if (s.length > max) throw new Error(`${name} excede ${max} caracteres`);
  return s;
}
function statusValue(val) {
  const s = optionalString(val, 'status');
  const allowed = ['draft', 'sent', 'paid', 'overdue', 'cancelled'];
  if (!allowed.includes(s)) throw new Error('Estado de factura inválido');
  return s;
}
function reminderTypeValue(val) {
  const s = optionalString(val, 'reminder_type');
  const allowed = ['before_due', 'due', 'first_overdue', 'second_overdue', 'final_overdue'];
  if (!allowed.includes(s)) throw new Error('Tipo de recordatorio inválido');
  return s;
}
function toneValue(val) {
  const s = optionalString(val, 'tone');
  const allowed = ['friendly', 'professional', 'firm'];
  if (!allowed.includes(s)) throw new Error('Tono inválido');
  return s;
}
function planValue(val) {
  const s = optionalString(val, 'plan');
  const allowed = ['free', 'pro', 'business'];
  if (!allowed.includes(s)) throw new Error('Plan inválido');
  return s;
}
function jsonField(val, name, def = {}) {
  if (val === undefined || val === null || val === '') return def;
  if (typeof val === 'object') return val;
  try { return JSON.parse(String(val)); } catch { throw new Error(`${name} debe ser JSON válido`); }
}
function parseCronNext(cron) {
  const nowMs = Date.now();
  if (!cron) return nowMs + 24 * 60 * 60 * 1000;
  const m = cron.match(/^\*\/\d+\s+\*\s+\*\s+\*\s+\*$/);
  if (m) { const n = parseInt(cron.split(/\s+/)[0].replace('*/', ''), 10) || 1; return nowMs + n * 60 * 60 * 1000; }
  const m2 = cron.match(/^0\s+\*\/\d+\s+\*\s+\*\s+\*$/);
  if (m2) { const n = parseInt(cron.split(/\s+/)[1].replace('*/', ''), 10) || 24; return nowMs + n * 60 * 60 * 1000; }
  return nowMs + 24 * 60 * 60 * 1000;
}

// ---------- init schema (idempotent) ----------
async function initDb() {
  await query(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      name TEXT NOT NULL DEFAULT '',
      role TEXT NOT NULL DEFAULT 'user',
      email_verified INTEGER NOT NULL DEFAULT 0,
      email_verification_token TEXT,
      password_reset_token TEXT,
      password_reset_expires BIGINT,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS profiles (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL UNIQUE,
      company_name TEXT DEFAULT '',
      company_address TEXT DEFAULT '',
      company_tax_id TEXT DEFAULT '',
      currency TEXT DEFAULT 'EUR',
      language TEXT DEFAULT 'es',
      timezone TEXT DEFAULT 'Europe/Madrid',
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS clients (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL DEFAULT '',
      email TEXT DEFAULT '',
      address TEXT DEFAULT '',
      tax_id TEXT DEFAULT '',
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS invoices (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      client_id TEXT,
      invoice_number TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'draft',
      issue_date TEXT NOT NULL DEFAULT '',
      due_date TEXT NOT NULL DEFAULT '',
      amount REAL NOT NULL DEFAULT 0,
      currency TEXT DEFAULT 'EUR',
      description TEXT DEFAULT '',
      notes TEXT DEFAULT '',
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS reminders (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      invoice_id TEXT NOT NULL,
      reminder_type TEXT NOT NULL DEFAULT 'due',
      tone TEXT NOT NULL DEFAULT 'professional',
      language TEXT DEFAULT 'es',
      message TEXT DEFAULT '',
      ai_generated INTEGER NOT NULL DEFAULT 0,
      created_at BIGINT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS reminder_history (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      invoice_id TEXT NOT NULL,
      reminder_id TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      channel TEXT DEFAULT 'email',
      sent_at BIGINT,
      error_message TEXT DEFAULT '',
      created_at BIGINT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS automations (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL DEFAULT '',
      description TEXT DEFAULT '',
      is_active INTEGER NOT NULL DEFAULT 0,
      reminder_type TEXT NOT NULL DEFAULT 'due',
      tone TEXT NOT NULL DEFAULT 'professional',
      language TEXT DEFAULT 'es',
      schedule_cron TEXT DEFAULT '',
      conditions TEXT DEFAULT '{}',
      last_run_at BIGINT,
      next_run_at BIGINT,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS subscriptions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL UNIQUE,
      plan TEXT NOT NULL DEFAULT 'free',
      status TEXT NOT NULL DEFAULT 'active',
      stripe_customer_id TEXT DEFAULT '',
      stripe_subscription_id TEXT DEFAULT '',
      current_period_start BIGINT,
      current_period_end BIGINT,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS usage (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      month TEXT NOT NULL,
      invoices_count INTEGER NOT NULL DEFAULT 0,
      ai_generations_count INTEGER NOT NULL DEFAULT 0,
      automations_count INTEGER NOT NULL DEFAULT 0,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS settings (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT DEFAULT '{}',
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL
    );
  `);

  // indexes
  await query(`CREATE INDEX IF NOT EXISTS idx_clients_user ON clients(user_id)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_invoices_user ON invoices(user_id)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices(user_id, status)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_reminders_user ON reminders(user_id)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_automations_user ON automations(user_id)`);
  await query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_usage_user_month ON usage(user_id, month)`);
  await query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_settings_user_key ON settings(user_id, key)`);
  await query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_subscriptions_user ON subscriptions(user_id)`);

  const t = now();
  await query(
    `INSERT INTO subscriptions (id, user_id, plan, status, created_at, updated_at)
     SELECT id, id, 'free', 'active', $1, $1 FROM users u
     WHERE NOT EXISTS (SELECT 1 FROM subscriptions s WHERE s.user_id = u.id)`,
    [t]
  );
}
initDb().catch(console.error);

// ---------- api limiter ----------
const apiLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 300, message: { error: 'Demasiadas solicitudes, inténtalo más tarde' } });
app.use('/api', apiLimiter);

// ==================== AUTH ====================
app.post('/auth/register', async (req, res) => {
  try {
    const email = requiredEmail(req.body.email, 'email');
    const password = requiredString(req.body.password, 'password', { min: 6, max: 128 });
    const name = optionalString(req.body.name, 'name', { max: 100 });
    const exists = await query('SELECT id FROM users WHERE email = $1', [email]);
    if (exists.length) return res.status(409).json({ error: 'El correo electrónico ya está registrado' });
    const id = genId(); const created = now(); const verificationToken = genId();
    await query(
      `INSERT INTO users (id, email, password_hash, name, email_verified, email_verification_token, created_at, updated_at)
       VALUES ($1,$2,$3,$4,0,$5,$6,$6)`,
      [id, email, hashPassword(password), name, verificationToken, created]
    );
    await query(`INSERT INTO profiles (id, user_id, created_at, updated_at) VALUES ($1,$2,$3,$3)`, [genId(), id, created]);
    await query(`INSERT INTO subscriptions (id, user_id, plan, status, created_at, updated_at) VALUES ($1,$2,'free','active',$3,$3)`, [genId(), id, created]);
    console.log(`[verify-email] ${email} token=${verificationToken}`);
    const token = signToken({ id, email, role: 'user' });
    return res.status(201).json({ message: 'Registro exitoso. Verifica tu correo electrónico.', user: { id, email, name, email_verified: 0 }, token });
  } catch (err) { return res.status(400).json({ error: err.message }); }
});

app.post('/auth/login', async (req, res) => {
  try {
    const email = requiredEmail(req.body.email, 'email');
    const password = requiredString(req.body.password, 'password');
    const rows = await query('SELECT * FROM users WHERE email = $1', [email]);
    const user = rows[0];
    if (!user || !(await comparePassword(password, user.password_hash))) {
      return res.status(401).json({ error: 'Credenciales inválidas' });
    }
    await query('UPDATE users SET updated_at = $1 WHERE id = $2', [now(), user.id]);
    const token = signToken({ id: user.id, email: user.email, role: user.role });
    return res.json({ message: 'Inicio de sesión exitoso', user: { id: user.id, email: user.email, name: user.name, role: user.role, email_verified: !!user.email_verified }, token });
  } catch (err) { return res.status(400).json({ error: err.message }); }
});

app.post('/auth/logout', authenticate, (req, res) => {
  return res.json({ message: 'Sesión cerrada. Elimina el token del cliente.' });
});

app.get('/auth/verify-email', async (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(400).json({ error: 'Token de verificación requerido' });
  const rows = await query('SELECT id FROM users WHERE email_verification_token = $1', [token]);
  if (!rows.length) return res.status(400).json({ error: 'Token inválido' });
  await query(`UPDATE users SET email_verified = 1, email_verification_token = NULL, updated_at = $1 WHERE id = $2`, [now(), rows[0].id]);
  return res.json({ message: 'Correo verificado exitosamente' });
});

app.post('/auth/forgot-password', async (req, res) => {
  try {
    const email = requiredEmail(req.body.email, 'email');
    const rows = await query('SELECT id FROM users WHERE email = $1', [email]);
    if (!rows.length) return res.json({ message: 'Si el correo existe, recibirás instrucciones de restablecimiento' });
    const resetToken = genId(); const expires = now() + 1000 * 60 * 60;
    await query(`UPDATE users SET password_reset_token = $1, password_reset_expires = $2, updated_at = $3 WHERE id = $4`, [resetToken, expires, now(), rows[0].id]);
    console.log(`[reset-password] ${email} token=${resetToken}`);
    return res.json({ message: 'Si el correo existe, recibirás instrucciones de restablecimiento' });
  } catch (err) { return res.status(400).json({ error: err.message }); }
});

app.post('/auth/reset-password', async (req, res) => {
  try {
    const token = requiredString(req.body.token, 'token');
    const password = requiredString(req.body.password, 'password', { min: 6, max: 128 });
    const rows = await query('SELECT id FROM users WHERE password_reset_token = $1 AND password_reset_expires > $2', [token, now()]);
    if (!rows.length) return res.status(400).json({ error: 'Token inválido o expirado' });
    await query(`UPDATE users SET password_hash = $1, password_reset_token = NULL, password_reset_expires = NULL, updated_at = $2 WHERE id = $3`, [hashPassword(password), now(), rows[0].id]);
    return res.json({ message: 'Contraseña restablecida exitosamente' });
  } catch (err) { return res.status(400).json({ error: err.message }); }
});

app.get('/auth/profile', authenticate, async (req, res) => {
  const rows = await query('SELECT id, email, name, role, email_verified, created_at FROM users WHERE id = $1', [req.user.id]);
  if (!rows.length) return res.status(404).json({ error: 'Usuario no encontrado' });
  const user = rows[0];
  const profileRows = await query('SELECT * FROM profiles WHERE user_id = $1', [req.user.id]);
  const subRows = await query('SELECT plan, status FROM subscriptions WHERE user_id = $1', [req.user.id]);
  return res.json({ user: { ...user, profile: profileRows[0] || null, subscription: subRows[0] || null } });
});

app.put('/auth/profile', authenticate, async (req, res) => {
  try {
    const name = optionalString(req.body.name, 'name', { max: 100 });
    await query('UPDATE users SET name = $1, updated_at = $2 WHERE id = $3', [name, now(), req.user.id]);
    return res.json({ message: 'Perfil actualizado' });
  } catch (err) { return res.status(400).json({ error: err.message }); }
});

// ==================== CLIENTS ====================
app.get('/clients', authenticate, async (req, res) => {
  const rows = await query('SELECT * FROM clients WHERE user_id = $1 ORDER BY name COLLATE NOCASE ASC', [req.user.id]);
  return res.json(rows);
});
app.post('/clients', authenticate, async (req, res) => {
  try {
    const name = requiredString(req.body.name, 'name');
    const email = optionalString(req.body.email, 'email');
    const address = optionalString(req.body.address, 'address');
    const taxId = optionalString(req.body.tax_id, 'tax_id');
    const id = genId(); const created = now();
    await query(`INSERT INTO clients (id, user_id, name, email, address, tax_id, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$7)`, [id, req.user.id, name, email, address, taxId, created]);
    return res.status(201).json({ id, user_id: req.user.id, name, email, address, tax_id: taxId, created_at: created, updated_at: created });
  } catch (err) { return res.status(400).json({ error: err.message }); }
});
app.get('/clients/:id', authenticate, async (req, res) => {
  const rows = await query('SELECT * FROM clients WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
  if (!rows.length) return res.status(404).json({ error: 'Cliente no encontrado' });
  return res.json(rows[0]);
});
app.put('/clients/:id', authenticate, async (req, res) => {
  try {
    const rows = await query('SELECT id FROM clients WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    if (!rows.length) return res.status(404).json({ error: 'Cliente no encontrado' });
    const name = optionalString(req.body.name, 'name');
    const email = optionalString(req.body.email, 'email');
    const address = optionalString(req.body.address, 'address');
    const taxId = optionalString(req.body.tax_id, 'tax_id');
    await query(`UPDATE clients SET name = $1, email = $2, address = $3, tax_id = $4, updated_at = $5 WHERE id = $6 AND user_id = $7`, [name, email, address, taxId, now(), req.params.id, req.user.id]);
    return res.json({ message: 'Cliente actualizado' });
  } catch (err) { return res.status(400).json({ error: err.message }); }
});
app.delete('/clients/:id', authenticate, async (req, res) => {
  const rows = await query('SELECT id FROM clients WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
  if (!rows.length) return res.status(404).json({ error: 'Cliente no encontrado' });
  await query('DELETE FROM clients WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
  return res.json({ message: 'Cliente eliminado' });
});

// ==================== INVOICES ====================
const PLAN_LIMITS = { free: { invoices: 50, ai_generations: 10, automations: 3 }, pro: { invoices: 1000, ai_generations: 500, automations: 20 }, business: { invoices: 100000, ai_generations: 5000, automations: 200 } };
function planLimits(plan) { return PLAN_LIMITS[plan] || PLAN_LIMITS.free; }

async function getPlan(userId) {
  const rows = await query('SELECT plan FROM subscriptions WHERE user_id = $1', [userId]);
  return (rows[0] && rows[0].plan) || 'free';
}
async function incrementUsage(userId, field) {
  const month = new Date().toISOString().slice(0, 7);
  let row = await query('SELECT * FROM usage WHERE user_id = $1 AND month = $2', [userId, month]);
  if (!row.length) {
    const id = genId(); const created = now();
    await query(`INSERT INTO usage (id, user_id, month, invoices_count, ai_generations_count, automations_count, created_at, updated_at) VALUES ($1,$2,$3,0,0,0,$4,$4)`, [id, userId, month, created]);
    row = [{ invoices_count: 0, ai_generations_count: 0, automations_count: 0, id }];
  }
  const updates = { invoices_count: 0, ai_generations_count: 0, automations_count: 0 };
  updates[field] = (row[0][field] || 0) + 1;
  await query(`UPDATE usage SET ${field} = $1, updated_at = $2 WHERE id = $3`, [updates[field], now(), row[0].id]);
}
async function checkLimit(userId, field, limit) {
  const month = new Date().toISOString().slice(0, 7);
  const row = await query('SELECT * FROM usage WHERE user_id = $1 AND month = $2', [userId, month]);
  const current = row.length ? (row[0][field] || 0) : 0;
  return current < limit;
}

app.get('/invoices', authenticate, async (req, res) => {
  const { status, search, sort = 'created_at', order = 'desc', client_id } = req.query;
  let sql = `SELECT i.*, c.name AS client_name, c.email AS client_email FROM invoices i LEFT JOIN clients c ON i.client_id = c.id WHERE i.user_id = $1`;
  const params = [req.user.id]; let idx = 2;
  if (status) { sql += ` AND i.status = $${idx++}`; params.push(status); }
  if (client_id) { sql += ` AND i.client_id = $${idx++}`; params.push(client_id); }
  if (search) {
    sql += ` AND (i.invoice_number LIKE $${idx} OR i.description LIKE $${idx+1} OR c.name LIKE $${idx+2} OR c.email LIKE $${idx+3})`;
    const like = `%${search}%`; params.push(like, like, like, like); idx += 4;
  }
  const allowedSort = ['invoice_number', 'status', 'issue_date', 'due_date', 'amount', 'created_at', 'updated_at'];
  const sortCol = allowedSort.includes(sort) ? sort : 'created_at';
  const sortDir = order === 'asc' ? 'ASC' : 'DESC';
  sql += ` ORDER BY i.${sortCol} ${sortDir}`;
  const rows = await query(sql, params);
  return res.json(rows);
});
app.get('/invoices/stats', authenticate, async (req, res) => {
  const userId = req.user.id;
  const total = (await query('SELECT COUNT(*) AS c FROM invoices WHERE user_id = $1', [userId]))[0].c;
  const pending = (await query("SELECT COUNT(*) AS c FROM invoices WHERE user_id = $1 AND status IN ('draft','sent')", [userId]))[0].c;
  const overdue = (await query("SELECT COUNT(*) AS c FROM invoices WHERE user_id = $1 AND status = 'overdue'", [userId]))[0].c;
  const paid = (await query("SELECT COUNT(*) AS c FROM invoices WHERE user_id = $1 AND status = 'paid'", [userId]))[0].c;
  const pendingAmount = (await query("SELECT COALESCE(SUM(amount),0) AS total FROM invoices WHERE user_id = $1 AND status IN ('draft','sent')", [userId]))[0].total;
  const paidAmount = (await query("SELECT COALESCE(SUM(amount),0) AS total FROM invoices WHERE user_id = $1 AND status = 'paid'", [userId]))[0].total;
  const months = []; for (let i = 5; i >= 0; i--) { const d = new Date(); d.setMonth(d.getMonth() - i); months.push(d.toISOString().slice(0, 7)); }
  const evolution = await query(`SELECT to_char(created_at, 'YYYY-MM') AS month, COUNT(*) AS count, COALESCE(SUM(amount),0) AS total FROM invoices WHERE user_id = $1 AND created_at >= $2 GROUP BY month`, [userId, new Date(Date.now() - 150 * 24 * 60 * 60 * 1000).toISOString()]);
  const evMap = {}; evolution.forEach(r => { evMap[r.month] = r; });
  const monthly = months.map(m => ({ month: m, count: (evMap[m] && evMap[m].count) || 0, total: (evMap[m] && evMap[m].total) || 0 }));
  const recent = await query(`SELECT i.id, i.invoice_number, i.status, i.amount, i.currency, i.created_at, c.name AS client_name FROM invoices i LEFT JOIN clients c ON i.client_id = c.id WHERE i.user_id = $1 ORDER BY i.updated_at DESC LIMIT 10`, [userId]);
  return res.json({ total_invoices: total, pending_invoices: pending, overdue_invoices: overdue, paid_invoices: paid, pending_amount: pendingAmount, paid_amount: paidAmount, monthly_evolution: monthly, recent_activity: recent });
});
app.post('/invoices', authenticate, async (req, res) => {
  try {
    const plan = await getPlan(req.user.id);
    const limits = planLimits(plan);
    if (!await checkLimit(req.user.id, 'invoices_count', limits.invoices)) {
      return res.status(403).json({ error: 'Límite de facturas alcanzado para tu plan' });
    }
    const clientId = optionalString(req.body.client_id, 'client_id');
    const invoiceNumber = requiredString(req.body.invoice_number, 'invoice_number');
    const status = statusValue(req.body.status);
    const issueDate = optionalString(req.body.issue_date, 'issue_date');
    const dueDate = optionalString(req.body.due_date, 'due_date');
    const amount = positiveNumber(req.body.amount, 'amount');
    const currency = optionalString(req.body.currency, 'currency', { max: 10 }) || 'EUR';
    const description = optionalString(req.body.description, 'description');
    const notes = optionalString(req.body.notes, 'notes', { max: 2000 });
    if (amount < 0) throw new Error('El importe no puede ser negativo');
    const id = genId(); const created = now();
    await query(`INSERT INTO invoices (id, user_id, client_id, invoice_number, status, issue_date, due_date, amount, currency, description, notes, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12)`, [id, req.user.id, clientId || null, invoiceNumber, status, issueDate, dueDate, amount, currency, description, notes, created]);
    await incrementUsage(req.user.id, 'invoices_count');
    const rows = await query('SELECT * FROM invoices WHERE id = $1 AND user_id = $2', [id, req.user.id]);
    return res.status(201).json(rows[0]);
  } catch (err) { return res.status(400).json({ error: err.message }); }
});
app.get('/invoices/:id', authenticate, async (req, res) => {
  const rows = await query('SELECT * FROM invoices WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
  if (!rows.length) return res.status(404).json({ error: 'Factura no encontrada' });
  return res.json(rows[0]);
});
app.put('/invoices/:id', authenticate, async (req, res) => {
  try {
    const rows = await query('SELECT id FROM invoices WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    if (!rows.length) return res.status(404).json({ error: 'Factura no encontrada' });
    const fields = []; const values = [];
    const set = (col, val) => { if (val !== undefined) { fields.push(`${col} = $${values.length + 2}`); values.push(val); } };
    values.push(req.params.id);
    set('client_id', optionalString(req.body.client_id, 'client_id') || null);
    if (req.body.invoice_number !== undefined) { fields.push(`invoice_number = $${values.length + 1}`); values.push(requiredString(req.body.invoice_number, 'invoice_number')); }
    if (req.body.status !== undefined) { fields.push(`status = $${values.length + 1}`); values.push(statusValue(req.body.status)); }
    if (req.body.issue_date !== undefined) { fields.push(`issue_date = $${values.length + 1}`); values.push(optionalString(req.body.issue_date, 'issue_date')); }
    if (req.body.due_date !== undefined) { fields.push(`due_date = $${values.length + 1}`); values.push(optionalString(req.body.due_date, 'due_date')); }
    if (req.body.amount !== undefined) { const a = positiveNumber(req.body.amount, 'amount'); if (a < 0) throw new Error('El importe no puede ser negativo'); fields.push(`amount = $${values.length + 1}`); values.push(a); }
    if (req.body.currency !== undefined) { fields.push(`currency = $${values.length + 1}`); values.push(optionalString(req.body.currency, 'currency', { max: 10 })); }
    if (req.body.description !== undefined) { fields.push(`description = $${values.length + 1}`); values.push(optionalString(req.body.description, 'description')); }
    if (req.body.notes !== undefined) { fields.push(`notes = $${values.length + 1}`); values.push(optionalString(req.body.notes, 'notes', { max: 2000 })); }
    fields.push(`updated_at = $${values.length + 1}`); values.push(now());
    values.push(req.user.id);
    await query(`UPDATE invoices SET ${fields.join(', ')} WHERE id = $1 AND user_id = $${values.length}`, values);
    return res.json({ message: 'Factura actualizada' });
  } catch (err) { return res.status(400).json({ error: err.message }); }
});
app.delete('/invoices/:id', authenticate, async (req, res) => {
  const rows = await query('SELECT id FROM invoices WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
  if (!rows.length) return res.status(404).json({ error: 'Factura no encontrada' });
  await query('DELETE FROM invoices WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
  return res.json({ message: 'Factura eliminada' });
});
app.patch('/invoices/:id/pay', authenticate, async (req, res) => {
  const rows = await query('SELECT id FROM invoices WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
  if (!rows.length) return res.status(404).json({ error: 'Factura no encontrada' });
  await query(`UPDATE invoices SET status = 'paid', updated_at = $1 WHERE id = $2 AND user_id = $3`, [now(), req.params.id, req.user.id]);
  return res.json({ message: 'Factura marcada como pagada' });
});

// ==================== REMINDERS ====================
const REMINDER_TYPES = { before_due: { key: 'before_due', label: 'Recordatorio previo al vencimiento' }, due: { key: 'due', label: 'Recordatorio de vencimiento' }, first_overdue: { key: 'first_overdue', label: 'Primer aviso de retraso' }, second_overdue: { key: 'second_overdue', label: 'Segundo aviso' }, final_overdue: { key: 'final_overdue', label: 'Último aviso' } };
const TONES = { friendly: { key: 'friendly', label: 'Cercano / Friendly' }, professional: { key: 'professional', label: 'Profesional / Professional' }, firm: { key: 'firm', label: 'Firme / Firm' } };
function templateMessage({ type, tone, language, invoice, client }) {
  const es = {
    before_due: { friendly: `Hola ${client.name}, te recordamos que la factura ${invoice.invoice_number} (${invoice.amount} ${invoice.currency}) vence el ${invoice.due_date}. Gracias.`, professional: `Estimado ${client.name}, le informamos que la factura ${invoice.invoice_number} por ${invoice.amount} ${invoice.currency} vence el ${invoice.due_date}. Quedamos a la espera.`, firm: `${client.name}, la factura ${invoice.invoice_number} (${invoice.amount} ${invoice.currency}) vence el ${invoice.due_date}. Rogamos su abono inmediato.` },
    due: { friendly: `Hola ${client.name}, hoy vence la factura ${invoice.invoice_number} por ${invoice.amount} ${invoice.currency}. ¿Puedes confirmar el pago?`, professional: `Estimado ${client.name}, la factura ${invoice.invoice_number} por ${invoice.amount} ${invoice.currency} vence hoy. Le rogamos gestione el pago.`, firm: `${client.name}, la factura ${invoice.invoice_number} (${invoice.amount} ${invoice.currency}) vence hoy. Requerimos el pago inmediato.` },
    first_overdue: { friendly: `Hola ${client.name}, la factura ${invoice.invoice_number} (${invoice.amount} ${invoice.currency}) tiene retraso. ¿Hay algún problema?`, professional: `Estimado ${client.name}, la factura ${invoice.invoice_number} por ${invoice.amount} ${invoice.currency} está vencida desde el ${invoice.due_date}. Le solicitamos regularizar.`, firm: `${client.name}, la factura ${invoice.invoice_number} (${invoice.amount} ${invoice.currency}) está vencida. Exigimos el pago inmediato.` },
    second_overdue: { friendly: `Hola ${client.name}, seguimos esperando el pago de la factura ${invoice.invoice_number} (${invoice.amount} ${invoice.currency}).`, professional: `Estimado ${client.name}, la factura ${invoice.invoice_number} por ${invoice.amount} ${invoice.currency} permanece impagada. Le requerimos formalmente.`, firm: `${client.name}, la factura ${invoice.invoice_number} (${invoice.amount} ${invoice.currency}) sigue sin pagarse. Último requerimiento.` },
    final_overdue: { friendly: `Hola ${client.name}, la factura ${invoice.invoice_number} (${invoice.amount} ${invoice.currency}) está muy retrasada. Contáctanos.`, professional: `Estimado ${client.name}, la factura ${invoice.invoice_number} por ${invoice.amount} ${invoice.currency} está gravemente vencida. Notificación final antes de gestiones de cobro.`, firm: `${client.name}, la factura ${invoice.invoice_number} (${invoice.amount} ${invoice.currency}) está vencida. Procederemos a acciones legales.` },
  };
  const byTone = (es[type] || {});
  return byTone[tone] || byTone.professional || `Recordatorio para ${client.name}: factura ${invoice.invoice_number} por ${invoice.amount} ${invoice.currency}.`;
}
async function callAI(prompt) {
  if (AI_PROVIDER !== 'openrouter' || !AI_API_KEY) return null;
  try {
    const res = await globalThis.fetch(`${AI_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${AI_API_KEY}` },
      body: JSON.stringify({ model: AI_MODEL, messages: [{ role: 'user', content: prompt }], temperature: 0.7, max_tokens: 600 }),
    });
    if (!res.ok) throw new Error(`Proveedor IA respondió ${res.status}`);
    const data = await res.json();
    return (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || null;
  } catch (err) { console.error('[ai-provider] error:', err.message); return null; }
}

app.get('/reminders/types', authenticate, (req, res) => {
  return res.json({ types: Object.values(REMINDER_TYPES), tones: Object.values(TONES) });
});
app.post('/reminders/generate', authenticate, async (req, res) => {
  try {
    const plan = await getPlan(req.user.id);
    const limits = planLimits(plan);
    const month = new Date().toISOString().slice(0, 7);
    const row = await query('SELECT * FROM usage WHERE user_id = $1 AND month = $2', [req.user.id, month]);
    const current = row.length ? (row[0].ai_generations_count || 0) : 0;
    if (current >= limits.ai_generations) return res.status(403).json({ error: 'Límite de generaciones IA alcanzado para tu plan' });
    const invoiceId = requiredString(req.body.invoice_id, 'invoice_id');
    const type = reminderTypeValue(req.body.reminder_type || 'due');
    const tone = toneValue(req.body.tone || 'professional');
    const language = optionalString(req.body.language, 'language', { max: 10 }) || 'es';
    const invRows = await query('SELECT * FROM invoices WHERE id = $1 AND user_id = $2', [invoiceId, req.user.id]);
    if (!invRows.length) return res.status(404).json({ error: 'Factura no encontrada' });
    const invoice = invRows[0];
    const clientRows = invoice.client_id ? await query('SELECT * FROM clients WHERE id = $1 AND user_id = $2', [invoice.client_id, req.user.id]) : [];
    const client = clientRows[0] || null;
    const clientName = (client && client.name) || 'Cliente';
    const clientEmail = (client && client.email) || '';
    const daysOverdue = invoice.due_date ? Math.max(0, Math.ceil((Date.now() - new Date(invoice.due_date).getTime()) / 86400000)) : 0;
    const prompt = `Eres un asistente especializado en cobranza profesional. Redacta un recordatorio de pago en idioma "${language}" con tono "${tone}" para el recordatorio: ${type}.

Datos:
- Cliente: ${clientName} (${clientEmail})
- Factura: ${invoice.invoice_number}
- Importe: ${invoice.amount} ${invoice.currency}
- Emisión: ${invoice.issue_date}
- Vencimiento: ${invoice.due_date}
- Días de retraso: ${daysOverdue}
- Descripción: ${invoice.description}
- Notas: ${invoice.notes}

Instrucciones: Escribe un mensaje claro, directo y listo para enviar por correo. Sin firma genérica, solo el cuerpo. Máximo 180 palabras.`;
    let message = null; let aiGenerated = 0; let providerUsed = 'template';
    if (AI_PROVIDER === 'openrouter' && AI_API_KEY) {
      const ai = await callAI(prompt);
      if (ai) { message = ai.trim(); aiGenerated = 1; providerUsed = 'openrouter'; }
    }
    if (!message) { message = templateMessage({ type, tone, language, invoice, client: { name: clientName, email: clientEmail } }); providerUsed = 'template'; }
    const id = genId(); const created = now();
    await query(`INSERT INTO reminders (id, user_id, invoice_id, reminder_type, tone, language, message, ai_generated, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [id, req.user.id, invoiceId, type, tone, language, message, aiGenerated, created]);
    await query(
      `INSERT INTO usage (id, user_id, month, invoices_count, ai_generations_count, automations_count, created_at, updated_at)
       VALUES ($1,$2,$3,0,1,0,$4,$4)
       ON CONFLICT (user_id, month) DO UPDATE SET ai_generations_count = usage.ai_generations_count + 1, updated_at = excluded.updated_at`,
      [genId(), req.user.id, month, now()]
    );
    return res.json({ id, message, type, tone, language, ai_generated: aiGenerated === 1, provider: providerUsed, ai_available: AI_PROVIDER === 'openrouter' && !!AI_API_KEY });
  } catch (err) { return res.status(400).json({ error: err.message }); }
});
app.get('/reminders', authenticate, async (req, res) => {
  const { invoice_id } = req.query;
  let sql = `SELECT r.*, i.invoice_number FROM reminders r LEFT JOIN invoices i ON r.invoice_id = i.id WHERE r.user_id = $1`;
  const params = [req.user.id]; let idx = 2;
  if (invoice_id) { sql += ` AND r.invoice_id = $${idx++}`; params.push(invoice_id); }
  sql += ` ORDER BY r.created_at DESC`;
  const rows = await query(sql, params);
  return res.json(rows);
});
app.get('/reminders/:id', authenticate, async (req, res) => {
  const rows = await query('SELECT * FROM reminders WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
  if (!rows.length) return res.status(404).json({ error: 'Recordatorio no encontrado' });
  return res.json(rows[0]);
});
app.put('/reminders/:id', authenticate, async (req, res) => {
  try {
    const rows = await query('SELECT id FROM reminders WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    if (!rows.length) return res.status(404).json({ error: 'Recordatorio no encontrado' });
    const message = requiredString(req.body.message, 'message');
    await query('UPDATE reminders SET message = $1 WHERE id = $2 AND user_id = $3', [message, req.params.id, req.user.id]);
    return res.json({ message: 'Recordatorio actualizado' });
  } catch (err) { return res.status(400).json({ error: err.message }); }
});
app.delete('/reminders/:id', authenticate, async (req, res) => {
  const rows = await query('SELECT id FROM reminders WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
  if (!rows.length) return res.status(404).json({ error: 'Recordatorio no encontrado' });
  await query('DELETE FROM reminders WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
  return res.json({ message: 'Recordatorio eliminado' });
});

// ==================== AUTOMATIONS ====================
app.get('/automations', authenticate, async (req, res) => {
  const rows = await query('SELECT * FROM automations WHERE user_id = $1 ORDER BY created_at DESC', [req.user.id]);
  return res.json(rows.map(r => ({ ...r, conditions: r.conditions ? (typeof r.conditions === 'string' ? JSON.parse(r.conditions) : r.conditions) : {} })));
});
app.post('/automations', authenticate, async (req, res) => {
  try {
    const plan = await getPlan(req.user.id);
    const limits = planLimits(plan);
    const count = (await query('SELECT COUNT(*) AS c FROM automations WHERE user_id = $1 AND is_active = 1', [req.user.id]))[0].c;
    if (count >= limits.automations) return res.status(403).json({ error: 'Límite de automatizaciones alcanzado para tu plan' });
    const name = requiredString(req.body.name, 'name');
    const description = optionalString(req.body.description, 'description');
    const isActive = req.body.is_active !== undefined ? (req.body.is_active ? 1 : 0) : 0;
    const reminderType = reminderTypeValue(req.body.reminder_type || 'due');
    const tone = toneValue(req.body.tone || 'professional');
    const language = optionalString(req.body.language, 'language', { max: 10 }) || 'es';
    const scheduleCron = optionalString(req.body.schedule_cron, 'schedule_cron', { max: 60 }) || '0 9 * * *';
    const conditions = jsonField(req.body.conditions, 'conditions');
    const id = genId(); const created = now(); const nextRun = parseCronNext(scheduleCron);
    await query(`INSERT INTO automations (id, user_id, name, description, is_active, reminder_type, tone, language, schedule_cron, conditions, last_run_at, next_run_at, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NULL,$11,$12,$12)`, [id, req.user.id, name, description, isActive, reminderType, tone, language, scheduleCron, JSON.stringify(conditions), nextRun, created]);
    return res.status(201).json({ id, user_id: req.user.id, name, description, is_active: isActive === 1, reminder_type: reminderType, tone, language, schedule_cron: scheduleCron, conditions, next_run_at: nextRun, created_at: created, updated_at: created });
  } catch (err) { return res.status(400).json({ error: err.message }); }
});
app.get('/automations/:id', authenticate, async (req, res) => {
  const rows = await query('SELECT * FROM automations WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
  if (!rows.length) return res.status(404).json({ error: 'Automatización no encontrada' });
  const r = rows[0]; r.conditions = r.conditions ? (typeof r.conditions === 'string' ? JSON.parse(r.conditions) : r.conditions) : {};
  return res.json(r);
});
app.put('/automations/:id', authenticate, async (req, res) => {
  try {
    const rows = await query('SELECT id FROM automations WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    if (!rows.length) return res.status(404).json({ error: 'Automatización no encontrada' });
    const fields = []; const values = [];
    const set = (col, val) => { if (val !== undefined) { fields.push(`${col} = $${values.length + 2}`); values.push(val); } };
    values.push(req.params.id);
    if (req.body.name !== undefined) { fields.push(`name = $${values.length + 1}`); values.push(optionalString(req.body.name, 'name')); }
    if (req.body.description !== undefined) { fields.push(`description = $${values.length + 1}`); values.push(optionalString(req.body.description, 'description')); }
    if (req.body.is_active !== undefined) { fields.push(`is_active = $${values.length + 1}`); values.push(req.body.is_active ? 1 : 0); }
    if (req.body.reminder_type !== undefined) { fields.push(`reminder_type = $${values.length + 1}`); values.push(reminderTypeValue(req.body.reminder_type)); }
    if (req.body.tone !== undefined) { fields.push(`tone = $${values.length + 1}`); values.push(toneValue(req.body.tone)); }
    if (req.body.language !== undefined) { fields.push(`language = $${values.length + 1}`); values.push(optionalString(req.body.language, 'language', { max: 10 })); }
    if (req.body.schedule_cron !== undefined) { fields.push(`schedule_cron = $${values.length + 1}`); values.push(optionalString(req.body.schedule_cron, 'schedule_cron', { max: 60 })); }
    if (req.body.conditions !== undefined) { fields.push(`conditions = $${values.length + 1}`); values.push(JSON.stringify(jsonField(req.body.conditions, 'conditions'))); }
    if (fields.length === 1) return res.status(400).json({ error: 'Nada que actualizar' });
    fields.push(`updated_at = $${values.length + 1}`); values.push(now());
    values.push(req.user.id);
    await query(`UPDATE automations SET ${fields.join(', ')} WHERE id = $1 AND user_id = $${values.length}`, values);
    return res.json({ message: 'Automatización actualizada' });
  } catch (err) { return res.status(400).json({ error: err.message }); }
});
app.delete('/automations/:id', authenticate, async (req, res) => {
  const rows = await query('SELECT id FROM automations WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
  if (!rows.length) return res.status(404).json({ error: 'Automatización no encontrada' });
  await query('DELETE FROM automations WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
  return res.json({ message: 'Automatización eliminada' });
});
app.post('/automations/:id/toggle', authenticate, async (req, res) => {
  const rows = await query('SELECT id, is_active, schedule_cron FROM automations WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
  if (!rows.length) return res.status(404).json({ error: 'Automatización no encontrada' });
  const a = rows[0]; const next = a.is_active === 1 ? 0 : 1;
  const nextRun = next === 1 ? parseCronNext(a.schedule_cron) : null;
  await query('UPDATE automations SET is_active = $1, next_run_at = $2, updated_at = $3 WHERE id = $4 AND user_id = $5', [next, nextRun, now(), req.params.id, req.user.id]);
  return res.json({ is_active: next === 1, next_run_at: nextRun });
});

// ==================== EMAIL (SMTP) ====================
function getSmtpConfig(userId) {
  return query("SELECT key, value FROM settings WHERE user_id = $1 AND key LIKE 'smtp_%'", [userId]).then(rows => {
    const cfg = {}; rows.forEach(r => { try { cfg[r.key.replace('smtp_', '')] = JSON.parse(r.value); } catch { cfg[r.key.replace('smtp_', '')] = r.value; } });
    return cfg;
  });
}
function isSmtpConfigured(cfg) { return !!(cfg.host && cfg.user && cfg.pass); }
function getFromAddress(userId) {
  return query("SELECT value FROM settings WHERE user_id = $1 AND key = 'email_from'", [userId]).then(rows => {
    if (!rows.length) return null;
    try { return JSON.parse(rows[0].value).address || ''; } catch { return rows[0].value || ''; }
  });
}
app.post('/email/configure', authenticate, async (req, res) => {
  try {
    const setSetting = async (key, value) => {
      const id = genId(); const created = now();
      await query(`INSERT INTO settings (id, user_id, key, value, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$5)
        ON CONFLICT (user_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`, [id, req.user.id, key, JSON.stringify(value), created]);
    };
    await setSetting('smtp_host', optionalString(req.body.host, 'host'));
    await setSetting('smtp_port', optionalString(req.body.port, 'port'));
    await setSetting('smtp_user', optionalString(req.body.user, 'user'));
    await setSetting('smtp_pass', optionalString(req.body.pass, 'pass'));
    await setSetting('email_from', { address: optionalString(req.body.from, 'from') });
    return res.json({ message: 'Configuración de correo guardada (solo backend)' });
  } catch (err) { return res.status(400).json({ error: err.message }); }
});
app.get('/email/configure', authenticate, async (req, res) => {
  const cfg = await getSmtpConfig(req.user.id);
  const from = await getFromAddress(req.user.id);
  return res.json({ configured: isSmtpConfigured(cfg), host: cfg.host || '', port: cfg.port || '', user: cfg.user || '', from: from || '' });
});
app.get('/email/history', authenticate, async (req, res) => {
  const { invoice_id } = req.query;
  let sql = `SELECT rh.*, i.invoice_number FROM reminder_history rh LEFT JOIN invoices i ON rh.invoice_id = i.id WHERE rh.user_id = $1`;
  const params = [req.user.id]; let idx = 2;
  if (invoice_id) { sql += ` AND rh.invoice_id = $${idx++}`; params.push(invoice_id); }
  sql += ` ORDER BY rh.created_at DESC`;
  const rows = await query(sql, params);
  return res.json(rows);
});
app.post('/email/send-test', authenticate, async (req, res) => {
  const cfg = await getSmtpConfig(req.user.id);
  if (!isSmtpConfigured(cfg)) return res.status(400).json({ error: 'SMTP no configurado' });
  const to = optionalString(req.body.to, 'to');
  if (!to) return res.status(400).json({ error: 'Destinatario requerido' });
  let transporter;
  try {
    transporter = nodemailer.createTransport({ host: cfg.host, port: parseInt(cfg.port, 10) || 587, secure: cfg.secure === 'true', auth: { user: cfg.user, pass: cfg.pass } });
    await transporter.verify();
  } catch (err) { return res.status(500).json({ error: `No se pudo conectar con SMTP: ${err.message}` }); }
  try {
    const from = await getFromAddress(req.user.id) || cfg.user;
    await transporter.sendMail({ from, to, subject: 'Prueba de correo - InvoiceNudge AI', text: 'Mensaje de prueba de InvoiceNudge AI.' });
    return res.json({ message: 'Correo de prueba enviado' });
  } catch (err) { return res.status(500).json({ error: `Error al enviar: ${err.message}` }); }
});

// ==================== SETTINGS ====================
app.get('/settings', authenticate, async (req, res) => {
  const rows = await query('SELECT key, value FROM settings WHERE user_id = $1', [req.user.id]);
  const out = {}; rows.forEach(r => { try { out[r.key] = JSON.parse(r.value); } catch { out[r.key] = r.value; } });
  return res.json(out);
});
app.put('/settings', authenticate, async (req, res) => {
  try {
    const updates = req.body;
    if (typeof updates !== 'object' || Array.isArray(updates)) return res.status(400).json({ error: 'Cuerpo inválido' });
    for (const [key, value] of Object.entries(updates)) {
      const id = genId(); const created = now();
      await query(`INSERT INTO settings (id, user_id, key, value, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$5)
        ON CONFLICT (user_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`, [id, req.user.id, key, JSON.stringify(value), created]);
    }
    return res.json({ message: 'Ajustes guardados' });
  } catch (err) { return res.status(400).json({ error: err.message }); }
});
app.get('/settings/subscription', authenticate, async (req, res) => {
  const subRows = await query('SELECT * FROM subscriptions WHERE user_id = $1', [req.user.id]);
  const plan = (subRows[0] && subRows[0].plan) || 'free';
  const limits = planLimits(plan);
  const month = new Date().toISOString().slice(0, 7);
  const usageRows = await query('SELECT * FROM usage WHERE user_id = $1 AND month = $2', [req.user.id, month]);
  return res.json({ plan, status: (subRows[0] && subRows[0].status) || 'active', limits, usage: usageRows[0] || { invoices_count: 0, ai_generations_count: 0, automations_count: 0 } });
});
app.post('/settings/subscription/plan', authenticate, async (req, res) => {
  try {
    const plan = planValue(req.body.plan);
    const sub = await query('SELECT id FROM subscriptions WHERE user_id = $1', [req.user.id]);
    if (sub.length) await query('UPDATE subscriptions SET plan = $1, updated_at = $2 WHERE user_id = $3', [plan, now(), req.user.id]);
    else await query(`INSERT INTO subscriptions (id, user_id, plan, status, created_at, updated_at) VALUES ($1,$2,$3,'active',$4,$4)`, [genId(), req.user.id, plan, now()]);
    return res.json({ plan, message: 'Plan actualizado' });
  } catch (err) { return res.status(400).json({ error: err.message }); }
});
app.get('/settings/stripe-config', authenticate, (req, res) => {
  const publishable = process.env.STRIPE_PUBLISHABLE_KEY || '';
  return res.json({ stripe_publishable_key: publishable, configured: !!publishable });
});

function matchConditions(invoice, conditions) {
  if (!conditions || Object.keys(conditions).length === 0) return true;
  if (conditions.status && invoice.status !== conditions.status) return false;
  if (conditions.min_amount !== undefined && invoice.amount < conditions.min_amount) return false;
  if (conditions.max_amount !== undefined && invoice.amount > conditions.max_amount) return false;
  if (conditions.days_overdue_min !== undefined) {
    const due = invoice.due_date ? new Date(invoice.due_date).getTime() : 0;
    const days = due ? Math.max(0, Math.ceil((Date.now() - due) / 86400000)) : 0;
    if (days < conditions.days_overdue_min) return false;
  }
  if (conditions.days_overdue_max !== undefined) {
    const due = invoice.due_date ? new Date(invoice.due_date).getTime() : 0;
    const days = due ? Math.max(0, Math.ceil((Date.now() - due) / 86400000)) : 0;
    if (days > conditions.days_overdue_max) return false;
  }
  return true;
}

async function runDueAutomations() {
  const due = await query("SELECT * FROM automations WHERE is_active = 1 AND next_run_at IS NOT NULL AND next_run_at <= $1", [now()]);
  for (const automation of due) {
    const userId = automation.user_id;
    const conditions = automation.conditions ? (typeof automation.conditions === 'string' ? JSON.parse(automation.conditions) : automation.conditions) : {};
    const invoices = await query('SELECT * FROM invoices WHERE user_id = $1', [userId]);
    const filtered = invoices.filter(inv => matchConditions(inv, conditions));
    const cfg = await getSmtpConfig(userId);
    const from = await getFromAddress(userId);
    let transporter = null;
    if (isSmtpConfigured(cfg)) {
      try { transporter = nodemailer.createTransport({ host: cfg.host, port: parseInt(cfg.port, 10) || 587, secure: cfg.secure === 'true', auth: { user: cfg.user, pass: cfg.pass } }); } catch {}
    }
    for (const invoice of filtered) {
      const clientRows = invoice.client_id ? await query('SELECT * FROM clients WHERE id = $1 AND user_id = $2', [invoice.client_id, userId]) : [];
      const client = clientRows[0] || null;
      const clientName = (client && client.name) || 'Cliente';
      const clientEmail = (client && client.email) || '';
      const message = templateMessage({ type: automation.reminder_type, tone: automation.tone, language: automation.language, invoice, client: { name: clientName, email: clientEmail } });
      const reminderId = genId(); const created = now();
      await query(`INSERT INTO reminders (id, user_id, invoice_id, reminder_type, tone, language, message, ai_generated, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,0,$8)`, [reminderId, userId, invoice.id, automation.reminder_type, automation.tone, automation.language, message, created]);
      let status = 'pending'; let errorMessage = ''; let sentAt = null;
      if (transporter && clientEmail) {
        try { await transporter.sendMail({ from, to: clientEmail, subject: `Recordatorio de factura ${invoice.invoice_number}`, text: message }); status = 'sent'; sentAt = now(); } catch (err) { status = 'failed'; errorMessage = err.message; }
      } else if (!transporter) { status = 'pending'; errorMessage = 'SMTP no configurado'; }
      else if (!clientEmail) { status = 'failed'; errorMessage = 'Cliente sin email'; }
      await query(`INSERT INTO reminder_history (id, user_id, invoice_id, reminder_id, status, channel, sent_at, error_message, created_at) VALUES ($1,$2,$3,$4,$5,'email',$6,$7,$8)`, [genId(), userId, invoice.id, reminderId, status, sentAt, errorMessage, created]);
      await query('UPDATE invoices SET updated_at = $1 WHERE id = $2 AND user_id = $3', [now(), invoice.id, userId]);
    }
    await query('UPDATE automations SET last_run_at = $1, next_run_at = $2, updated_at = $3 WHERE id = $4', [now(), parseCronNext(automation.schedule_cron), now(), automation.id]);
  }
}

function cronAuth(req, res, next) {
  const secret = req.headers['x-cron-secret'] || req.query.secret;
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) return res.status(401).json({ error: 'No autorizado' });
  next();
}

app.post('/automations/run', cronAuth, async (req, res) => {
  try { await runDueAutomations(); return res.json({ message: 'Automatizaciones ejecutadas' }); }
  catch (err) { return res.status(500).json({ error: err.message }); }
});

// ==================== HEALTH ====================
app.get('/api/health', (req, res) => res.json({ status: 'ok', service: 'invoicenudge-ai', time: new Date().toISOString() }));

module.exports = app;
