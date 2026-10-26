// Writes the documentation in ./data (see npm run fetch-docs) as one file that
// "TM1 Reference: Import Documentation from File" can read, e.g. for a machine that cannot reach IBM.
//   node scripts/export-docs.js [output-file]
'use strict';
const fs = require('fs');
const path = require('path');
const { exportBundle } = require('../src/bundle');

const root = path.join(__dirname, '..');
const bundle = exportBundle(path.join(root, 'data'));
const out = path.resolve(process.argv[2] || path.join(root, `tm1-reference-docs-${bundle.docsVersion}.json`));
fs.writeFileSync(out, JSON.stringify(bundle));
const counts = Object.entries(bundle.languages).map(([l, v]) => `${l}: ${v.ti.entries.length} TI / ${v.rules.entries.length} Rules`);
console.log(`${out} (${(fs.statSync(out).size / 1024 / 1024).toFixed(2)} MB; ${counts.join(', ')})`);
