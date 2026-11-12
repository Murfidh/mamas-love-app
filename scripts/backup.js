'use strict';
// Consistent snapshot of the live database: node scripts/backup.js [output-folder]
const path = require('path');
const fs = require('fs');
const { db, DATA_DIR } = require('../lib/db');
const dir = path.resolve(process.argv[2] || path.join(DATA_DIR, 'backups'));
fs.mkdirSync(dir, { recursive: true });
const file = path.join(dir, `mamas-love-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.db`);
db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
// keep the newest 30 snapshots
const old = fs.readdirSync(dir).filter(f => /^mamas-love-.*\.db$/.test(f)).sort().reverse().slice(30);
old.forEach(f => fs.unlinkSync(path.join(dir, f)));
console.log('Backup written:', file);
