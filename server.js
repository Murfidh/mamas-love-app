'use strict';
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const store = require('./lib/db');

const PORT = Number(process.env.PORT || 3000);
const SESSION_DAYS = Number(process.env.SESSION_DAYS || 7);
const COOKIE = 'ml_session';

store.ensureAdmin();
const SECRET = store.sessionSecret();

const app = express();
app.disable('x-powered-by');
if (process.env.TRUST_PROXY !== 'false') app.set('trust proxy', 1); // behind Caddy / Nginx / Render / Railway
app.use(express.json({ limit: '25mb' }));

/* ---------- security headers ---------- */
app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'same-origin',
    'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com data:; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
  });
  next();
});

/* ---------- sessions (signed cookie) ---------- */
const sign = v => crypto.createHmac('sha256', SECRET).update(v).digest('base64url');
function makeToken(username) {
  const payload = Buffer.from(JSON.stringify({ u: username, exp: Date.now() + SESSION_DAYS * 864e5 })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}
function readToken(tok) {
  if (!tok || !tok.includes('.')) return null;
  const [payload, sig] = tok.split('.');
  const want = sign(payload);
  if (sig.length !== want.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want))) return null;
  try { const p = JSON.parse(Buffer.from(payload, 'base64url').toString()); return p.exp > Date.now() ? p : null; } catch { return null; }
}
const cookies = req => Object.fromEntries((req.headers.cookie || '').split(';').map(s => s.trim().split('=')).filter(p => p[0]).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]));
function setSession(req, res, username) {
  const secure = process.env.COOKIE_SECURE ? process.env.COOKIE_SECURE === 'true' : req.secure;
  res.cookie(COOKIE, makeToken(username), { httpOnly: true, sameSite: 'lax', secure, maxAge: SESSION_DAYS * 864e5, path: '/' });
}

function auth(minRole = 'viewer') {
  return (req, res, next) => {
    const p = readToken(cookies(req)[COOKIE]);
    const user = p && store.getUser(p.u);
    if (!user) return res.status(401).json({ error: 'Sign in to continue.' });
    if (store.ROLES[user.role] < store.ROLES[minRole]) return res.status(403).json({ error: minRole === 'admin' ? 'Only an admin can do this.' : 'Your account is view-only. Ask an admin for Staff access.' });
    req.user = user;
    next();
  };
}

/* ---------- login with simple rate limit ---------- */
const attempts = new Map();
function limited(ip) {
  const a = attempts.get(ip);
  if (!a || a.reset < Date.now()) { attempts.set(ip, { n: 1, reset: Date.now() + 15 * 60e3 }); return false; }
  a.n++; return a.n > 10;
}
app.post('/api/login', (req, res) => {
  if (limited(req.ip)) return res.status(429).json({ error: 'Too many sign-in attempts. Wait 15 minutes and try again.' });
  const { username, password } = req.body || {};
  const user = store.getUser(username);
  if (!user || !store.verifyPassword(password || '', user.pass)) return res.status(401).json({ error: 'Username or password is incorrect.' });
  attempts.delete(req.ip);
  setSession(req, res, user.username);
  res.json({ user: store.publicUser(user) });
});
app.post('/api/logout', (req, res) => { res.clearCookie(COOKIE, { path: '/' }); res.json({ ok: true }); });
app.get('/api/me', auth(), (req, res) => res.json({ user: store.publicUser(req.user) }));
app.post('/api/password', auth(), (req, res) => {
  const { current, next } = req.body || {};
  if (!store.verifyPassword(current || '', req.user.pass)) return res.status(400).json({ error: 'Current password is incorrect.' });
  if (!next || String(next).length < 8) return res.status(400).json({ error: 'New password must be at least 8 characters.' });
  store.updateUser(req.user.username, { password: next });
  res.json({ ok: true });
});

/* ---------- data ---------- */
const checkDoc = (req, res) => {
  const { col, id } = req.params;
  if (!store.COLS.includes(col)) { res.status(404).json({ error: 'Unknown record type.' }); return false; }
  if (!store.validId(id)) { res.status(400).json({ error: 'Invalid record id.' }); return false; }
  if (req.method !== 'DELETE' && (!req.body || typeof req.body !== 'object' || Array.isArray(req.body))) { res.status(400).json({ error: 'Record must be an object.' }); return false; }
  return true;
};
const NUM_LABEL = { invoices: 'Invoice', purchases: 'Purchase', grns: 'GRN', collections: 'Receipt', payments: 'Voucher' };

app.get('/api/data', auth(), (req, res) => res.json(store.allData()));
app.get('/api/rev', auth(), (req, res) => res.json({ rev: store.rev() }));
app.put('/api/docs/:col/:id', auth('staff'), (req, res) => {
  if (!checkDoc(req, res)) return;
  const { col, id } = req.params;
  const body = { ...req.body }; delete body.id;
  if (NUM_LABEL[col] && store.numberTaken(col, id, body.no)) return res.status(409).json({ error: `${NUM_LABEL[col]} number ${body.no} is already used. Change the number and save again.` });
  res.json(store.putDoc(col, id, body, req.user.username));
});
app.patch('/api/docs/:col/:id', auth('staff'), (req, res) => {
  if (!checkDoc(req, res)) return;
  const out = store.patchDoc(req.params.col, req.params.id, req.body, req.user.username);
  if (!out) return res.status(404).json({ error: 'That record no longer exists. Reload the page.' });
  res.json(out);
});
app.delete('/api/docs/:col/:id', auth('staff'), (req, res) => {
  if (!checkDoc(req, res)) return;
  res.json(store.deleteDoc(req.params.col, req.params.id, req.user.username));
});
app.put('/api/settings', auth('admin'), (req, res) => {
  if (!req.body || typeof req.body !== 'object') return res.status(400).json({ error: 'Settings must be an object.' });
  res.json(store.putSettings(req.body, req.user.username));
});

/* ---------- admin ---------- */
app.get('/api/backup', auth('admin'), (req, res) => {
  const { settings, data } = store.allData();
  res.set('Content-Disposition', `attachment; filename="mamas-and-love-backup-${new Date().toISOString().slice(0, 10)}.json"`);
  res.json({ exportedAt: new Date().toISOString(), settings, ...data });
});
app.post('/api/import', auth('admin'), (req, res) => {
  const { data, mode } = req.body || {};
  if (!data || typeof data !== 'object') return res.status(400).json({ error: 'That file is not a Mamas and Love backup.' });
  if (!store.COLS.some(c => Array.isArray(data[c]))) return res.status(400).json({ error: 'That file has no records in it.' });
  res.json(store.importAll(data, { mode: mode === 'merge' ? 'merge' : 'replace', user: req.user.username }));
});
app.get('/api/audit', auth('admin'), (req, res) => res.json({ items: store.recentAudit(Number(req.query.limit) || 50) }));

app.get('/api/users', auth('admin'), (req, res) => res.json({ users: store.listUsers() }));
app.post('/api/users', auth('admin'), (req, res) => {
  const { username, name, role, password } = req.body || {};
  if (!/^[a-z0-9._-]{3,32}$/i.test(username || '')) return res.status(400).json({ error: 'Username must be 3–32 letters, numbers, dots, dashes or underscores.' });
  if (!(role in store.ROLES)) return res.status(400).json({ error: 'Choose a role.' });
  if (!password || String(password).length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  if (store.getUser(username)) return res.status(409).json({ error: 'That username is already taken.' });
  store.createUser({ username, name, role, password });
  res.json({ users: store.listUsers() });
});
app.patch('/api/users/:u', auth('admin'), (req, res) => {
  const target = store.getUser(req.params.u);
  if (!target) return res.status(404).json({ error: 'User not found.' });
  const { name, role, password } = req.body || {};
  if (role && !(role in store.ROLES)) return res.status(400).json({ error: 'Unknown role.' });
  if (password && String(password).length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  if (role && role !== 'admin' && target.role === 'admin' && store.countAdmins() <= 1) return res.status(400).json({ error: 'Keep at least one admin.' });
  store.updateUser(target.username, { name, role, password });
  res.json({ users: store.listUsers() });
});
app.delete('/api/users/:u', auth('admin'), (req, res) => {
  const target = store.getUser(req.params.u);
  if (!target) return res.status(404).json({ error: 'User not found.' });
  if (target.username === req.user.username) return res.status(400).json({ error: 'You cannot remove your own account.' });
  if (target.role === 'admin' && store.countAdmins() <= 1) return res.status(400).json({ error: 'Keep at least one admin.' });
  store.deleteUser(target.username);
  res.json({ users: store.listUsers() });
});

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));
app.get('/healthz', (req, res) => res.json({ ok: true }));

/* ---------- app ---------- */
app.use(express.static(path.join(__dirname, 'public'), { index: 'index.html', maxAge: '1h' }));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.use((err, req, res, next) => {
  console.error(err);
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'That file is too large.' });
  res.status(500).json({ error: 'Something went wrong on the server. Try again.' });
});

app.listen(PORT, () => console.log(`Mamas and Love running on http://localhost:${PORT}  (data: ${store.DB_FILE})`));
