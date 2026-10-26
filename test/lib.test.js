'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { resolveLanguage, loadSection, loadLanguage, readStatus } = require('../src/lib');
const { searchEntries } = require('../media/search');

// Full documentation downloaded for development (npm run fetch-docs); tests using it are skipped without.
const DATA = path.join(__dirname, '..', 'data');
const hasData = fs.existsSync(path.join(DATA, 'en', 'ti.json')) && fs.existsSync(path.join(DATA, 'de', 'rules.json'));
const needData = hasData ? false : 'run "npm run fetch-docs" first';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'tm1ref-'));

test('resolveLanguage: explicit setting wins', () => {
  assert.strictEqual(resolveLanguage('de', 'en-US'), 'de');
  assert.strictEqual(resolveLanguage('en', 'de'), 'en');
});

test('resolveLanguage: auto follows VS Code, defaults to en', () => {
  assert.strictEqual(resolveLanguage('auto', 'de'), 'de');
  assert.strictEqual(resolveLanguage('auto', 'de-AT'), 'de');
  assert.strictEqual(resolveLanguage('auto', 'fr'), 'en');
  assert.strictEqual(resolveLanguage('auto', undefined), 'en');
});

test('resolveLanguage: the language remembered from the view wins, then the setting, then VS Code', () => {
  assert.strictEqual(resolveLanguage('auto', 'en', 'de'), 'de');
  assert.strictEqual(resolveLanguage('en', 'en', 'de'), 'de');
  assert.strictEqual(resolveLanguage('de', 'de', 'en'), 'en');
  assert.strictEqual(resolveLanguage('de', 'en', undefined), 'de');
  assert.strictEqual(resolveLanguage('auto', 'de-DE', undefined), 'de');
  assert.strictEqual(resolveLanguage('auto', 'fr', 'fr'), 'en', 'garbage is ignored');
  assert.strictEqual(resolveLanguage('auto', 'fr', null), 'en');
});

test('loadSection: rejects unknown language/section', () => {
  assert.throws(() => loadSection(DATA, 'fr', 'ti'));
  assert.throws(() => loadSection(DATA, 'en', '../x'));
});

test('loadSection / loadLanguage / readStatus: nothing downloaded -> empty, no throw', () => {
  const dir = path.join(tmp(), 'nothing');
  const s = loadSection(dir, 'en', 'ti');
  assert.deepStrictEqual(s.entries, []);
  assert.ok(s.meta.error);
  assert.deepStrictEqual(loadLanguage(dir, 'de').rules.entries, []);
  assert.strictEqual(readStatus(dir), null);
});

test('loadSection / readStatus read what the download wrote', () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, 'en'));
  fs.writeFileSync(path.join(dir, 'en', 'ti.json'), JSON.stringify({ meta: { v: 1 }, entries: [{ id: 'a', name: 'A' }] }));
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ fetched: '2026-10-02T00:00:00Z', version: '2.1.0', counts: { en: { ti: 1 } } }));
  assert.deepStrictEqual(loadSection(dir, 'en', 'ti').entries, [{ id: 'a', name: 'A' }]);
  assert.deepStrictEqual(readStatus(dir), { fetched: '2026-10-02T00:00:00Z', version: '2.1.0', counts: { en: { ti: 1 } }, languages: {} });
  fs.writeFileSync(path.join(dir, 'en', 'ti.json'), '{ broken');
  assert.deepStrictEqual(loadSection(dir, 'en', 'ti').entries, [], 'corrupt file -> empty section');
});

for (const lang of ['en', 'de']) {
  test(`downloaded data (${lang}) is complete and consistent`, { skip: needData }, () => {
    const data = loadLanguage(DATA, lang);
    assert.ok(data.ti.entries.length > 250, 'TI entries');
    assert.ok(data.rules.entries.length > 100, 'Rules entries');
    for (const section of ['ti', 'rules']) {
      const { entries, meta } = data[section];
      assert.ok(!meta.sample && !meta.error);
      assert.strictEqual(new Set(entries.map((e) => e.id)).size, entries.length, 'unique ids');
      for (const e of entries) {
        assert.ok(e.id && e.name && e.category && (e.description || e.summary), `${lang}/${section}/${e.id}`);
        assert.ok(!/<\/?(p|div|span|a|br|table|td|tr|pre|code|ul|li|strong|em)[\s>\/]/i.test(JSON.stringify(e)), `html left in ${e.id}`);
      }
    }
    const byName = (s, n) => data[s].entries.find((e) => e.name === n);
    assert.match(byName('ti', 'CellPutN').syntax, /^CellPutN\(/);
    assert.ok(byName('ti', 'CellPutN').params.length >= 3);
    assert.ok(byName('ti', 'CellPutN').examples.length >= 1);
    assert.match(byName('rules', 'DB').syntax, /^DB\(/);
    assert.ok(byName('rules', 'DB').params.length >= 2);
  });
}

// ---- search (self-contained entries) ---------------------------------------------------------

const E = (name, category, summary, extra = {}) => ({ id: name.toLowerCase(), name, category, summary, syntax: `${name}(x)`, description: summary, ...extra });
const SAMPLE = [
  E('CellGetN', 'Cube', 'Returns a numeric value from a cube cell.'),
  E('CellGetS', 'Cube', 'Returns a string value from a cube cell.'),
  E('CellPutN', 'Cube', 'Sends a numeric value to a cube cell.'),
  E('CellIncrementN', 'Cube', 'Increments a numeric cell value.'),
  E('CellPutProportionalSpread', 'Cube', 'Spreads a value proportionally.'),
  E('ASCIIOutput', 'File', 'Writes a record to a text file.', { examples: [{ code: "ASCIIOutput('f.csv', 'CellPutN');" }] }),
  E('CubeSaveData', 'Cube', 'Saves cube data.'),
];
const names = (q) => searchEntries(SAMPLE, q).map((e) => e.name);

test('searchEntries: ranking, multi-term, empty query', () => {
  assert.strictEqual(searchEntries(SAMPLE, '').length, SAMPLE.length);
  assert.strictEqual(names('cellputn')[0], 'CellPutN');
  assert.strictEqual(names('CELLGETN')[0], 'CellGetN');
  assert.deepStrictEqual(names('cell numeric').sort(), ['CellGetN', 'CellIncrementN', 'CellPutN']);
  assert.deepStrictEqual(names('zzzzqqq'), []);
});

test('searchEntries: * and ? wildcards', () => {
  const star = names('Cell*N');
  assert.deepStrictEqual(star.slice(0, 3).sort(), ['CellGetN', 'CellIncrementN', 'CellPutN'], 'whole-name matches first');
  assert.ok(!star.slice(0, 3).includes('CellGetS'));
  assert.ok(names('*put*').includes('CellPutN'));
  assert.ok(names('cell??tn').includes('CellPutN'));
  assert.ok(!names('cell?tn').includes('CellPutN'));
  assert.strictEqual(searchEntries(SAMPLE, '*').length, SAMPLE.length);
  assert.doesNotThrow(() => searchEntries(SAMPLE, 'a(b[c'));
  assert.doesNotThrow(() => searchEntries(SAMPLE, '(*'));
});

test('searchEntries: wildcard in description text matches inside one word only', () => {
  const entries = [E('One', 'X', 'alpha beta gamma'), E('Two', 'X', 'alphaXbeta gamma')];
  assert.deepStrictEqual(searchEntries(entries, 'alpha*beta').map((e) => e.name), ['Two'], 'not across the space');
  assert.deepStrictEqual(searchEntries(entries, 'gam?a').map((e) => e.name).sort(), ['One', 'Two']);
});

test('searchEntries finds German content', () => {
  const de = [E('CellPutN', 'Würfelfunktionen', 'Schreibt einen numerischen Wert in eine Cube-Zelle.')];
  assert.ok(searchEntries(de, 'numerischen Wert Cube-Zelle').some((e) => e.name === 'CellPutN'));
});
