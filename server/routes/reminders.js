const express = require('express');
const router = express.Router();
const { db, genId, now } = require('../db');
const { authenticate } = require('../middleware/auth');
const { requiredString, optionalString, reminderTypeValue, toneValue } = require('../middleware/validation');

const AI_PROVIDER = process.env.AI_PROVIDER || 'none'; // 'openrouter' | 'none'
const AI_API_KEY = process.env.AI_API_KEY || '';
const AI_BASE_URL = process.env.AI_BASE_URL || process.env.KILO_OPENROUTER_BASE || 'https://openrouter.ai/api/v1';
const AI_MODEL = process.env.AI_MODEL || 'openai/gpt-4o-mini';

const REMINDER_TYPES = {
  before_due: { key: 'before_due', label: 'Recordatorio previo al vencimiento' },
  due: { key: 'due', label: 'Recordatorio de vencimiento' },
  first_overdue: { key: 'first_overdue', label: 'Primer aviso de retraso' },
  second_overdue: { key: 'second_overdue', label: 'Segundo aviso' },
  final_overdue: { key: 'final_overdue', label: 'Último aviso' },
};

const TONES = {
  friendly: { key: 'friendly', label: 'Cercano / Friendly' },
  professional: { key: 'professional', label: 'Profesional / Professional' },
  firm: { key: 'firm', label: 'Firme / Firm' },
};

function templateMessage({ type, tone, language, invoice, client }) {
  const es = {
    before_due: {
      friendly: `Hola ${client.name}, te recordamos que la factura ${invoice.invoice_number} (${invoice.amount} ${invoice.currency}) vence el ${invoice.due_date}. Gracias por tu atención.`,
      professional: `Estimado ${client.name}, le informamos que la factura ${invoice.invoice_number} por un importe de ${invoice.amount} ${invoice.currency} vence el ${invoice.due_date}. Quedamos a la espera de su confirmación.`,
      firm: `${client.name}, la factura ${invoice.invoice_number} (${invoice.amount} ${invoice.currency}) vence el ${invoice.due_date}. Rogamos su abono inmediato.`,
    },
    due: {
      friendly: `Hola ${client.name}, hoy vence la factura ${invoice.invoice_number} por ${invoice.amount} ${invoice.currency}. ¿Puedes confirmar el pago?`,
      professional: `Estimado ${client.name}, la factura ${invoice.invoice_number} por ${invoice.amount} ${invoice.currency} vence hoy. Le rogamos gestione el pago a la mayor brevedad.`,
      firm: `${client.name}, la factura ${invoice.invoice_number} (${invoice.amount} ${invoice.currency}) vence hoy. Requerimos el pago inmediato.`,
    },
    first_overdue: {
      friendly: `Hola ${client.name}, la factura ${invoice.invoice_number} (${invoice.amount} ${invoice.currency}) tiene ${Math.max(0, Math.ceil((Date.now() - new Date(invoice.due_date).getTime()) / 86400000))} día(s) de retraso. ¿Hay algún problema?`,
      professional: `Estimado ${client.name}, la factura ${invoice.invoice_number} por ${invoice.amount} ${invoice.currency} está vencida desde el ${invoice.due_date}. Le solicitamos regularizar la situación.`,
      firm: `${client.name}, la factura ${invoice.invoice_number} (${invoice.amount} ${invoice.currency}) está vencida. Exigimos el pago inmediato.`,
    },
    second_overdue: {
      friendly: `Hola ${client.name}, seguimos esperando el pago de la factura ${invoice.invoice_number} (${invoice.amount} ${invoice.currency}). ¿Podrías ponerte al día?`,
      professional: `Estimado ${client.name}, la factura ${invoice.invoice_number} por ${invoice.amount} ${invoice.currency} permanece impagada. Le requerimos formalmente que abone la cantidad pendiente.`,
      firm: `${client.name}, la factura ${invoice.invoice_number} (${invoice.amount} ${invoice.currency}) sigue sin pagarse. Último requerimiento antes de acciones legales.`,
    },
    final_overdue: {
      friendly: `Hola ${client.name}, la factura ${invoice.invoice_number} (${invoice.amount} ${invoice.currency}) está muy retrasada. Contáctanos para solucionarlo.`,
      professional: `Estimado ${client.name}, la factura ${invoice.invoice_number} por ${invoice.amount} ${invoice.currency} está gravemente vencida. Esta es nuestra notificación final antes de iniciar gestiones de cobro.`,
      firm: `${client.name}, la factura ${invoice.invoice_number} (${invoice.amount} ${invoice.currency}) está vencida. Procederemos a acciones legales si no se abona de inmediato.`,
    },
  };

  const lang = language === 'es' ? es : {};
  const byTone = lang[type];
  if (!byTone) return `Recordatorio para ${client.name}: factura ${invoice.invoice_number} por ${invoice.amount} ${invoice.currency}.`;
  return byTone[tone] || byTone.professional;
}

async function callAI(prompt) {
  if (AI_PROVIDER !== 'openrouter' || !AI_API_KEY) {
    return null;
  }
  try {
    const res = await globalThis.fetch(`${AI_BASE_URL.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${AI_API_KEY}`,
      },
      body: JSON.stringify({
        model: AI_MODEL,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.7,
        max_tokens: 600,
      }),
    });
    if (!res.ok) throw new Error(`Proveedor IA respondió ${res.status}`);
    const data = await res.json();
    return (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || null;
  } catch (err) {
    console.error('[ai-provider] error:', err.message);
    return null;
  }
}

router.get('/types', authenticate, (req, res) => {
  return res.json({ types: Object.values(REMINDER_TYPES), tones: Object.values(TONES) });
});

router.post('/generate', authenticate, async (req, res) => {
  try {
    const subscription = db.prepare('SELECT plan FROM subscriptions WHERE user_id = ?').get(req.user.id);
    const plan = (subscription && subscription.plan) || 'free';
    const limits = { free: 10, pro: 500, business: 5000 }[plan] || 10;
    const month = new Date().toISOString().slice(0, 7);
    const usage = db.prepare('SELECT * FROM usage WHERE user_id = ? AND month = ?').get(req.user.id, month);
    const current = usage ? (usage.ai_generations_count || 0) : 0;
    if (current >= limits) {
      return res.status(403).json({ error: 'Límite de generaciones IA alcanzado para tu plan' });
    }

    const invoiceId = requiredString(req.body.invoice_id, 'invoice_id');
    const type = reminderTypeValue(req.body.reminder_type || 'due');
    const tone = toneValue(req.body.tone || 'professional');
    const language = optionalString(req.body.language, 'language', { max: 10 }) || 'es';

    const invoice = db.prepare('SELECT * FROM invoices WHERE id = ? AND user_id = ?').get(invoiceId, req.user.id);
    if (!invoice) return res.status(404).json({ error: 'Factura no encontrada' });
    const client = invoice.client_id
      ? db.prepare('SELECT * FROM clients WHERE id = ? AND user_id = ?').get(invoice.client_id, req.user.id)
      : null;
    const clientName = (client && client.name) || 'Cliente';
    const clientEmail = (client && client.email) || '';

    const daysOverdue = invoice.due_date
      ? Math.max(0, Math.ceil((Date.now() - new Date(invoice.due_date).getTime()) / 86400000))
      : 0;

    const prompt = `Eres un asistente especializado en cobranza profesional. Redacta un recordatorio de pago en idioma "${language}" con tono "${tone}" para el siguiente recordatorio: ${type}.

Datos:
- Cliente: ${clientName} (${clientEmail})
- Factura: ${invoice.invoice_number}
- Importe: ${invoice.amount} ${invoice.currency}
- Emisión: ${invoice.issue_date}
- Vencimiento: ${invoice.due_date}
- Días de retraso: ${daysOverdue}
- Descripción: ${invoice.description}
- Notas: ${invoice.notes}

Instrucciones: Escribe un mensaje claro, directo y listo para enviar por correo. No incluyas saludo de firma genérica, solo el cuerpo del mensaje. Máximo 180 palabras.`;

    let message = null;
    let aiGenerated = 0;
    let providerUsed = 'template';

    if (AI_PROVIDER === 'openrouter' && AI_API_KEY) {
      const ai = await callAI(prompt);
      if (ai) {
        message = ai.trim();
        aiGenerated = 1;
        providerUsed = 'openrouter';
      }
    }

    if (!message) {
      message = templateMessage({ type, tone, language, invoice, client: { name: clientName, email: clientEmail } });
      providerUsed = 'template';
    }

    const id = genId();
    const created = now();
    db.prepare(
      `INSERT INTO reminders (id, user_id, invoice_id, reminder_type, tone, language, message, ai_generated, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, req.user.id, invoiceId, type, tone, language, message, aiGenerated, created);

    db.prepare(
      `INSERT INTO usage (id, user_id, month, invoices_count, ai_generations_count, automations_count, created_at, updated_at)
       VALUES (?, ?, ?, 0, 1, 0, ?, ?)
       ON CONFLICT(user_id, month) DO UPDATE SET ai_generations_count = ai_generations_count + 1, updated_at = excluded.updated_at`
    ).run(genId(), req.user.id, month, now(), now());

    return res.json({
      id,
      message,
      type,
      tone,
      language,
      ai_generated: aiGenerated === 1,
      provider: providerUsed,
      ai_available: AI_PROVIDER === 'openrouter' && !!AI_API_KEY,
    });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
});

router.get('/', authenticate, (req, res) => {
  const { invoice_id } = req.query;
  let sql = `SELECT r.*, i.invoice_number FROM reminders r LEFT JOIN invoices i ON r.invoice_id = i.id WHERE r.user_id = ?`;
  const params = [req.user.id];
  if (invoice_id) { sql += ` AND r.invoice_id = ?`; params.push(invoice_id); }
  sql += ` ORDER BY r.created_at DESC`;
  const rows = db.prepare(sql).all(params);
  return res.json(rows);
});

router.get('/:id', authenticate, (req, res) => {
  const row = db.prepare('SELECT * FROM reminders WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!row) return res.status(404).json({ error: 'Recordatorio no encontrado' });
  return res.json(row);
});

router.put('/:id', authenticate, (req, res) => {
  try {
    const existing = db.prepare('SELECT id FROM reminders WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
    if (!existing) return res.status(404).json({ error: 'Recordatorio no encontrado' });
    const message = requiredString(req.body.message, 'message');
    db.prepare('UPDATE reminders SET message = ?, updated_at = ? WHERE id = ? AND user_id = ?').run(message, now(), req.params.id, req.user.id);
    return res.json({ message: 'Recordatorio actualizado' });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
});

router.delete('/:id', authenticate, (req, res) => {
  const existing = db.prepare('SELECT id FROM reminders WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!existing) return res.status(404).json({ error: 'Recordatorio no encontrado' });
  db.prepare('DELETE FROM reminders WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
  return res.json({ message: 'Recordatorio eliminado' });
});

module.exports = router;
