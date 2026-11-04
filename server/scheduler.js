const { db, now } = require('./db');
const nodemailer = require('nodemailer');
const { templateMessage } = require('./routes/reminders');
const { isSmtpConfigured, getSmtpConfig, getFromAddress } = require('./routes/email');

const REMINDER_TYPES = {
  before_due: { key: 'before_due', label: 'Recordatorio previo al vencimiento' },
  due: { key: 'due', label: 'Recordatorio de vencimiento' },
  first_overdue: { key: 'first_overdue', label: 'Primer aviso de retraso' },
  second_overdue: { key: 'second_overdue', label: 'Segundo aviso' },
  final_overdue: { key: 'final_overdue', label: 'Último aviso' },
};

const TONES = { friendly: 'friendly', professional: 'professional', firm: 'firm' };

function parseCronNext(cron) {
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

function buildTransporter(userId) {
  const cfg = getSmtpConfig(userId);
  if (!cfg.host || !cfg.user || !cfg.pass) return null;
  return nodemailer.createTransport({
    host: cfg.host,
    port: parseInt(cfg.port, 10) || 587,
    secure: cfg.secure === 'true',
    auth: { user: cfg.user, pass: cfg.pass },
  });
}

function genId() {
  return require('crypto').randomBytes(16).toString('hex');
}

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
  const due = db
    .prepare("SELECT * FROM automations WHERE is_active = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?")
    .all(now());

  for (const automation of due) {
    const userId = automation.user_id;
    const conditions = automation.conditions ? JSON.parse(automation.conditions) : {};
    const invoices = db
      .prepare('SELECT * FROM invoices WHERE user_id = ?')
      .all(userId)
      .filter((inv) => matchConditions(inv, conditions));

    const transporter = buildTransporter(userId);
    const from = getFromAddress(userId);

    for (const invoice of invoices) {
      const client = invoice.client_id
        ? db.prepare('SELECT * FROM clients WHERE id = ? AND user_id = ?').get(invoice.client_id, userId)
        : null;
      const clientName = (client && client.name) || 'Cliente';
      const clientEmail = (client && client.email) || '';

      const message = templateMessage({
        type: automation.reminder_type,
        tone: automation.tone,
        language: automation.language,
        invoice,
        client: { name: clientName, email: clientEmail },
      });

      const reminderId = genId();
      const created = now();
      db.prepare(
        `INSERT INTO reminders (id, user_id, invoice_id, reminder_type, tone, language, message, ai_generated, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`
      ).run(reminderId, userId, invoice.id, automation.reminder_type, automation.tone, automation.language, message, created);

      let status = 'pending';
      let errorMessage = '';
      let sentAt = null;

      if (transporter && clientEmail) {
        try {
          await transporter.sendMail({
            from,
            to: clientEmail,
            subject: `Recordatorio de factura ${invoice.invoice_number}`,
            text: message,
          });
          status = 'sent';
          sentAt = now();
        } catch (err) {
          status = 'failed';
          errorMessage = err.message;
        }
      } else if (!transporter) {
        status = 'pending';
        errorMessage = 'SMTP no configurado';
      } else if (!clientEmail) {
        status = 'failed';
        errorMessage = 'Cliente sin email';
      }

      db.prepare(
        `INSERT INTO reminder_history (id, user_id, invoice_id, reminder_id, status, channel, sent_at, error_message, created_at)
         VALUES (?, ?, ?, ?, ?, 'email', ?, ?, ?)`
      ).run(genId(), userId, invoice.id, reminderId, status, sentAt, errorMessage, created);

      db.prepare('UPDATE invoices SET updated_at = ? WHERE id = ? AND user_id = ?').run(now(), invoice.id, userId);
    }

    db.prepare(
      'UPDATE automations SET last_run_at = ?, next_run_at = ?, updated_at = ? WHERE id = ?'
    ).run(now(), parseCronNext(automation.schedule_cron), now(), automation.id);
  }
}

function startScheduler(intervalMs = 60000) {
  setInterval(() => {
    try { runDueAutomations(); } catch (err) { console.error('[scheduler] error:', err.message); }
  }, intervalMs);
  runDueAutomations(); // run once on start
}

module.exports = { startScheduler, runDueAutomations };
