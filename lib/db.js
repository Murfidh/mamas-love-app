'use strict';
// SQLite storage (built into Node 22.5+, no native build needed).
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_FILE = path.join(DATA_DIR, 'mamas-love.db');

const COLS = ['products', 'costs', 'prices', 'suppliers', 'customers', 'purchases', 'grns', 'invoices', 'collections', 'payments', 'adjustments'];
const ROLES = { viewer: 0, staff: 1, admin: 2 };

const db = new DatabaseSync(DB_FILE);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA busy_timeout = 5000;
  CREATE TABLE IF NOT EXISTS docs (
    col TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL,
    updated_at TEXT NOT NULL, updated_by TEXT,
    PRIMARY KEY (col, id)
  );
  CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK (id = 1), body TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS users (
    username TEXT PRIMARY KEY, name TEXT, role TEXT NOT NULL,
    pass TEXT NOT NULL, created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
  CREATE TABLE IF NOT EXISTS audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, username TEXT,
    action TEXT NOT NULL, col TEXT, doc_id TEXT, label TEXT
  );
`);

const now = () => new Date().toISOString();
const getMeta = k => { const r = db.prepare('SELECT v FROM meta WHERE k = ?').get(k); return r ? r.v : null; };
const setMeta = (k, v) => db.prepare('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(k, String(v));

function rev() { return Number(getMeta('rev') || 0); }
function bump() { const r = rev() + 1; setMeta('rev', r); return r; }

function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const out = fn(); db.exec('COMMIT'); return out; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}

function audit(username, action, col, id, label) {
  db.prepare('INSERT INTO audit (at, username, action, col, doc_id, label) VALUES (?, ?, ?, ?, ?, ?)')
    .run(now(), username || null, action, col || null, id || null, label ? String(label).slice(0, 200) : null);
}

/* ---------- documents ---------- */
const labelOf = (body, id) => body && (body.no || body.name || body.label || body.sku) || id;

function allData() {
  const data = {}; COLS.forEach(c => (data[c] = []));
  for (const r of db.prepare('SELECT col, id, body FROM docs').all()) {
    if (data[r.col]) data[r.col].push({ id: r.id, ...JSON.parse(r.body) });
  }
  const s = db.prepare('SELECT body FROM settings WHERE id = 1').get();
  return { rev: rev(), settings: s ? JSON.parse(s.body) : {}, data };
}

function getDoc(col, id) {
  const r = db.prepare('SELECT body FROM docs WHERE col = ? AND id = ?').get(col, id);
  return r ? JSON.parse(r.body) : null;
}

function numberTaken(col, id, no) {
  if (!no) return false;
  return !!db.prepare("SELECT 1 FROM docs WHERE col = ? AND id <> ? AND json_extract(body, '$.no') = ?").get(col, id, String(no));
}

function putDoc(col, id, body, user) {
  return tx(() => {
    const prev = rev();
    const existed = !!getDoc(col, id);
    db.prepare(`INSERT INTO docs (col, id, body, updated_at, updated_by) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(col, id) DO UPDATE SET body = excluded.body, updated_at = excluded.updated_at, updated_by = excluded.updated_by`)
      .run(col, id, JSON.stringify(body), now(), user || null);
    audit(user, existed ? 'updated' : 'created', col, id, labelOf(body, id));
    return { prev, rev: bump() };
  });
}

function patchDoc(col, id, patch, user) {
  return tx(() => {
    const cur = getDoc(col, id);
    if (!cur) return null;
    const prev = rev();
    const body = { ...cur, ...patch, updatedAt: now() };
    db.prepare('UPDATE docs SET body = ?, updated_at = ?, updated_by = ? WHERE col = ? AND id = ?').run(JSON.stringify(body), now(), user || null, col, id);
    const what = patch.chequeStatus ? `cheque ${patch.chequeStatus.toLowerCase()}` : 'updated';
    audit(user, what, col, id, labelOf(body, id));
    return { prev, rev: bump() };
  });
}

function deleteDoc(col, id, user) {
  return tx(() => {
    const cur = getDoc(col, id);
    const prev = rev();
    db.prepare('DELETE FROM docs WHERE col = ? AND id = ?').run(col, id);
    if (cur) audit(user, 'deleted', col, id, labelOf(cur, id));
    return { prev, rev: bump() };
  });
}

function putSettings(body, user) {
  return tx(() => {
    const prev = rev();
    db.prepare('INSERT INTO settings (id, body, updated_at) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET body = excluded.body, updated_at = excluded.updated_at')
      .run(JSON.stringify(body), now());
    audit(user, 'updated', 'settings', 'main', 'Settings');
    return { prev, rev: bump() };
  });
}

/** Replace (or merge) everything from a backup object shaped like the app's JSON backup. */
function importAll(backup, { mode = 'replace', user } = {}) {
  return tx(() => {
    const prev = rev();
    if (mode === 'replace') db.exec('DELETE FROM docs');
    const ins = db.prepare(`INSERT INTO docs (col, id, body, updated_at, updated_by) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(col, id) DO UPDATE SET body = excluded.body, updated_at = excluded.updated_at, updated_by = excluded.updated_by`);
    let n = 0;
    for (const col of COLS) {
      const rows = Array.isArray(backup[col]) ? backup[col] : [];
      for (const r of rows) {
        if (!r || typeof r !== 'object' || !validId(r.id)) continue;
        const { id, ...body } = r;
        ins.run(col, id, JSON.stringify(body), now(), user || null); n++;
      }
    }
    if (backup.settings && typeof backup.settings === 'object') {
      const { id, ...s } = backup.settings;
      db.prepare('INSERT INTO settings (id, body, updated_at) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET body = excluded.body, updated_at = excluded.updated_at').run(JSON.stringify(s), now());
    }
    audit(user, mode === 'replace' ? 'restored backup' : 'merged backup', null, null, `${n} records`);
    return { prev, rev: bump(), count: n };
  });
}

function recentAudit(limit = 50) {
  return db.prepare('SELECT at, username, action, col, doc_id, label FROM audit ORDER BY id DESC LIMIT ?').all(Math.min(500, limit));
}

/* ---------- users ---------- */
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(pw), salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}
function verifyPassword(pw, stored) {
  const [alg, saltHex, hashHex] = String(stored).split('$');
  if (alg !== 'scrypt') return false;
  const want = Buffer.from(hashHex, 'hex');
  const got = crypto.scryptSync(String(pw), Buffer.from(saltHex, 'hex'), want.length);
  return crypto.timingSafeEqual(want, got);
}
const publicUser = u => u && ({ username: u.username, name: u.name || '', role: u.role, createdAt: u.created_at });
const getUser = username => db.prepare('SELECT * FROM users WHERE username = ?').get(String(username || '').toLowerCase());
const listUsers = () => db.prepare('SELECT * FROM users ORDER BY username').all().map(publicUser);
const countAdmins = () => db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").get().n;

function createUser({ username, name, role, password }) {
  db.prepare('INSERT INTO users (username, name, role, pass, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(String(username).toLowerCase(), name || '', role, hashPassword(password), now());
}
function updateUser(username, { name, role, password }) {
  const u = getUser(username); if (!u) return false;
  db.prepare('UPDATE users SET name = ?, role = ?, pass = ? WHERE username = ?')
    .run(name != null ? name : u.name, role || u.role, password ? hashPassword(password) : u.pass, u.username);
  return true;
}
const deleteUser = username => db.prepare('DELETE FROM users WHERE username = ?').run(String(username).toLowerCase());

/** First start: create the admin account from env, or a random password printed once to the log. */
function ensureAdmin() {
  if (db.prepare('SELECT COUNT(*) AS n FROM users').get().n > 0) return;
  const username = (process.env.ADMIN_USER || 'admin').toLowerCase();
  let password = process.env.ADMIN_PASSWORD;
  if (!password) {
    password = crypto.randomBytes(9).toString('base64url');
    console.log('\n==================================================');
    console.log(' First admin account created');
    console.log(`   username: ${username}`);
    console.log(`   password: ${password}`);
    console.log(' Sign in and change it under Settings > Your account.');
    console.log('==================================================\n');
  }
  createUser({ username, name: 'Administrator', role: 'admin', password });
}

function sessionSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  let s = getMeta('session_secret');
  if (!s) { s = crypto.randomBytes(32).toString('hex'); setMeta('session_secret', s); }
  return s;
}

const validId = id => typeof id === 'string' && /^[A-Za-z0-9_\-.~:@+]{1,120}$/.test(id);

module.exports = {
  db, DB_FILE, DATA_DIR, COLS, ROLES, validId,
  allData, getDoc, putDoc, patchDoc, deleteDoc, putSettings, importAll, numberTaken, rev, recentAudit,
  getUser, listUsers, createUser, updateUser, deleteUser, countAdmins, verifyPassword, publicUser, ensureAdmin, sessionSecret,
};
