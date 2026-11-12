'use strict';
// Load the example records (tagged "example"; remove them from Settings). Only for demos.
const fs = require('fs');
const path = require('path');
const { importAll, COLS } = require('../lib/db');
const dir = path.join(__dirname, '..', 'seed-demo');
const data = {}; COLS.forEach(c => (data[c] = []));
for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.json'))) {
  const m = f.match(/^([a-z]+)-(.+)\.json$/); if (!m || !data[m[1]]) continue;
  data[m[1]].push({ id: m[2], ...JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) });
}
const out = importAll(data, { mode: 'merge', user: 'demo-seed' });
console.log(`Loaded ${out.count} example records.`);
