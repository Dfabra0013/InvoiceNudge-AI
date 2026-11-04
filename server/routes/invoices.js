const express = require('express');
const router = express.Router();
const { db, genId, now } = require('../db');
const { authenticate } = require('../middleware/auth');
const {
  requiredString,
  optionalString,
  positiveNumber,
  statusValue,
} = require('../middleware/validation');

function ensureProfile(userId) {
  let profile = db.prepare('SELECT * FROM profiles WHERE user_id = ?').get(userId);
  if (!profile) {
    const id = genId();
    const created = now();
    db.prepare(
      `INSERT INTO profiles (id, user_id, created_at, updated_at) VALUES (?, ?, ?, ?)`
    ).run(id, userId, created, created);
    profile = { id, user_id: userId, currency: 'EUR', created_at: created, updated_at: created };
  }
  return profile;
}

function incrementUsage(userId, field) {
  const month = new Date().toISOString().slice(0, 7);
  let row = db.prepare('SELECT * FROM usage WHERE user_id = ? AND month = ?').get(userId, month);
  if (!row) {
    row = { id: genId(), user_id: userId, month, invoices_count: 0, ai_generations_count: 0, automations_count: 0, created_at: now(), updated_at: now() };
    db.prepare(
      `INSERT INTO usage (id, user_id, month, invoices_count, ai_generations_count, automations_count, created_at, updated_at) VALUES (?, ?, ?, 0, 0, 0, ?, ?)`
    ).run(row.id, userId, month, now(), now());
  }
  const updates = { invoices_count: 0, ai_generations_count: 0, automations_count: 0 };
  updates[field] = (row[field] || 0) + 1;
  db.prepare(
    `UPDATE usage SET ${field} = ?, updated_at = ? WHERE id = ?`
  ).run(updates[field], now(), row.id);
}

function checkLimit(userId, field, limit) {
  const month = new Date().toISOString().slice(0, 7);
  const row = db.prepare('SELECT * FROM usage WHERE user_id = ? AND month = ?').get(userId, month);
  const current = row ? (row[field] || 0) : 0;
  if (current >= limit) return false;
  return true;
}

function planLimits(plan) {
  switch (plan) {
    case 'pro': return { invoices: 1000, ai_generations: 500, automations: 20 };
    case 'business': return { invoices: 100000, ai_generations: 5000, automations: 200 };
    case 'free':
    default: return { invoices: 50, ai_generations: 10, automations: 3 };
  }
}

// Invoices
router.get('/', authenticate, (req, res) => {
  const { status, search, sort = 'created_at', order = 'desc', client_id } = req.query;
  let sql = `SELECT i.*, c.name AS client_name, c.email AS client_email FROM invoices i LEFT JOIN clients c ON i.client_id = c.id WHERE i.user_id = ?`;
  const params = [req.user.id];
  if (status) { sql += ` AND i.status = ?`; params.push(status); }
  if (client_id) { sql += ` AND i.client_id = ?`; params.push(client_id); }
  if (search) {
    sql += ` AND (i.invoice_number LIKE ? OR i.description LIKE ? OR c.name LIKE ? OR c.email LIKE ?)`;
    const like = `%${search}%`;
    params.push(like, like, like, like);
  }
  const allowedSort = ['invoice_number', 'status', 'issue_date', 'due_date', 'amount', 'created_at', 'updated_at'];
  const sortCol = allowedSort.includes(sort) ? sort : 'created_at';
  const sortDir = order === 'asc' ? 'ASC' : 'DESC';
  sql += ` ORDER BY i.${sortCol} ${sortDir}`;
  const rows = db.prepare(sql).all(params);
  return res.json(rows);
});

router.get('/stats', authenticate, (req, res) => {
  const userId = req.user.id;
  const total = db.prepare('SELECT COUNT(*) AS c FROM invoices WHERE user_id = ?').get(userId).c;
  const pending = db.prepare("SELECT COUNT(*) AS c FROM invoices WHERE user_id = ? AND status IN ('draft','sent')").get(userId).c;
  const overdue = db.prepare("SELECT COUNT(*) AS c FROM invoices WHERE user_id = ? AND status = 'overdue'").get(userId).c;
  const paid = db.prepare("SELECT COUNT(*) AS c FROM invoices WHERE user_id = ? AND status = 'paid'").get(userId).c;
  const pendingAmount = db.prepare("SELECT COALESCE(SUM(amount),0) AS total FROM invoices WHERE user_id = ? AND status IN ('draft','sent')").get(userId).total;
  const paidAmount = db.prepare("SELECT COALESCE(SUM(amount),0) AS total FROM invoices WHERE user_id = ? AND status = 'paid'").get(userId).total;

  // Monthly evolution (last 6 months)
  const months = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date();
    d.setMonth(d.getMonth() - i);
    months.push(d.toISOString().slice(0, 7));
  }
  const evolution = db.prepare(
    `SELECT strftime('%Y-%m', created_at) AS month, COUNT(*) AS count, COALESCE(SUM(amount),0) AS total FROM invoices WHERE user_id = ? AND created_at >= ? GROUP BY month`
  ).all(userId, new Date(Date.now() - 150 * 24 * 60 * 60 * 1000).toISOString());
  const evMap = {};
  evolution.forEach((r) => { evMap[r.month] = r; });
  const monthly = months.map((m) => ({ month: m, count: (evMap[m] && evMap[m].count) || 0, total: (evMap[m] && evMap[m].total) || 0 }));

  // Recent activity
  const recent = db.prepare(
    `SELECT i.id, i.invoice_number, i.status, i.amount, i.currency, i.created_at, c.name AS client_name FROM invoices i LEFT JOIN clients c ON i.client_id = c.id WHERE i.user_id = ? ORDER BY i.updated_at DESC LIMIT 10`
  ).all(userId);

  return res.json({
    total_invoices: total,
    pending_invoices: pending,
    overdue_invoices: overdue,
    paid_invoices: paid,
    pending_amount: pendingAmount,
    paid_amount: paidAmount,
    monthly_evolution: monthly,
    recent_activity: recent,
  });
});

router.post('/', authenticate, (req, res) => {
  try {
    const profile = ensureProfile(req.user.id);
    const subscription = db.prepare('SELECT plan FROM subscriptions WHERE user_id = ?').get(req.user.id);
    const plan = (subscription && subscription.plan) || 'free';
    const limits = planLimits(plan);
    if (!checkLimit(req.user.id, 'invoices_count', limits.invoices)) {
      return res.status(403).json({ error: 'Límite de facturas alcanzado para tu plan' });
    }

    const clientId = optionalString(req.body.client_id, 'client_id');
    const invoiceNumber = requiredString(req.body.invoice_number, 'invoice_number');
    const status = statusValue(req.body.status);
    const issueDate = optionalString(req.body.issue_date, 'issue_date');
    const dueDate = optionalString(req.body.due_date, 'due_date');
    const amount = positiveNumber(req.body.amount, 'amount');
    const currency = optionalString(req.body.currency, 'currency', { max: 10 }) || profile.currency || 'EUR';
    const description = optionalString(req.body.description, 'description');
    const notes = optionalString(req.body.notes, 'notes', { max: 2000 });

    if (amount < 0) throw new Error('El importe no puede ser negativo');

    const id = genId();
    const created = now();
    db.prepare(
      `INSERT INTO invoices (id, user_id, client_id, invoice_number, status, issue_date, due_date, amount, currency, description, notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, req.user.id, clientId || null, invoiceNumber, status, issueDate, dueDate, amount, currency, description, notes, created, created);

    incrementUsage(req.user.id, 'invoices_count');

    const row = db.prepare('SELECT * FROM invoices WHERE id = ? AND user_id = ?').get(id, req.user.id);
    return res.status(201).json(row);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
});

router.get('/:id', authenticate, (req, res) => {
  const row = db
    .prepare('SELECT * FROM invoices WHERE id = ? AND user_id = ?')
    .get(req.params.id, req.user.id);
  if (!row) return res.status(404).json({ error: 'Factura no encontrada' });
  return res.json(row);
});

router.put('/:id', authenticate, (req, res) => {
  try {
    const existing = db
      .prepare('SELECT id FROM invoices WHERE id = ? AND user_id = ?')
      .get(req.params.id, req.user.id);
    if (!existing) return res.status(404).json({ error: 'Factura no encontrada' });

    const clientId = optionalString(req.body.client_id, 'client_id');
    const invoiceNumber = optionalString(req.body.invoice_number, 'invoice_number');
    const status = req.body.status !== undefined ? statusValue(req.body.status) : undefined;
    const issueDate = optionalString(req.body.issue_date, 'issue_date');
    const dueDate = optionalString(req.body.due_date, 'due_date');
    const amount = req.body.amount !== undefined ? positiveNumber(req.body.amount, 'amount') : undefined;
    const currency = optionalString(req.body.currency, 'currency', { max: 10 });
    const description = optionalString(req.body.description, 'description');
    const notes = optionalString(req.body.notes, 'notes', { max: 2000 });

    if (amount !== undefined && amount < 0) throw new Error('El importe no puede ser negativo');

    const fields = [];
    const values = [];
    const set = (col, val) => { if (val !== undefined) { fields.push(`${col} = ?`); values.push(val); } };
    set('client_id', clientId || null);
    set('invoice_number', invoiceNumber);
    set('status', status);
    set('issue_date', issueDate);
    set('due_date', dueDate);
    set('amount', amount);
    set('currency', currency);
    set('description', description);
    set('notes', notes);
    fields.push('updated_at = ?');
    values.push(now());
    values.push(req.params.id, req.user.id);

    db.prepare(`UPDATE invoices SET ${fields.join(', ')} WHERE id = ? AND user_id = ?`).run(...values);
    return res.json({ message: 'Factura actualizada' });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
});

router.delete('/:id', authenticate, (req, res) => {
  const existing = db
    .prepare('SELECT id FROM invoices WHERE id = ? AND user_id = ?')
    .get(req.params.id, req.user.id);
  if (!existing) return res.status(404).json({ error: 'Factura no encontrada' });
  db.prepare('DELETE FROM invoices WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
  return res.json({ message: 'Factura eliminada' });
});

router.patch('/:id/pay', authenticate, (req, res) => {
  const existing = db
    .prepare('SELECT id FROM invoices WHERE id = ? AND user_id = ?')
    .get(req.params.id, req.user.id);
  if (!existing) return res.status(404).json({ error: 'Factura no encontrada' });
  db.prepare(
    `UPDATE invoices SET status = 'paid', updated_at = ? WHERE id = ? AND user_id = ?`
  ).run(now(), req.params.id, req.user.id);
  return res.json({ message: 'Factura marcada como pagada' });
});

module.exports = router;
