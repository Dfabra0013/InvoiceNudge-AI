require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const { db, runMigrations } = require('./db');
const { startScheduler } = require('./scheduler');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '1mb' }));

const apiLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 300, message: { error: 'Demasiadas solicitudes, inténtalo más tarde' } });
app.use('/api/', apiLimiter);

// Routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/clients', require('./routes/clients'));
app.use('/api/invoices', require('./routes/invoices'));
app.use('/api/reminders', require('./routes/reminders'));
app.use('/api/automations', require('./routes/automations'));
app.use('/api/email', require('./routes/email').router);
app.use('/api/settings', require('./routes/settings'));

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', service: 'invoicenudge-ai', time: new Date().toISOString() });
});

// Serve frontend
const publicDir = path.join(__dirname, '..', 'client', 'public');
app.use(express.static(publicDir));

// SPA fallback: any non-API route returns index.html
app.use((req, res, next) => {
  if (req.path.startsWith('/api')) return res.status(404).json({ error: 'Ruta no encontrada' });
  res.sendFile(path.join(publicDir, 'index.html'));
});

// Initialize DB + start
runMigrations();
startScheduler(parseInt(process.env.SCHEDULER_INTERVAL_MS, 10) || 60000);

app.listen(PORT, () => {
  console.log(`InvoiceNudge AI backend listening on http://localhost:${PORT}`);
});

module.exports = app;
