const express = require('express');
const router = express.Router();
const { db, genId, now } = require('../db');
const { authenticate } = require('../middleware/auth');
const { requiredString, optionalString } = require('../middleware/validation');

function ensureProfile(userId) {
  let profile = db.prepare('SELECT * FROM profiles WHERE user_id = ?').get(userId);
  if (!profile) {
    profile = { id: genId(), user_id: userId, created_at: now(), updated_at: now() };
    db.prepare(
      `INSERT INTO profiles (id, user_id, created_at, updated_at) VALUES (?, ?, ?, ?)`
    ).run(profile.id, userId, now(), now());
  }
  return profile;
}

// Clients
router.get('/', authenticate, (req, res) => {
  const clients = db
    .prepare('SELECT * FROM clients WHERE user_id = ? ORDER BY name COLLATE NOCASE ASC')
    .all(req.user.id);
  return res.json(clients);
});

router.post('/', authenticate, (req, res) => {
  try {
    const name = requiredString(req.body.name, 'name');
    const email = optionalString(req.body.email, 'email');
    const address = optionalString(req.body.address, 'address');
    const taxId = optionalString(req.body.tax_id, 'tax_id');
    const id = genId();
    const created = now();
    db.prepare(
      `INSERT INTO clients (id, user_id, name, email, address, tax_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, req.user.id, name, email, address, taxId, created, created);
    ensureProfile(req.user.id);
    return res.status(201).json({ id, user_id: req.user.id, name, email, address, tax_id: taxId, created_at: created, updated_at: created });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
});

router.get('/:id', authenticate, (req, res) => {
  const client = db
    .prepare('SELECT * FROM clients WHERE id = ? AND user_id = ?')
    .get(req.params.id, req.user.id);
  if (!client) return res.status(404).json({ error: 'Cliente no encontrado' });
  return res.json(client);
});

router.put('/:id', authenticate, (req, res) => {
  try {
    const client = db
      .prepare('SELECT id FROM clients WHERE id = ? AND user_id = ?')
      .get(req.params.id, req.user.id);
    if (!client) return res.status(404).json({ error: 'Cliente no encontrado' });

    const name = optionalString(req.body.name, 'name');
    const email = optionalString(req.body.email, 'email');
    const address = optionalString(req.body.address, 'address');
    const taxId = optionalString(req.body.tax_id, 'tax_id');

    db.prepare(
      `UPDATE clients SET name = ?, email = ?, address = ?, tax_id = ?, updated_at = ? WHERE id = ? AND user_id = ?`
    ).run(name, email, address, taxId, now(), req.params.id, req.user.id);
    return res.json({ message: 'Cliente actualizado' });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
});

router.delete('/:id', authenticate, (req, res) => {
  const client = db
    .prepare('SELECT id FROM clients WHERE id = ? AND user_id = ?')
    .get(req.params.id, req.user.id);
  if (!client) return res.status(404).json({ error: 'Cliente no encontrado' });
  db.prepare('DELETE FROM clients WHERE id = ? AND user_id = ?').run(
    req.params.id,
    req.user.id
  );
  return res.json({ message: 'Cliente eliminado' });
});

module.exports = router;
