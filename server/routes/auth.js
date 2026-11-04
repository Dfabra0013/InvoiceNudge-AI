const express = require('express');
const router = express.Router();
const { db, genId, now, hashPassword, comparePassword } = require('../db');
const { authenticate } = require('../middleware/auth');
const {
  requiredString,
  requiredEmail,
  optionalString,
} = require('../middleware/validation');

function sendVerificationEmail(email, token) {
  // Placeholder: real email delivery is wired through the email module when SMTP is configured.
  console.log(`[verify-email] ${email} token=${token}`);
}

router.post('/register', async (req, res) => {
  try {
    const email = requiredEmail(req.body.email, 'email');
    const password = requiredString(req.body.password, 'password', { min: 6, max: 128 });
    const name = optionalString(req.body.name, 'name', { max: 100 });

    const existing = db
      .prepare('SELECT id FROM users WHERE email = ?')
      .get(email);
    if (existing) {
      return res.status(409).json({ error: 'El correo electrónico ya está registrado' });
    }

    const id = genId();
    const created = now();
    const passwordHash = hashPassword(password);
    const verificationToken = genId();

    db.prepare(
      `INSERT INTO users (id, email, password_hash, name, email_verified, email_verification_token, created_at, updated_at)
       VALUES (?, ?, ?, ?, 0, ?, ?, ?)`
    ).run(id, email, passwordHash, name, verificationToken, created, created);

    db.prepare(
      `INSERT INTO profiles (id, user_id, created_at, updated_at) VALUES (?, ?, ?, ?)`
    ).run(genId(), id, created, created);

    db.prepare(
      `INSERT INTO subscriptions (id, user_id, plan, status, created_at, updated_at)
       VALUES (?, ?, 'free', 'active', ?, ?)`
    ).run(genId(), id, created, created);

    sendVerificationEmail(email, verificationToken);

    const user = { id, email, name, email_verified: 0 };
    const token = require('../middleware/auth').signToken({ id, email, role: 'user' });

    return res.status(201).json({
      message: 'Registro exitoso. Verifica tu correo electrónico.',
      user,
      token,
    });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
});

router.post('/login', async (req, res) => {
  try {
    const email = requiredEmail(req.body.email, 'email');
    const password = requiredString(req.body.password, 'password');

    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (!user || !(await comparePassword(password, user.password_hash))) {
      return res.status(401).json({ error: 'Credenciales inválidas' });
    }

    db.prepare('UPDATE users SET updated_at = ? WHERE id = ?').run(now(), user.id);

    const token = require('../middleware/auth').signToken({
      id: user.id,
      email: user.email,
      role: user.role,
    });

    return res.json({
      message: 'Inicio de sesión exitoso',
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        email_verified: !!user.email_verified,
      },
      token,
    });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
});

router.post('/logout', authenticate, (req, res) => {
  return res.json({ message: 'Sesión cerrada. Elimina el token del cliente.' });
});

router.get('/verify-email', (req, res) => {
  const { token } = req.query;
  if (!token) {
    return res.status(400).json({ error: 'Token de verificación requerido' });
  }
  const user = db
    .prepare('SELECT id FROM users WHERE email_verification_token = ?')
    .get(token);
  if (!user) {
    return res.status(400).json({ error: 'Token inválido' });
  }
  db.prepare(
    `UPDATE users SET email_verified = 1, email_verification_token = NULL, updated_at = ? WHERE id = ?`
  ).run(now(), user.id);
  return res.json({ message: 'Correo verificado exitosamente' });
});

router.post('/forgot-password', async (req, res) => {
  try {
    const email = requiredEmail(req.body.email, 'email');
    const user = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
    if (!user) {
      // No revelar si el email existe
      return res.json({ message: 'Si el correo existe, recibirás instrucciones de restablecimiento' });
    }
    const resetToken = genId();
    const expires = now() + 1000 * 60 * 60; // 1 hora
    db.prepare(
      `UPDATE users SET password_reset_token = ?, password_reset_expires = ?, updated_at = ? WHERE id = ?`
    ).run(resetToken, expires, now(), user.id);
    console.log(`[reset-password] ${email} token=${resetToken}`);
    return res.json({ message: 'Si el correo existe, recibirás instrucciones de restablecimiento' });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
});

router.post('/reset-password', async (req, res) => {
  try {
    const token = requiredString(req.body.token, 'token');
    const password = requiredString(req.body.password, 'password', { min: 6, max: 128 });

    const user = db
      .prepare(
        'SELECT id FROM users WHERE password_reset_token = ? AND password_reset_expires > ?'
      )
      .get(token, now());
    if (!user) {
      return res.status(400).json({ error: 'Token inválido o expirado' });
    }

    db.prepare(
      `UPDATE users SET password_hash = ?, password_reset_token = NULL, password_reset_expires = NULL, updated_at = ? WHERE id = ?`
    ).run(hashPassword(password), now(), user.id);

    return res.json({ message: 'Contraseña restablecida exitosamente' });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
});

router.get('/profile', authenticate, (req, res) => {
  const user = db
    .prepare('SELECT id, email, name, role, email_verified, created_at FROM users WHERE id = ?')
    .get(req.user.id);
  if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });
  const profile = db.prepare('SELECT * FROM profiles WHERE user_id = ?').get(req.user.id);
  const subscription = db
    .prepare('SELECT plan, status FROM subscriptions WHERE user_id = ?')
    .get(req.user.id);
  return res.json({ user: { ...user, profile, subscription } });
});

router.put('/profile', authenticate, (req, res) => {
  try {
    const name = optionalString(req.body.name, 'name', { max: 100 });
    db.prepare('UPDATE users SET name = ?, updated_at = ? WHERE id = ?').run(
      name,
      now(),
      req.user.id
    );
    return res.json({ message: 'Perfil actualizado' });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
});

module.exports = router;
