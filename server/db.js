const path = require('path');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');

const dbPath = path.join(__dirname, '..', 'data', 'invoicenudge.sqlite');
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

function runMigrations() {
  const schema = `
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      name TEXT NOT NULL DEFAULT '',
      role TEXT NOT NULL DEFAULT 'user',
      email_verified INTEGER NOT NULL DEFAULT 0,
      email_verification_token TEXT,
      password_reset_token TEXT,
      password_reset_expires INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
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
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS clients (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL DEFAULT '',
      email TEXT DEFAULT '',
      address TEXT DEFAULT '',
      tax_id TEXT DEFAULT '',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_clients_user ON clients(user_id);

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
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_invoices_user ON invoices(user_id);
    CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices(user_id, status);
    CREATE INDEX IF NOT EXISTS idx_invoices_due ON invoices(due_date);

    CREATE TABLE IF NOT EXISTS reminders (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      invoice_id TEXT NOT NULL,
      reminder_type TEXT NOT NULL DEFAULT 'due',
      tone TEXT NOT NULL DEFAULT 'professional',
      language TEXT DEFAULT 'es',
      message TEXT DEFAULT '',
      ai_generated INTEGER NOT NULL DEFAULT 0,
      sent_at INTEGER,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_reminders_user ON reminders(user_id);
    CREATE INDEX IF NOT EXISTS idx_reminders_invoice ON reminders(invoice_id);

    CREATE TABLE IF NOT EXISTS reminder_history (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      invoice_id TEXT NOT NULL,
      reminder_id TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      channel TEXT DEFAULT 'email',
      sent_at INTEGER,
      error_message TEXT DEFAULT '',
      created_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE CASCADE,
      FOREIGN KEY (reminder_id) REFERENCES reminders(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_reminder_history_user ON reminder_history(user_id);

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
      last_run_at INTEGER,
      next_run_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_automations_user ON automations(user_id);
    CREATE INDEX IF NOT EXISTS idx_automations_active ON automations(user_id, is_active);

    CREATE TABLE IF NOT EXISTS subscriptions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL UNIQUE,
      plan TEXT NOT NULL DEFAULT 'free',
      status TEXT NOT NULL DEFAULT 'active',
      stripe_customer_id TEXT DEFAULT '',
      stripe_subscription_id TEXT DEFAULT '',
      current_period_start INTEGER,
      current_period_end INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS usage (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      month TEXT NOT NULL,
      invoices_count INTEGER NOT NULL DEFAULT 0,
      ai_generations_count INTEGER NOT NULL DEFAULT 0,
      automations_count INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_usage_user_month ON usage(user_id, month);

    CREATE TABLE IF NOT EXISTS settings (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT DEFAULT '{}',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_settings_user_key ON settings(user_id, key);
  `;

  db.exec(schema);

  // Seed default settings for existing users is handled per-request lazily.

  // Ensure a default free subscription row exists for users without one (idempotent).
  const now = Date.now();
  db.prepare(
    `INSERT OR IGNORE INTO subscriptions (id, user_id, plan, status, created_at, updated_at)
     SELECT id, id, 'free', 'active', ?, ? FROM users WHERE id NOT IN (SELECT user_id FROM subscriptions)`
  ).run(now, now);
}

function genId() {
  return require('crypto').randomBytes(16).toString('hex');
}

function now() {
  return Date.now();
}

function hashPassword(password) {
  return bcrypt.hashSync(password, 10);
}

function comparePassword(plain, hash) {
  return bcrypt.compareSync(plain, hash);
}

module.exports = { db, genId, now, hashPassword, comparePassword, runMigrations };
