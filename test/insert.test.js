'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { chooseInsertTarget } = require('../src/insert-target');

const ed = (uri, viewColumn = 1) => ({ uri, viewColumn });

test('text tab active -> insert into that editor', () => {
  const r = chooseInsertTarget({
    activeTab: { kind: 'text', uri: 'file:///a.pro', viewColumn: 2 },
    visibleEditors: [ed('file:///a.pro', 2), ed('file:///b.rux', 1)],
    lastEditor: ed('file:///b.rux', 1),
  });
  assert.deepStrictEqual(r, { type: 'text', uri: 'file:///a.pro', viewColumn: 2 });
});

test("someone else's webview tab active -> paste, even if a text editor is visible", () => {
  const r = chooseInsertTarget({
    activeTab: { kind: 'webview', ownPanel: false },
    visibleEditors: [ed('file:///b.rux', 1)],
    lastEditor: ed('file:///b.rux', 1),
  });
  assert.deepStrictEqual(r, { type: 'paste' });
});

test('own reference panel active -> last used visible text editor', () => {
  const r = chooseInsertTarget({
    activeTab: { kind: 'webview', ownPanel: true },
    visibleEditors: [ed('file:///b.rux', 1)],
    lastEditor: ed('file:///b.rux', 1),
  });
  assert.deepStrictEqual(r, { type: 'text', uri: 'file:///b.rux', viewColumn: 1 });
});

test('last editor no longer visible -> none', () => {
  assert.deepStrictEqual(
    chooseInsertTarget({ activeTab: null, visibleEditors: [], lastEditor: ed('file:///gone', 1) }),
    { type: 'none' }
  );
  assert.deepStrictEqual(chooseInsertTarget({ activeTab: { kind: 'other' }, visibleEditors: [], lastEditor: null }), { type: 'none' });
});

test('editor moved to another column is still found by uri', () => {
  const r = chooseInsertTarget({
    activeTab: { kind: 'text', uri: 'file:///a.pro', viewColumn: 1 },
    visibleEditors: [ed('file:///a.pro', 3)],
    lastEditor: null,
  });
  assert.deepStrictEqual(r, { type: 'text', uri: 'file:///a.pro', viewColumn: 3 });
});
