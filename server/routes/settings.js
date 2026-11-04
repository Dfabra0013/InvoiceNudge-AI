const express = require('express');
const router = express.Router();
const { db, genId, now } = require('../db');
const { authenticate } = require('../middleware/auth');
const { optionalString, planValue, jsonField } = require('../middleware/validation');

const PLAN_LIMITS = {
  free: { invoices: 50, ai_generations: 10, automations: 3 },
  pro: { invoices: 1000, ai_generations: 500, automations: 20 },
  business: { invoices: 100000, ai_generations: 5000, automations: 200 },
};

router.get('/settings', authenticate, (req, res) => {
  const rows = db.prepare('SELECT key, value FROM settings WHERE user_id = ?').all(req.user.id);
  const out = {};
  rows.forEach((r) => {
    try { out[r.key] = JSON.parse(r.value); } catch { out[r.key] = r.value; }
  });
  return res.json(out);
});

router.put('/settings', authenticate, (req, res) => {
  try {
    const updates = req.body;
    if (typeof updates !== 'object' || Array.isArray(updates)) {
      return res.status(400).json({ error: 'Cuerpo inválido' });
    }
    Object.entries(updates).forEach(([key, value]) => {
      const id = genId();
      const created = now();
      db.prepare(
        `INSERT INTO settings (id, user_id, key, value, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
      ).run(id, req.user.id, key, JSON.stringify(value), created, created);
    });
    return res.json({ message: 'Ajustes guardados' });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
});

router.get('/subscription', authenticate, (req, res) => {
  const sub = db.prepare('SELECT * FROM subscriptions WHERE user_id = ?').get(req.user.id);
  const plan = (sub && sub.plan) || 'free';
  const limits = PLAN_LIMITS[plan] || PLAN_LIMITS.free;
  const month = new Date().toISOString().slice(0, 7);
  const usage = db.prepare('SELECT * FROM usage WHERE user_id = ? AND month = ?').get(req.user.id, month);
  return res.json({
    plan,
    status: (sub && sub.status) || 'active',
    limits,
    usage: usage || { invoices_count: 0, ai_generations_count: 0, automations_count: 0 },
  });
});

router.post('/subscription/plan', authenticate, (req, res) => {
  try {
    const plan = planValue(req.body.plan);
    const sub = db.prepare('SELECT id FROM subscriptions WHERE user_id = ?').get(req.user.id);
    if (sub) {
      db.prepare('UPDATE subscriptions SET plan = ?, updated_at = ? WHERE user_id = ?').run(plan, now(), req.user.id);
    } else {
      db.prepare(
        `INSERT INTO subscriptions (id, user_id, plan, status, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, ?)`
      ).run(genId(), req.user.id, plan, now(), now());
    }
    return res.json({ plan, message: 'Plan actualizado' });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
});

router.get('/stripe-config', authenticate, (req, res) => {
  const publishable = process.env.STRIPE_PUBLISHABLE_KEY || '';
  return res.json({ stripe_publishable_key: publishable, configured: !!publishable });
});

module.exports = router;
