'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { exportBundle, validateBundle, importBundle } = require('../src/bundle');
const { loadSection, readStatus } = require('../src/lib');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'tm1ref-bundle-'));
const entries = (prefix, n) => Array.from({ length: n }, (_, i) => ({ id: `${prefix}-${i}`, name: `${prefix}${i}`, category: 'C', summary: 's', syntax: `${prefix}${i}(x)` }));
const lang = (tag, fetched = '2026-10-01T00:00:00.000Z') => ({
  fetched,
  ti: { meta: { fetched }, entries: entries(`${tag}t`, 110) },
  rules: { meta: { fetched }, entries: entries(`${tag}r`, 60) },
});
const bundleOf = (languages) => ({ format: 'tm1-reference-docs', version: 1, docsVersion: '2.1.0', created: '2026-10-02T00:00:00.000Z', languages });

test('importBundle: installs all sections and a readable status', async () => {
  const dir = path.join(tmp(), 'docs');
  const summary = await importBundle(bundleOf({ en: lang('e'), de: lang('d') }), dir);
  assert.deepStrictEqual(summary.counts, { en: { ti: 110, rules: 60 }, de: { ti: 110, rules: 60 } });
  assert.strictEqual(loadSection(dir, 'de', 'rules').entries.length, 60);
  const status = readStatus(dir);
  assert.strictEqual(status.version, '2.1.0');
  assert.strictEqual(status.languages.en.fetched, '2026-10-01T00:00:00.000Z');
  assert.deepStrictEqual(fs.readdirSync(path.dirname(dir)), ['docs'], 'no temp directory left');
});

test('importBundle: languages missing in the file stay as installed, those in the file are replaced', async () => {
  const dir = path.join(tmp(), 'docs');
  await importBundle(bundleOf({ en: lang('old-e', '2026-09-01T00:00:00.000Z'), de: lang('old-d', '2026-09-02T00:00:00.000Z') }), dir);
  const summary = await importBundle(bundleOf({ en: lang('new-e', '2026-10-01T00:00:00.000Z') }), dir);
  assert.strictEqual(loadSection(dir, 'en', 'ti').entries[0].id, 'new-et-0');
  assert.strictEqual(loadSection(dir, 'de', 'ti').entries[0].id, 'old-dt-0', 'German untouched');
  assert.deepStrictEqual(summary.counts.de, { ti: 110, rules: 60 });
  assert.strictEqual(summary.languages.de.fetched, '2026-09-02T00:00:00.000Z', 'German keeps its own date');
  assert.strictEqual(summary.languages.en.fetched, '2026-10-01T00:00:00.000Z');
  assert.deepStrictEqual(summary.imported, ['en']);
});

test('validateBundle: rejects anything that is not a usable documentation file', () => {
  const ok = bundleOf({ en: lang('e') });
  assert.deepStrictEqual(validateBundle(ok), ['en']);
  assert.throws(() => validateBundle(null), /Not a TM1 Reference/);
  assert.throws(() => validateBundle({ foo: 1 }), /Not a TM1 Reference/);
  assert.throws(() => validateBundle({ ...ok, version: 2 }), /Unsupported file version 2/);
  assert.throws(() => validateBundle({ ...ok, languages: {} }), /no documentation/);
  assert.throws(() => validateBundle({ ...ok, languages: { fr: lang('x') } }), /no documentation/);
  assert.throws(() => validateBundle(bundleOf({ en: { ...lang('e'), ti: { entries: entries('t', 5) } } })), /en\/ti: expected at least 100 entries, found 5/);
  assert.throws(() => validateBundle(bundleOf({ en: { ...lang('e'), rules: undefined } })), /en\/rules: expected at least 50 entries, found 0/);
  assert.throws(() => validateBundle(bundleOf({ en: { ...lang('e'), ti: { entries: [...entries('t', 120), { name: 'no id' }] } } })), /entries without id or name/);
});

test('importBundle: an invalid file leaves the installed documentation untouched', async () => {
  const dir = path.join(tmp(), 'docs');
  await importBundle(bundleOf({ en: lang('keep') }), dir);
  await assert.rejects(importBundle(bundleOf({ en: { ...lang('x'), ti: { entries: [] } } }), dir), /en\/ti/);
  assert.strictEqual(loadSection(dir, 'en', 'ti').entries[0].id, 'keept-0');
  assert.deepStrictEqual(fs.readdirSync(path.dirname(dir)), ['docs']);
});

test('exportBundle -> importBundle round trip', async () => {
  const source = path.join(tmp(), 'docs');
  await importBundle(bundleOf({ en: lang('e'), de: lang('d', '2026-09-30T00:00:00.000Z') }), source);
  const exported = JSON.parse(JSON.stringify(exportBundle(source))); // as written to / read from a file
  assert.strictEqual(exported.format, 'tm1-reference-docs');
  assert.deepStrictEqual(Object.keys(exported.languages), ['en', 'de']);
  assert.strictEqual(exported.languages.de.fetched, '2026-09-30T00:00:00.000Z');

  const target = path.join(tmp(), 'docs');
  await importBundle(exported, target);
  for (const l of ['en', 'de']) for (const s of ['ti', 'rules']) {
    assert.deepStrictEqual(loadSection(target, l, s).entries, loadSection(source, l, s).entries);
  }
  assert.strictEqual(readStatus(target).languages.de.fetched, '2026-09-30T00:00:00.000Z');
});

test('exportBundle: only complete languages are exported; nothing to export is an error', () => {
  assert.throws(() => exportBundle(path.join(tmp(), 'nothing')), /No documentation found/);
  const dir = tmp();
  fs.mkdirSync(path.join(dir, 'en'));
  fs.writeFileSync(path.join(dir, 'en', 'ti.json'), JSON.stringify({ meta: {}, entries: entries('t', 110) })); // rules missing
  assert.throws(() => exportBundle(dir), /No documentation found/);
});
