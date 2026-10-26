'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const fixture = (n) => fs.readFileSync(path.join(__dirname, 'fixtures', n), 'utf8');
const info = { id: 'x', category: 'Cat', source: 'src' };
const load = async () => require('../src/parse-page');

test('parsePage: syntax in <pre>, args table, example', async () => {
  const { parsePage } = await load();
  const e = parsePage(fixture('cellputn-en.html'), info);
  assert.strictEqual(e.name, 'CellPutN');
  assert.strictEqual(e.syntax, 'CellPutN(x, Cube, e1, e2 [,..., en]);');
  assert.deepStrictEqual(e.params.map((p) => p.name), ['x', 'Cube', 'e1, e2, ..., en']);
  assert.match(e.description, /^This function is valid/);
  assert.match(e.description, /Note: If you supply invalid arguments/);
  assert.strictEqual(e.examples.length, 1);
  assert.match(e.examples[0].code, /^CellPutN\(12345/);
  assert.match(e.examples[0].description, /sends the value 12345/);
});

test('parsePage: bare <code> syntax (Sleep)', async () => {
  const { parsePage } = await load();
  const e = parsePage(fixture('sleep-en.html'), info);
  assert.strictEqual(e.syntax, 'Sleep(ms);');
  assert.deepStrictEqual(e.params.map((p) => p.name), ['ms']);
  assert.match(e.examples[0].code, /sleep \( 3000 \);/);
});

test('parsePage: <dl> parameters (DB)', async () => {
  const { parsePage } = await load();
  const e = parsePage(fixture('db-en.html'), info);
  assert.match(e.syntax, /^DB\(cube, e1/);
  assert.deepStrictEqual(e.params.map((p) => p.name), ['cube', 'e1,...en']);
  assert.match(e.params[1].description, /sequence-sensitive/);
});

// IBM changed the page markup in 10/2026: tables directly in the section, note__title/note__body.
// Both layouts must give the same result.
test('parsePage: newer page markup (table without wrapper, note__title) gives the same entry', async () => {
  const { parsePage } = await load();
  const e = parsePage(fixture('cellputn-en-2026-10.html'), info);
  assert.strictEqual(e.syntax, 'CellPutN(x, Cube, e1, e2 [,..., en]);');
  assert.deepStrictEqual(e.params.map((p) => p.name), ['x', 'Cube', 'e1, e2, ..., en']);
  assert.match(e.description, /Note: If you supply invalid arguments/);
  assert.doesNotMatch(e.description, /^x — /m, 'arguments are not duplicated into the description');
  assert.strictEqual(e.examples.length, 1);
  const old = parsePage(fixture('cellputn-en.html'), info);
  assert.deepStrictEqual(e, old);
});

test('parsePage: newer markup, bare <code> syntax and <dl> parameters', async () => {
  const { parsePage } = await load();
  const sleep = parsePage(fixture('sleep-en-2026-10.html'), info);
  assert.strictEqual(sleep.syntax, 'Sleep(ms);');
  assert.deepStrictEqual(sleep.params.map((p) => p.name), ['ms']);
  const db = parsePage(fixture('db-en-2026-10.html'), info);
  assert.deepStrictEqual(db.params.map((p) => p.name), ['cube', 'e1,...en']);
});

// ---- navigation: child links and page title ----------------------------------------------------------

test('childLinks: order kept, duplicates dropped, relative paths resolved, external links ignored', async () => {
  const { childLinks } = await load();
  const li = (href, label) => `<li class="ulchildlink"><strong><a href="${href}">${label}</a></strong><br>desc</li>`;
  const html = `<aside><ul class="ullinks">${li('c_a.html', 'A')}${li('c_b.html', ' B   b ')}${li('c_a.html', 'A')}${li('c_b.html', 'B')}
    ${li('../x/c_c.html#frag', 'C')}${li('https://example.com/x', 'ext')}${li('#top', 'top')}${li('mailto:a@b.c', 'mail')}${li('', 'empty')}</ul>
    <ul><li class="link"><a href="related.html">related</a></li></ul></aside>`;
  assert.deepStrictEqual(childLinks(html, 'c_root.html'), [
    { path: 'c_a.html', label: 'A' },
    { path: 'c_b.html', label: 'B b' },
    { path: 'x/c_c.html', label: 'C' },
  ]);
  assert.deepStrictEqual(childLinks(html, 'folder/c_root.html').map((l) => l.path), ['folder/c_a.html', 'folder/c_b.html', 'x/c_c.html']);
  assert.deepStrictEqual(childLinks('<html><h1>no children</h1></html>', 'c_root.html'), []);
});

test('childLinks and pageTitle on real pages', async () => {
  const { childLinks, pageTitle } = await load();
  assert.strictEqual(pageTitle(fixture('cellputn-en.html')), 'CellPutN');
  assert.strictEqual(pageTitle(fixture('cellputn-en-2026-10.html')), 'CellPutN');
  assert.strictEqual(pageTitle('<p>no heading</p>'), '');
  assert.strictEqual(pageTitle('<h1> A   <span>B</span> </h1>'), 'A B');
  assert.deepStrictEqual(childLinks(fixture('cellputn-en.html'), 'x.html'), [], 'a function page lists no children');
});
