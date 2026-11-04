const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const JWT_EXPIRES = process.env.JWT_EXPIRES || '7d';

function signToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES });
}

function verifyToken(token) {
  return jwt.verify(token, JWT_SECRET);
}

function authenticate(req, res, next) {
  const header = req.headers.authorization || '';
  const parts = header.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer') {
    return res.status(401).json({ error: 'Token de autenticación requerido' });
  }
  try {
    const decoded = verifyToken(parts[1]);
    req.user = { id: decoded.id, email: decoded.email, role: decoded.role };
    return next();
  } catch (err) {
    return res.status(401).json({ error: 'Token inválido o expirado' });
  }
}

function optionalAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const parts = header.split(' ');
  if (parts.length === 2 && parts[0] === 'Bearer') {
    try {
      const decoded = verifyToken(parts[1]);
      req.user = { id: decoded.id, email: decoded.email, role: decoded.role };
    } catch (err) {
      req.user = null;
    }
  } else {
    req.user = null;
  }
  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'No autenticado' });
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'No autorizado' });
    }
    next();
  };
}

module.exports = { signToken, authenticate, optionalAuth, requireRole, JWT_SECRET };
