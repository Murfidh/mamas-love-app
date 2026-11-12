'use strict';
// Load a JSON backup (from Settings > Download full backup, including the claude.ai version):
//   node scripts/import.js backup.json            replaces all records
//   node scripts/import.js backup.json --merge    adds/updates without deleting
const fs = require('fs');
const { importAll } = require('../lib/db');
const file = process.argv[2];
if (!file) { console.error('Usage: node scripts/import.js <backup.json> [--merge]'); process.exit(1); }
const data = JSON.parse(fs.readFileSync(file, 'utf8'));
const out = importAll(data, { mode: process.argv.includes('--merge') ? 'merge' : 'replace', user: 'cli' });
console.log(`Imported ${out.count} records.`);
