const express = require('express');
const router = express.Router();
const { db, genId, now } = require('../db');
const { authenticate } = require('../middleware/auth');
const {
  requiredString,
  optionalString,
  reminderTypeValue,
  toneValue,
  jsonField,
} = require('../middleware/validation');

function parseCronNext(cron) {
  // Simple cron: every N hours/days supported: "*/N * * * *" or "0 */N * * *"
  // Fallback: run daily at now + 24h if unparseable.
  const nowMs = Date.now();
  if (!cron) return nowMs + 24 * 60 * 60 * 1000;
  const m = cron.match(/^\*\/\d+\s+\*\s+\*\s+\*\s+\*$/);
  if (m) {
    const n = parseInt(cron.split(/\s+/)[0].replace('*/', ''), 10) || 1;
    return nowMs + n * 60 * 60 * 1000;
  }
  const m2 = cron.match(/^0\s+\*\/\d+\s+\*\s+\*\s+\*$/);
  if (m2) {
    const n = parseInt(cron.split(/\s+/)[1].replace('*/', ''), 10) || 24;
    return nowMs + n * 60 * 60 * 1000;
  }
  return nowMs + 24 * 60 * 60 * 1000;
}

router.get('/', authenticate, (req, res) => {
  const rows = db
    .prepare('SELECT * FROM automations WHERE user_id = ? ORDER BY created_at DESC')
    .all(req.user.id);
  return res.json(rows);
});

router.post('/', authenticate, (req, res) => {
  try {
    const subscription = db.prepare('SELECT plan FROM subscriptions WHERE user_id = ?').get(req.user.id);
    const plan = (subscription && subscription.plan) || 'free';
    const limits = { free: 3, pro: 20, business: 200 }[plan] || 3;
    const count = db.prepare('SELECT COUNT(*) AS c FROM automations WHERE user_id = ? AND is_active = 1').get(req.user.id).c;
    if (count >= limits) {
      return res.status(403).json({ error: 'Límite de automatizaciones alcanzado para tu plan' });
    }

    const name = requiredString(req.body.name, 'name');
    const description = optionalString(req.body.description, 'description');
    const isActive = req.body.is_active !== undefined ? (req.body.is_active ? 1 : 0) : 0;
    const reminderType = reminderTypeValue(req.body.reminder_type || 'due');
    const tone = toneValue(req.body.tone || 'professional');
    const language = optionalString(req.body.language, 'language', { max: 10 }) || 'es';
    const scheduleCron = optionalString(req.body.schedule_cron, 'schedule_cron', { max: 60 }) || '0 9 * * *';
    const conditions = jsonField(req.body.conditions, 'conditions');

    const id = genId();
    const created = now();
    const nextRun = parseCronNext(scheduleCron);
    db.prepare(
      `INSERT INTO automations (id, user_id, name, description, is_active, reminder_type, tone, language, schedule_cron, conditions, last_run_at, next_run_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`
    ).run(id, req.user.id, name, description, isActive, reminderType, tone, language, scheduleCron, JSON.stringify(conditions), nextRun, created, created);

    return res.status(201).json({ id, user_id: req.user.id, name, description, is_active: isActive === 1, reminder_type: reminderType, tone, language, schedule_cron: scheduleCron, conditions, next_run_at: nextRun, created_at: created, updated_at: created });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
});

router.get('/:id', authenticate, (req, res) => {
  const row = db.prepare('SELECT * FROM automations WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!row) return res.status(404).json({ error: 'Automatización no encontrada' });
  row.conditions = row.conditions ? JSON.parse(row.conditions) : {};
  return res.json(row);
});

router.put('/:id', authenticate, (req, res) => {
  try {
    const existing = db.prepare('SELECT id FROM automations WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
    if (!existing) return res.status(404).json({ error: 'Automatización no encontrada' });

    const fields = [];
    const values = [];
    const set = (col, val) => { if (val !== undefined) { fields.push(`${col} = ?`); values.push(val); } };
    set('name', optionalString(req.body.name, 'name'));
    set('description', optionalString(req.body.description, 'description'));
    if (req.body.is_active !== undefined) set('is_active', req.body.is_active ? 1 : 0);
    if (req.body.reminder_type !== undefined) set('reminder_type', reminderTypeValue(req.body.reminder_type));
    if (req.body.tone !== undefined) set('tone', toneValue(req.body.tone));
    if (req.body.language !== undefined) set('language', optionalString(req.body.language, 'language', { max: 10 }));
    if (req.body.schedule_cron !== undefined) set('schedule_cron', optionalString(req.body.schedule_cron, 'schedule_cron', { max: 60 }));
    if (req.body.conditions !== undefined) set('conditions', JSON.stringify(jsonField(req.body.conditions, 'conditions')));

    if (fields.length === 0) return res.status(400).json({ error: 'Nada que actualizar' });
    fields.push('updated_at = ?');
    values.push(now(), req.params.id, req.user.id);
    db.prepare(`UPDATE automations SET ${fields.join(', ')} WHERE id = ? AND user_id = ?`).run(...values);
    return res.json({ message: 'Automatización actualizada' });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
});

router.delete('/:id', authenticate, (req, res) => {
  const existing = db.prepare('SELECT id FROM automations WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!existing) return res.status(404).json({ error: 'Automatización no encontrada' });
  db.prepare('DELETE FROM automations WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
  return res.json({ message: 'Automatización eliminada' });
});

router.post('/:id/toggle', authenticate, (req, res) => {
  const existing = db.prepare('SELECT id, is_active FROM automations WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!existing) return res.status(404).json({ error: 'Automatización no encontrada' });
  const next = existing.is_active === 1 ? 0 : 1;
  const nextRun = next === 1 ? parseCronNext(existing.schedule_cron) : null;
  db.prepare('UPDATE automations SET is_active = ?, next_run_at = ?, updated_at = ? WHERE id = ? AND user_id = ?').run(next, nextRun, now(), req.params.id, req.user.id);
  return res.json({ is_active: next === 1, next_run_at: nextRun });
});

module.exports = router;
