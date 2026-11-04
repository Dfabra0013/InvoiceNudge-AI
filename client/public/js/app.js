const API = '/api';
const TOKEN_KEY = 'in_token';
const user = { id: null, email: null, name: null, role: 'user', token: null };

let currentRoute = '';
let invoicesCache = [];
let clientsCache = [];
let remindersCache = [];
let automationsCache = [];
let chartInstance = null;

// ---------- auth helpers ----------
function setToken(t) { user.token = t; localStorage.setItem(TOKEN_KEY, t); }
function clearToken() { user.token = null; localStorage.removeItem(TOKEN_KEY); }
function isAuth() { return !!user.token; }
function authHeaders() { return { 'Authorization': 'Bearer ' + user.token }; }

// ---------- API ----------
async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  if (user.token) headers.Authorization = 'Bearer ' + user.token;
  const res = await fetch(API + path, { ...opts, headers });
  let data = null;
  try { data = await res.json(); } catch {}
  if (!res.ok) {
    const err = new Error(data && data.error ? data.error : 'Error de servidor');
    err.status = res.status;
    throw err;
  }
  return data;
}

// ---------- UI ----------
function toast(msg, type = 'success') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'toast show ' + (type === 'error' ? 'error' : 'success');
  setTimeout(() => el.classList.remove('show'), 3500);
}

function setPageTitle(t) { document.getElementById('pageTitle').textContent = t; }

function showPage(id) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  const el = document.getElementById(id);
  if (el) el.classList.add('active');
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  const active = document.querySelector('.nav-item[data-route="' + id.replace('page','') + '"]');
  if (active) active.classList.add('active');
}

function navigate(route) {
  currentRoute = route;
  if (route === '/' || route === '/dashboard') { showPage('pageDashboard'); setPageTitle('Dashboard'); loadDashboard(); return; }
  if (route === '/invoices') { showPage('pageInvoices'); setPageTitle('Facturas'); loadInvoices(); return; }
  if (route === '/clients') { showPage('pageClients'); setPageTitle('Clientes'); loadClients(); return; }
  if (route === '/reminders') { showPage('pageReminders'); setPageTitle('Recordatorios IA'); loadReminders(); loadReminderFilters(); return; }
  if (route === '/automations') { showPage('pageAutomations'); setPageTitle('Automatizaciones'); loadAutomations(); return; }
  if (route === '/settings') { showPage('pageSettings'); setPageTitle('Ajustes'); loadSettings(); return; }
  if (route === '/profile') { showPage('pageProfile'); setPageTitle('Perfil'); loadProfile(); return; }
  if (route === '/login') { showPage('pageLoginForm'); setPageTitle('Iniciar sesión'); return; }
  if (route === '/register') { showPage('pageLogin'); setPageTitle('Crear cuenta'); return; }
  if (route === '/forgot') { showPage('pageForgot'); setPageTitle('Recuperar contraseña'); return; }
  showPage('pageDashboard'); setPageTitle('Dashboard'); loadDashboard();
}

function requireAuth() {
  if (!isAuth()) { navigate('/login'); return false; }
  return true;
}

// ---------- theme ----------
const themeToggle = document.getElementById('themeToggle');
const themeIcon = document.getElementById('themeIcon');
function initTheme() {
  const saved = localStorage.getItem('in_theme');
  const dark = saved ? saved === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches;
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
  themeIcon.textContent = dark ? '☀️' : '🌙';
}
themeToggle.addEventListener('click', () => {
  const dark = document.documentElement.getAttribute('data-theme') === 'light';
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
  localStorage.setItem('in_theme', dark ? 'dark' : 'light');
  themeIcon.textContent = dark ? '☀️' : '🌙';
});

// ---------- dashboard ----------
async function loadDashboard() {
  if (!isAuth()) return;
  try {
    const stats = await api('/invoices/stats', { headers: authHeaders() });
    document.getElementById('statTotal').textContent = stats.total_invoices;
    document.getElementById('statPending').textContent = stats.pending_invoices;
    document.getElementById('statOverdue').textContent = stats.overdue_invoices;
    document.getElementById('statPaid').textContent = stats.paid_invoices;
    document.getElementById('statTotalSub').textContent = stats.total_invoices + ' facturas';
    document.getElementById('sumPending').textContent = formatMoney(stats.pending_amount);
    document.getElementById('sumPaid').textContent = formatMoney(stats.paid_amount);

    const sub = await api('/settings/subscription', { headers: authHeaders() });
    document.getElementById('planBadge').textContent = (sub.plan || 'free').toUpperCase();
    document.getElementById('planBadge').className = 'badge';
    const aiNote = document.getElementById('aiNote');
    aiNote.innerHTML = '<strong>Plan:</strong> ' + (sub.plan || 'free') + ' &bull; <strong>Límite IA:</strong> ' + sub.limits.ai_generations + ' generaciones/mes';

    drawChart(stats.monthly_evolution);
    renderActivity(stats.recent_activity);
  } catch (err) { toast(err.message, 'error'); }
}

function formatMoney(n) {
  return Number(n || 0).toLocaleString('es-ES', { style: 'currency', currency: 'EUR' });
}

function drawChart(points) {
  const canvas = document.getElementById('chartEvolution');
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.parentElement.getBoundingClientRect();
  canvas.width = rect.width * dpr; canvas.height = rect.height * dpr;
  ctx.scale(dpr, dpr);
  canvas.style.width = rect.width + 'px'; canvas.style.height = rect.height + 'px';
  const width = rect.width, height = rect.height - 30;
  if (chartInstance) { try { chartInstance.destroy(); } catch {} }
  const labels = points.map(p => p.month);
  const values = points.map(p => Number(p.total || 0));
  const max = Math.max(...values, 1);
  const step = height / 4;
  // grid
  ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--gray-200').trim() || '#e2e8f0';
  if (document.documentElement.getAttribute('data-theme') === 'dark') ctx.strokeStyle = 'rgba(148,163,184,0.15)';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = height - (i * step);
    ctx.beginPath(); ctx.moveTo(30, y); ctx.lineTo(width - 10, y); ctx.stroke();
  }
  // line
  ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--primary') ? 'rgb(' + getComputedStyle(document.documentElement).getPropertyValue('--primary').trim() + ')' : '#4f46e5';
  ctx.lineWidth = 2.5; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  const pts = values.map((v, i) => ({ x: 30 + (i / (labels.length - 1)) * (width - 40), y: height - (v / max) * height }));
  ctx.beginPath(); ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.stroke();
  // dots
  ctx.fillStyle = ctx.strokeStyle;
  pts.forEach(p => { ctx.beginPath(); ctx.arc(p.x, p.y, 3.5, 0, Math.PI * 2); ctx.fill(); });
  // labels
  ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--gray-500').trim() || '#64748b';
  ctx.font = '11px system-ui';
  labels.forEach((l, i) => { ctx.fillText(l, pts[i].x - 18, height + 17); });
}

function renderActivity(items) {
  const tb = document.getElementById('tbodyActivity');
  tb.innerHTML = '';
  if (!items || items.length === 0) { tb.innerHTML = '<tr><td colspan="5" style="text-align:center;color:var(--gray-500)">Sin actividad reciente.</td></tr>'; return; }
  items.forEach(it => {
    const tr = document.createElement('tr');
    const cls = 'status-' + (it.status || 'draft');
    const date = it.updated_at ? new Date(it.updated_at).toLocaleDateString('es-ES') : '';
    tr.innerHTML = '<td><strong>' + escapeHtml(it.invoice_number || '-') + '</strong></td><td>' + escapeHtml(it.client_name || '-') + '</td><td><span class="status-badge ' + cls + '">' + (it.status || '-') + '</span></td><td>' + formatMoney(it.amount) + '</td><td>' + date + '</td>';
    tb.appendChild(tr);
  });
}

// ---------- invoices ----------
async function loadInvoices() {
  if (!isAuth()) return;
  const status = document.getElementById('filtStatus').value;
  const client = document.getElementById('filtClient').value;
  const search = document.getElementById('filtSearch').value;
  const sort = document.getElementById('filtSort').value;
  let q = '?';
  if (status) q += 'status=' + encodeURIComponent(status) + '&';
  if (client) q += 'client_id=' + encodeURIComponent(client) + '&';
  if (search) q += 'search=' + encodeURIComponent(search) + '&';
  const [sCol, sDir] = sort.split(' ');
  q += 'sort=' + encodeURIComponent(sCol) + '&order=' + encodeURIComponent(sDir);
  try {
    invoicesCache = await api('/invoices' + q, { headers: authHeaders() });
    renderInvoices();
    await loadClientsSelect('invClientSelect');
    await loadClientsSelect('remInvoiceSelect');
  } catch (err) { toast(err.message, 'error'); }
}

function renderInvoices() {
  const tb = document.getElementById('tbodyInvoices');
  const empty = document.getElementById('emptyInvoices');
  tb.innerHTML = '';
  if (!invoicesCache || invoicesCache.length === 0) { tb.style.display = 'none'; empty.style.display = 'block'; return; }
  tb.style.display = ''; empty.style.display = 'none';
  invoicesCache.forEach(it => {
    const tr = document.createElement('tr');
    const cls = 'status-' + (it.status || 'draft');
    const due = it.due_date ? new Date(it.due_date).toLocaleDateString('es-ES') : '-';
    tr.innerHTML =
      '<td><strong>' + escapeHtml(it.invoice_number || '-') + '</strong></td>' +
      '<td>' + escapeHtml(it.client_name || '-') + '</td>' +
      '<td><span class="status-badge ' + cls + '">' + (it.status || '-') + '</span></td>' +
      '<td>' + due + '</td>' +
      '<td>' + formatMoney(it.amount) + ' ' + (it.currency || 'EUR') + '</td>' +
      '<td>' +
      '<button class="btn btn-sm btn-outline" onclick="app.editInvoice(' + JSON.stringify(it).replace(/"/g, '&quot;') + ')">Editar</button> ' +
      (it.status === 'paid' ? '' : '<button class="btn btn-sm btn-success" onclick="app.payInvoice(\'' + it.id + '\')">Pagar</button> ') +
      '<button class="btn btn-sm btn-outline" onclick="app.delInvoice(\'' + it.id + '\', \'' + escapeHtml(it.invoice_number || '') + '\')">Eliminar</button>' +
      '</td>';
    tb.appendChild(tr);
  });
}

async function loadClientsSelect(selectId) {
  try {
    const clients = await api('/clients', { headers: authHeaders() });
    clientsCache = clients;
    const sel = document.getElementById(selectId);
    const cur = sel.value;
    sel.innerHTML = '<option value="">Sin cliente</option>';
    clients.forEach(c => sel.innerHTML += '<option value="' + c.id + '">' + escapeHtml(c.name) + '</option>');
    if (cur) sel.value = cur;
  } catch {}
}

document.getElementById('filtStatus').addEventListener('change', loadInvoices);
document.getElementById('filtClient').addEventListener('change', loadInvoices);
document.getElementById('filtSearch').addEventListener('input', loadInvoices);
document.getElementById('filtSort').addEventListener('change', loadInvoices);
document.getElementById('btnClearFilters').addEventListener('click', () => {
  document.getElementById('filtStatus').value = '';
  document.getElementById('filtClient').value = '';
  document.getElementById('filtSearch').value = '';
  document.getElementById('filtSort').value = 'created_at desc';
  loadInvoices();
});

document.getElementById('btnNewInvoice').addEventListener('click', openInvoiceModal);
function openInvoiceModal(it) {
  const modal = document.getElementById('modalInvoice');
  const form = document.getElementById('formInvoice');
  const title = document.getElementById('modalInvoiceTitle');
  form.reset();
  document.getElementById('invClientSelect').innerHTML = '<option value="">Sin cliente</option>';
  if (it) {
    title.textContent = 'Editar factura';
    document.getElementById('modalInvoiceTitle').textContent = 'Editar factura';
    form.id.value = it.id;
    form.invoice_number.value = it.invoice_number || '';
    form.client_id.value = it.client_id || '';
    form.status.value = it.status || 'draft';
    form.issue_date.value = it.issue_date || '';
    form.due_date.value = it.due_date || '';
    form.currency.value = it.currency || 'EUR';
    form.description.value = it.description || '';
    form.amount.value = it.amount || '';
    form.notes.value = it.notes || '';
  } else {
    title.textContent = 'Nueva factura';
    const d = new Date(); form.issue_date.value = d.toISOString().slice(0,10);
    const d2 = new Date(); d2.setDate(d2.getDate() + 7); form.due_date.value = d2.toISOString().slice(0,10);
  }
  awaitLoadClients('invClientSelect').then(() => { if (it) document.getElementById('invClientSelect').value = it.client_id || ''; });
  modal.classList.add('open');
  document.getElementById('modalInvoiceBackdrop').addEventListener('click', closeInvoiceModal, { once: true });
  document.getElementById('modalInvoiceClose').addEventListener('click', closeInvoiceModal, { once: true });
  document.getElementById('modalInvoiceCancel').addEventListener('click', closeInvoiceModal, { once: true });
}
async function awaitLoadClients(id) {
  const clients = await api('/clients', { headers: authHeaders() });
  clientsCache = clients;
  const sel = document.getElementById(id);
  clients.forEach(c => sel.innerHTML += '<option value="' + c.id + '">' + escapeHtml(c.name) + '</option>');
}
function closeInvoiceModal() { document.getElementById('modalInvoice').classList.remove('open'); }

document.getElementById('formInvoice').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const payload = {};
  fd.forEach((v, k) => { if (v !== '') payload[k] = v; });
  if (payload.amount !== undefined) payload.amount = Number(payload.amount);
  const id = payload.id;
  delete payload.id;
  try {
    if (id) await api('/invoices/' + id, { method: 'PUT', headers: authHeaders(), body: JSON.stringify(payload) });
    else await api('/invoices', { method: 'POST', headers: authHeaders(), body: JSON.stringify(payload) });
    closeInvoiceModal(); toast(id ? 'Factura actualizada' : 'Factura creada'); loadInvoices(); loadDashboard();
  } catch (err) { toast(err.message, 'error'); }
});

window.payInvoice = async function(id) {
  document.getElementById('modalPayText').textContent = '¿Marcar esta factura como pagada?';
  const modal = document.getElementById('modalPay');
  modal.classList.add('open');
  document.getElementById('modalPayConfirm').onclick = async () => {
    try { await api('/invoices/' + id + '/pay', { method: 'PATCH', headers: authHeaders() }); closePayModal(); toast('Factura marcada como pagada'); loadInvoices(); loadDashboard(); }
    catch (err) { toast(err.message, 'error'); }
  };
  document.getElementById('modalPayClose').onclick = closePayModal;
  document.getElementById('modalPayCancel').onclick = closePayModal;
  document.getElementById('modalPayBackdrop').onclick = closePayModal;
};
function closePayModal() { document.getElementById('modalPay').classList.remove('open'); }

window.delInvoice = async function(id, num) {
  document.getElementById('modalDeleteText').textContent = '¿Eliminar la factura "' + num + '"? Esta acción no se puede deshacer.';
  const modal = document.getElementById('modalDelete');
  modal.classList.add('open');
  document.getElementById('modalDeleteConfirm').onclick = async () => {
    try { await api('/invoices/' + id, { method: 'DELETE', headers: authHeaders() }); closeDeleteModal(); toast('Factura eliminada'); loadInvoices(); loadDashboard(); }
    catch (err) { toast(err.message, 'error'); }
  };
  document.getElementById('modalDeleteClose').onclick = closeDeleteModal;
  document.getElementById('modalDeleteCancel').onclick = closeDeleteModal;
  document.getElementById('modalDeleteBackdrop').onclick = closeDeleteModal;
};
function closeDeleteModal() { document.getElementById('modalDelete').classList.remove('open'); }

window.editInvoice = function(it) { openInvoiceModal(it); };

// ---------- clients ----------
async function loadClients() {
  if (!isAuth()) return;
  const search = document.getElementById('filtClientSearch').value;
  let q = search ? '?search=' + encodeURIComponent(search) : '';
  try {
    clientsCache = await api('/clients' + q, { headers: authHeaders() });
    renderClients();
  } catch (err) { toast(err.message, 'error'); }
}
function renderClients() {
  const tb = document.getElementById('tbodyClients'); const empty = document.getElementById('emptyClients');
  tb.innerHTML = '';
  if (!clientsCache || clientsCache.length === 0) { tb.style.display = 'none'; empty.style.display = 'block'; return; }
  tb.style.display = ''; empty.style.display = 'none';
  clientsCache.forEach(c => {
    const invCount = (invoicesCache || []).filter(i => i.client_id === c.id).length;
    const tr = document.createElement('tr');
    tr.innerHTML =
      '<td><strong>' + escapeHtml(c.name) + '</strong></td>' +
      '<td>' + escapeHtml(c.email || '-') + '</td>' +
      '<td>' + invCount + '</td>' +
      '<td>' +
      '<button class="btn btn-sm btn-outline" onclick="app.editClient(' + JSON.stringify(c).replace(/"/g, '&quot;') + ')">Editar</button> ' +
      '<button class="btn btn-sm btn-danger" onclick="app.delClient(\'' + c.id + '\', \'' + escapeHtml(c.name || '') + '\')">Eliminar</button>' +
      '</td>';
    tb.appendChild(tr);
  });
}
document.getElementById('filtClientSearch').addEventListener('input', loadClients);
document.getElementById('btnNewClient').addEventListener('click', () => openClientModal());
function openClientModal(it) {
  const modal = document.getElementById('modalClient');
  const form = document.getElementById('formClient'); form.reset();
  if (it) {
    document.getElementById('modalClientTitle').textContent = 'Editar cliente';
    form.id.value = it.id; form.name.value = it.name; form.email.value = it.email || ''; form.address.value = it.address || ''; form.tax_id.value = it.tax_id || '';
  } else { document.getElementById('modalClientTitle').textContent = 'Nuevo cliente'; }
  modal.classList.add('open');
  document.getElementById('modalClientBackdrop').onclick = closeClientModal;
  document.getElementById('modalClientClose').onclick = closeClientModal;
  document.getElementById('modalClientCancel').onclick = closeClientModal;
}
function closeClientModal() { document.getElementById('modalClient').classList.remove('open'); }
document.getElementById('formClient').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target); const payload = {}; fd.forEach((v,k)=>{ if(v!=='') payload[k]=v; });
  const id = payload.id; delete payload.id;
  try {
    if (id) await api('/clients/' + id, { method: 'PUT', headers: authHeaders(), body: JSON.stringify(payload) });
    else await api('/clients', { method: 'POST', headers: authHeaders(), body: JSON.stringify(payload) });
    closeClientModal(); toast('Cliente guardado'); loadClients(); loadInvoices();
  } catch (err) { toast(err.message, 'error'); }
});
window.editClient = function(c) { openClientModal(c); };
window.delClient = async function(id, name) {
  if (!confirm('¿Eliminar el cliente "' + name + '"?')) return;
  try { await api('/clients/' + id, { method: 'DELETE', headers: authHeaders() }); toast('Cliente eliminado'); loadClients(); loadInvoices(); }
  catch (err) { toast(err.message, 'error'); }
};

// ---------- reminders ----------
async function loadReminders() {
  if (!isAuth()) return;
  const invoice_id = document.getElementById('filtRemInvoice') ? document.getElementById('filtRemInvoice').value : '';
  let q = invoice_id ? '?invoice_id=' + encodeURIComponent(invoice_id) : '';
  try {
    remindersCache = await api('/reminders' + q, { headers: authHeaders() });
    renderReminders();
  } catch (err) { toast(err.message, 'error'); }
}
function renderReminders() {
  const tb = document.getElementById('tbodyReminders'); const empty = document.getElementById('emptyReminders');
  tb.innerHTML = '';
  if (!remindersCache || remindersCache.length === 0) { tb.style.display = 'none'; empty.style.display = 'block'; return; }
  tb.style.display = ''; empty.style.display = 'none';
  remindersCache.forEach(r => {
    const tr = document.createElement('tr');
    const created = r.created_at ? new Date(r.created_at).toLocaleDateString('es-ES') : '-';
    tr.innerHTML =
      '<td><strong>' + escapeHtml(r.invoice_number || '-') + '</strong></td>' +
      '<td>' + escapeHtml(r.reminder_type || '-') + '</td>' +
      '<td>' + escapeHtml(r.tone || '-') + '</td>' +
      '<td>' + escapeHtml((r.message || '').slice(0, 90)) + (r.message && r.message.length > 90 ? '…' : '') + '</td>' +
      '<td><span class="badge">' + (r.ai_generated ? 'IA' : 'Plantilla') + '</span></td>' +
      '<td>' + created + '</td>' +
      '<td>' +
      '<button class="btn btn-sm btn-outline" onclick="app.editReminder(\'' + r.id + '\')">Editar</button> ' +
      '<button class="btn btn-sm btn-danger" onclick="app.delReminder(\'' + r.id + '\')">Eliminar</button>' +
      '</td>';
    tb.appendChild(tr);
  });
}
async function loadReminderFilters() {
  const tSel = document.getElementById('remType'); const toneSel = document.getElementById('remTone');
  try {
    const data = await api('/reminders/types', { headers: authHeaders() });
    tSel.innerHTML = ''; toneSel.innerHTML = '';
    data.types.forEach(t => { tSel.innerHTML += '<option value="' + t.key + '">' + t.label + '</option>'; });
    data.tones.forEach(t => { toneSel.innerHTML += '<option value="' + t.key + '">' + t.label + '</option>'; });
    const badge = document.getElementById('aiProviderBadge');
    badge.textContent = 'IA: ';
    try {
      const st = await api('/settings/subscription', { headers: authHeaders() });
      // check env via settings not possible; show plan-based
      badge.className = 'ai-badge ai-off';
      badge.textContent += 'Plantillas (configura IA para usar proveedor real)';
    } catch {}
  } catch {}
}

document.getElementById('filtRemType').addEventListener('change', loadReminders);
document.getElementById('filtRemTone').addEventListener('change', loadReminders);
document.getElementById('filtRemSearch').addEventListener('input', loadReminders);

document.getElementById('btnNewReminder').addEventListener('click', () => openReminderModal());
function openReminderModal() {
  const modal = document.getElementById('modalReminder');
  const form = document.getElementById('formReminder'); form.reset();
  document.getElementById('remMessage').value = '';
  document.getElementById('remHint').textContent = '';
  modal.classList.add('open');
  document.getElementById('modalReminderBackdrop').onclick = closeReminderModal;
  document.getElementById('modalReminderClose').onclick = closeReminderModal;
  document.getElementById('modalReminderCancel').onclick = closeReminderModal;
  document.getElementById('btnGenerateAI').onclick = generateReminderAI;
}
function closeReminderModal() { document.getElementById('modalReminder').classList.remove('open'); }

async function generateReminderAI() {
  const form = document.getElementById('formReminder');
  const fd = new FormData(form);
  const payload = {}; fd.forEach((v,k)=> payload[k]=v);
  if (!payload.invoice_id) { toast('Selecciona una factura', 'error'); return; }
  try {
    const res = await api('/reminders/generate', { method: 'POST', headers: authHeaders(), body: JSON.stringify(payload) });
    document.getElementById('remMessage').value = res.message;
    document.getElementById('remHint').innerHTML = '<span class="badge">' + (res.provider || 'template') + '</span> ' + (res.ai_available !== false ? 'proveedor IA conectado' : 'usando plantillas') + (res.ai_generated ? '' : '');
    toast(res.ai_generated ? 'Mensaje generado por IA' : 'Mensaje generado desde plantilla');
  } catch (err) { toast(err.message, 'error'); }
}

document.getElementById('formReminder').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target); const payload = {}; fd.forEach((v,k)=>{ if(v!=='') payload[k]=v; });
  try {
    await api('/reminders', { method: 'POST', headers: authHeaders(), body: JSON.stringify(payload) });
    closeReminderModal(); toast('Recordatorio guardado'); loadReminders(); loadDashboard();
  } catch (err) { toast(err.message, 'error'); }
});

window.editReminder = async function(id) {
  const r = remindersCache.find(x => x.id === id);
  if (!r) return;
  const modal = document.getElementById('modalEditReminder');
  const form = document.getElementById('formEditReminder'); form.reset();
  form.id.value = r.id; form.message.value = r.message || '';
  modal.classList.add('open');
  document.getElementById('modalEditReminderBackdrop').onclick = closeEditReminderModal;
  document.getElementById('modalEditReminderClose').onclick = closeEditReminderModal;
  document.getElementById('modalEditReminderCancel').onclick = closeEditReminderModal;
};
function closeEditReminderModal() { document.getElementById('modalEditReminder').classList.remove('open'); }
document.getElementById('formEditReminder').addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = document.getElementById('formEditReminder').id.value;
  const message = document.getElementById('formEditReminder').message.value;
  try { await api('/reminders/' + id, { method: 'PUT', headers: authHeaders(), body: JSON.stringify({ message }) }); closeEditReminderModal(); toast('Recordatorio actualizado'); loadReminders(); }
  catch (err) { toast(err.message, 'error'); }
});
window.delReminder = async function(id) {
  if (!confirm('¿Eliminar este recordatorio?')) return;
  try { await api('/reminders/' + id, { method: 'DELETE', headers: authHeaders() }); toast('Recordatorio eliminado'); loadReminders(); }
  catch (err) { toast(err.message, 'error'); }
};

// ---------- automations ----------
async function loadAutomations() {
  if (!isAuth()) return;
  try {
    automationsCache = await api('/automations', { headers: authHeaders() });
    renderAutomations();
  } catch (err) { toast(err.message, 'error'); }
}
function renderAutomations() {
  const tb = document.getElementById('tbodyAutomations'); const empty = document.getElementById('emptyAutomations');
  tb.innerHTML = '';
  if (!automationsCache || automationsCache.length === 0) { tb.style.display = 'none'; empty.style.display = 'block'; return; }
  tb.style.display = ''; empty.style.display = 'none';
  automationsCache.forEach(a => {
    const tr = document.createElement('tr');
    const activeCls = a.is_active ? 'status-paid' : 'status-draft';
    tr.innerHTML =
      '<td><strong>' + escapeHtml(a.name) + '</strong></td>' +
      '<td>' + escapeHtml(a.reminder_type || '-') + '</td>' +
      '<td>' + escapeHtml(a.tone || '-') + '</td>' +
      '<td>' + escapeHtml(a.schedule_cron || '-') + '</td>' +
      '<td><span class="status-badge ' + activeCls + '">' + (a.is_active ? 'Activa' : 'Inactiva') + '</span></td>' +
      '<td>' + (a.last_run_at ? new Date(a.last_run_at).toLocaleDateString('es-ES') : '-') + '</td>' +
      '<td>' +
      '<button class="btn btn-sm btn-outline" onclick="app.toggleAutomation(\'' + a.id + '\', ' + (a.is_active ? 0 : 1) + ')">' + (a.is_active ? 'Pausar' : 'Activar') + '</button> ' +
      '<button class="btn btn-sm btn-outline" onclick="app.editAutomation(' + JSON.stringify(a).replace(/"/g, '&quot;') + ')">Editar</button> ' +
      '<button class="btn btn-sm btn-danger" onclick="app.delAutomation(\'' + a.id + '\')">Eliminar</button>' +
      '</td>';
    tb.appendChild(tr);
  });
}
document.getElementById('btnNewAutomation').addEventListener('click', () => openAutomationModal());
function openAutomationModal(it) {
  const modal = document.getElementById('modalAutomation');
  const form = document.getElementById('formAutomation'); form.reset();
  if (it) {
    document.getElementById('modalAutomationTitle').textContent = 'Editar automatización';
    form.id.value = it.id; form.name.value = it.name; form.description.value = it.description || '';
    form.reminder_type.value = it.reminder_type || 'due'; form.tone.value = it.tone || 'professional';
    form.language.value = it.language || 'es'; form.schedule_cron.value = it.schedule_cron || '';
    form.conditions.value = it.conditions ? (typeof it.conditions === 'string' ? it.conditions : JSON.stringify(it.conditions)) : '';
  } else { document.getElementById('modalAutomationTitle').textContent = 'Nueva automatización'; }
  modal.classList.add('open');
  document.getElementById('modalAutomationBackdrop').onclick = closeAutomationModal;
  document.getElementById('modalAutomationClose').onclick = closeAutomationModal;
  document.getElementById('modalAutomationCancel').onclick = closeAutomationModal;
}
function closeAutomationModal() { document.getElementById('modalAutomation').classList.remove('open'); }
document.getElementById('formAutomation').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target); const payload = {}; fd.forEach((v,k)=> payload[k]=v);
  if (payload.conditions) { try { payload.conditions = JSON.parse(payload.conditions); } catch { toast('Condiciones JSON inválidas', 'error'); return; } }
  const id = payload.id; delete payload.id;
  try {
    if (id) await api('/automations/' + id, { method: 'PUT', headers: authHeaders(), body: JSON.stringify(payload) });
    else await api('/automations', { method: 'POST', headers: authHeaders(), body: JSON.stringify(payload) });
    closeAutomationModal(); toast('Automatización guardada'); loadAutomations();
  } catch (err) { toast(err.message, 'error'); }
});
window.toggleAutomation = async function(id, next) {
  try { await api('/automations/' + id + '/toggle', { method: 'POST', headers: authHeaders() }); toast(next ? 'Automatización activada' : 'Automatización pausada'); loadAutomations(); }
  catch (err) { toast(err.message, 'error'); }
};
window.editAutomation = function(a) { openAutomationModal(a); };
window.delAutomation = async function(id) {
  if (!confirm('¿Eliminar esta automatización?')) return;
  try { await api('/automations/' + id, { method: 'DELETE', headers: authHeaders() }); toast('Automatización eliminada'); loadAutomations(); }
  catch (err) { toast(err.message, 'error'); }
};

// ---------- settings ----------
async function loadSettings() {
  if (!isAuth()) return;
  try {
    const cfg = await api('/email/configure', { headers: authHeaders() });
    document.getElementById('smtpStatus').textContent = cfg.configured ? 'SMTP configurado' : 'SMTP no configurado';
    document.getElementById('smtpStatus').className = 'hint smtp-status' + (cfg.configured ? ' success' : '');
    const sub = await api('/settings/subscription', { headers: authHeaders() });
    document.getElementById('planName').textContent = (sub.plan || 'free').toUpperCase();
    document.getElementById('planLimits').innerHTML = '<div>Facturas/mes: ' + sub.limits.invoices + '</div><div>IA/mes: ' + sub.limits.ai_generations + '</div><div>Automatizaciones: ' + sub.limits.automations + '</div>';
    document.getElementById('usageList').innerHTML =
      '<div>Este mes - Facturas: ' + sub.usage.invoices_count + '</div>' +
      '<div>Este mes - IA: ' + sub.usage.ai_generations_count + '</div>' +
      '<div>Este mes - Automatizaciones: ' + sub.usage.automations_count + '</div>';
    document.getElementById('stripeNote').innerHTML = sub.stripe_configured ? '<div class="hint">Stripe configurado.</div>' : '<div class="hint">Stripe no configurado (pagos desactivados).</div>';
  } catch (err) { toast(err.message, 'error'); }
}
document.getElementById('formSmtp').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target); const payload = {}; fd.forEach((v,k)=> payload[k]=v);
  try { await api('/email/configure', { method: 'POST', headers: authHeaders(), body: JSON.stringify(payload) }); toast('Configuración de correo guardada'); loadSettings(); }
  catch (err) { toast(err.message, 'error'); }
});
document.getElementById('btnSmtpTest').addEventListener('click', async () => {
  const to = prompt('Correo para prueba:');
  if (!to) return;
  try { await api('/email/send-test', { method: 'POST', headers: authHeaders(), body: JSON.stringify({ to }) }); toast('Correo de prueba enviado'); }
  catch (err) { toast(err.message, 'error'); }
});

// ---------- profile ----------
async function loadProfile() {
  if (!isAuth()) return;
  try {
    const data = await api('/auth/profile', { headers: authHeaders() });
    const u = data.user;
    document.getElementById('topbarUser').textContent = u.name || u.email;
    document.getElementById('formProfile').name.value = u.name || '';
    document.getElementById('formProfile').email.value = u.email || '';
    const p = u.profile || {};
    document.getElementById('formCompany').company_name.value = p.company_name || '';
    document.getElementById('formCompany').company_address.value = p.company_address || '';
    document.getElementById('formCompany').company_tax_id.value = p.company_tax_id || '';
    document.getElementById('formCompany').currency.value = p.currency || 'EUR';
    document.getElementById('formCompany').language.value = p.language || 'es';
  } catch (err) { toast(err.message, 'error'); }
}
document.getElementById('formProfile').addEventListener('submit', async (e) => {
  e.preventDefault();
  try { await api('/auth/profile', { method: 'PUT', headers: authHeaders(), body: JSON.stringify({ name: document.getElementById('formProfile').name.value }) }); toast('Perfil actualizado'); loadProfile(); loadDashboard(); }
  catch (err) { toast(err.message, 'error'); }
});
document.getElementById('formCompany').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target); const payload = {}; fd.forEach((v,k)=> payload[k]=v);
  try { await api('/settings', { method: 'PUT', headers: authHeaders(), body: JSON.stringify(payload) }); toast('Datos de empresa guardados'); loadProfile(); }
  catch (err) { toast(err.message, 'error'); }
});

// ---------- auth flows ----------
document.getElementById('formRegister').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target); const payload = {}; fd.forEach((v,k)=> payload[k]=v);
  try {
    const data = await api('/auth/register', { method: 'POST', body: JSON.stringify(payload) });
    setToken(data.token);
    Object.assign(user, { id: data.user.id, email: data.user.email, name: data.user.name, role: data.user.role });
    toast('Cuenta creada');
    navigate('/dashboard');
  } catch (err) { toast(err.message, 'error'); }
});
document.getElementById('formLogin').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target); const payload = {}; fd.forEach((v,k)=> payload[k]=v);
  try {
    const data = await api('/auth/login', { method: 'POST', body: JSON.stringify(payload) });
    setToken(data.token);
    Object.assign(user, { id: data.user.id, email: data.user.email, name: data.user.name, role: data.user.role });
    toast('Sesión iniciada');
    navigate('/dashboard');
  } catch (err) { toast(err.message, 'error'); }
});
document.getElementById('formForgot').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target); const payload = {}; fd.forEach((v,k)=> payload[k]=v);
  try { await api('/auth/forgot-password', { method: 'POST', body: JSON.stringify(payload) }); toast('Si el correo existe, recibirás instrucciones'); navigate('/login'); }
  catch (err) { toast(err.message, 'error'); }
});
document.getElementById('btnLogout').addEventListener('click', async () => {
  try { await api('/auth/logout', { method: 'POST', headers: authHeaders() }); } catch {}
  clearToken(); Object.assign(user, { id: null, email: null, name: null, role: 'user', token: null });
  toast('Sesión cerrada');
  navigate('/login');
});

// ---------- email verification / reset from query ----------
(function handleQuery() {
  const params = new URLSearchParams(location.search);
  if (params.get('token') && params.get('action') === 'verify') {
    fetch(API + '/auth/verify-email?token=' + encodeURIComponent(params.get('token'))).then(r => r.json()).then(d => { toast(d.message || 'Correo verificado'); history.replaceState(null, '', location.pathname); }).catch(() => {});
  }
  if (params.get('token') && params.get('action') === 'reset') {
    showPage('pageLoginForm'); // reuse login; show reset UI could be added
  }
})();

// ---------- router ----------
window.app = window.app || {};
window.app.editInvoice = editInvoice;
window.app.payInvoice = payInvoice;
window.app.delInvoice = delInvoice;
window.app.editClient = editClient;
window.app.delClient = delClient;
window.app.editReminder = editReminder;
window.app.delReminder = delReminder;
window.app.editAutomation = editAutomation;
window.app.delAutomation = delAutomation;
window.app.toggleAutomation = toggleAutomation;

window.addEventListener('popstate', () => { const r = location.hash.slice(1) || '/'; navigate(r); });
document.querySelectorAll('.nav-item').forEach(n => {
  n.addEventListener('click', (e) => {
    const route = n.getAttribute('href');
    if (route && route.startsWith('#/')) { e.preventDefault(); navigate(route); document.getElementById('sidebar').classList.remove('open'); }
  });
});
document.getElementById('mobileMenuBtn').addEventListener('click', () => { document.getElementById('sidebar').classList.toggle('open'); });
document.getElementById('sidebarOverlay').addEventListener('click', () => { document.getElementById('sidebar').classList.remove('open'); });

// ---------- boot ----------
(function boot() {
  initTheme();
  const saved = localStorage.getItem(TOKEN_KEY);
  if (saved) {
    user.token = saved;
    // validate token by loading profile; on failure, clear
    fetch(API + '/auth/profile', { headers: authHeaders() }).then(r => {
      if (r.ok) return r.json();
      throw new Error('invalid');
    }).then(d => {
      Object.assign(user, { id: d.user.id, email: d.user.email, name: d.user.name, role: d.user.role });
      document.getElementById('topbarUser').textContent = d.user.name || d.user.email;
      const route = location.hash.slice(1) || '/';
      navigate(route);
    }).catch(() => { clearToken(); navigate('/login'); });
  } else {
    navigate('/login');
  }
})();

function escapeHtml(s) {
  if (s == null) return '';
  return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":"&#39;" }[c]));
}
