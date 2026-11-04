function requiredString(val, name, { min = 1, max = 255, allowEmpty = false } = {}) {
  if (val === undefined || val === null) {
    throw new Error(`${name} es requerido`);
  }
  const s = String(val);
  if (!allowEmpty && s.length < min) {
    throw new Error(`${name} es requerido`);
  }
  if (s.length > max) {
    throw new Error(`${name} excede ${max} caracteres`);
  }
  return s;
}

function requiredEmail(val, name) {
  const s = requiredString(val, name).trim();
  const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!re.test(s)) throw new Error(`${name} inválido`);
  return s;
}

function positiveNumber(val, name) {
  const n = Number(val);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${name} debe ser un número válido`);
  return n;
}

function optionalString(val, name, { max = 255 } = {}) {
  if (val === undefined || val === null || val === '') return '';
  const s = String(val);
  if (s.length > max) throw new Error(`${name} excede ${max} caracteres`);
  return s;
}

function statusValue(val) {
  const s = optionalString(val, 'status');
  const allowed = ['draft', 'sent', 'paid', 'overdue', 'cancelled'];
  if (!allowed.includes(s)) throw new Error('Estado de factura inválido');
  return s;
}

function reminderTypeValue(val) {
  const s = optionalString(val, 'reminder_type');
  const allowed = ['before_due', 'due', 'first_overdue', 'second_overdue', 'final_overdue'];
  if (!allowed.includes(s)) throw new Error('Tipo de recordatorio inválido');
  return s;
}

function toneValue(val) {
  const s = optionalString(val, 'tone');
  const allowed = ['friendly', 'professional', 'firm'];
  if (!allowed.includes(s)) throw new Error('Tono inválido');
  return s;
}

function planValue(val) {
  const s = optionalString(val, 'plan');
  const allowed = ['free', 'pro', 'business'];
  if (!allowed.includes(s)) throw new Error('Plan inválido');
  return s;
}

function jsonField(val, name, def = {}) {
  if (val === undefined || val === null || val === '') return def;
  if (typeof val === 'object') return val;
  try {
    return JSON.parse(String(val));
  } catch (err) {
    throw new Error(`${name} debe ser un JSON válido`);
  }
}

module.exports = {
  requiredString,
  requiredEmail,
  positiveNumber,
  optionalString,
  statusValue,
  reminderTypeValue,
  toneValue,
  planValue,
  jsonField,
};
