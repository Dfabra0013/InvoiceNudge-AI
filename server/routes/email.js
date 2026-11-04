const express = require('express');
const router = express.Router();
const nodemailer = require('nodemailer');
const { db, genId, now } = require('../db');
const { authenticate } = require('../middleware/auth');
const { optionalString } = require('../middleware/validation');

function getSmtpConfig(userId) {
  const rows = db.prepare(`SELECT key, value FROM settings WHERE user_id = ? AND key LIKE 'smtp_%'`).all(userId);
  const cfg = {};
  rows.forEach((r) => {
    try { cfg[r.key.replace('smtp_', '')] = JSON.parse(r.value); } catch { cfg[r.key.replace('smtp_', '')] = r.value; }
  });
  return cfg;
}

function isSmtpConfigured(userId) {
  const cfg = getSmtpConfig(userId);
  return !!(cfg.host && cfg.user && cfg.pass);
}

function getFromAddress(userId) {
  const row = db.prepare("SELECT value FROM settings WHERE user_id = ? AND key = 'email_from'").get(userId);
  if (!row) return null;
  try { return JSON.parse(row.value).address || ''; } catch { return row.value || ''; }
}

router.post('/configure', authenticate, (req, res) => {
  try {
    const host = optionalString(req.body.host, 'host');
    const port = optionalString(req.body.port, 'port');
    const user = optionalString(req.body.user, 'user');
    const pass = optionalString(req.body.pass, 'pass');
    const from = optionalString(req.body.from, 'from');

    const setSetting = (key, value) => {
      const id = genId();
      const created = now();
      db.prepare(
        `INSERT INTO settings (id, user_id, key, value, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
      ).run(id, req.user.id, key, JSON.stringify(value), created, created);
    };

    setSetting('smtp_host', host);
    setSetting('smtp_port', port);
    setSetting('smtp_user', user);
    setSetting('smtp_pass', pass);
    setSetting('email_from', { address: from });

    return res.json({ message: 'Configuración de correo guardada (solo en el backend)' });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
});

router.get('/configure', authenticate, (req, res) => {
  const cfg = getSmtpConfig(req.user.id);
  const from = getFromAddress(req.user.id);
  return res.json({
    configured: isSmtpConfigured(req.user.id),
    host: cfg.host || '',
    port: cfg.port || '',
    user: cfg.user || '',
    from: from || '',
  });
});

router.get('/history', authenticate, (req, res) => {
  const { invoice_id } = req.query;
  let sql = `SELECT rh.*, i.invoice_number FROM reminder_history rh LEFT JOIN invoices i ON rh.invoice_id = i.id WHERE rh.user_id = ?`;
  const params = [req.user.id];
  if (invoice_id) { sql += ` AND rh.invoice_id = ?`; params.push(invoice_id); }
  sql += ` ORDER BY rh.created_at DESC`;
  const rows = db.prepare(sql).all(params);
  return res.json(rows);
});

router.post('/send-test', authenticate, async (req, res) => {
  if (!isSmtpConfigured(req.user.id)) {
    return res.status(400).json({ error: 'SMTP no configurado. Configúralo en Ajustes.' });
  }
  const to = optionalString(req.body.to, 'to');
  if (!to) return res.status(400).json({ error: 'Destinatario requerido' });

  const cfg = getSmtpConfig(req.user.id);
  let transporter;
  try {
    transporter = nodemailer.createTransport({
      host: cfg.host,
      port: parseInt(cfg.port, 10) || 587,
      secure: cfg.secure === 'true',
      auth: { user: cfg.user, pass: cfg.pass },
    });
    await transporter.verify();
  } catch (err) {
    return res.status(500).json({ error: `No se pudo conectar con el servidor SMTP: ${err.message}` });
  }

  try {
    const from = getFromAddress(req.user.id) || cfg.user;
    await transporter.sendMail({
      from,
      to,
      subject: 'Prueba de correo - InvoiceNudge AI',
      text: 'Este es un mensaje de prueba de InvoiceNudge AI. Si lo recibes, la integración de correo funciona.',
    });
    return res.json({ message: 'Correo de prueba enviado' });
  } catch (err) {
    return res.status(500).json({ error: `Error al enviar: ${err.message}` });
  }
});

module.exports = { router, isSmtpConfigured, getSmtpConfig, getFromAddress };
