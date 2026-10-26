'use strict';
// Runs src/extension.js against a minimal fake `vscode` module and checks what "Insert" does.
const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');
const path = require('path');
const fs = require('fs');
const os = require('os');

class TabInputText { constructor(uri) { this.uri = uri; } }
class TabInputWebview { constructor(viewType) { this.viewType = viewType; } }
class TabInputCustom { constructor(viewType) { this.viewType = viewType; } }
class SnippetString { constructor(value) { this.value = value; } }

// tm1Insert: how the (optional) TM1 IDE command `tm1.editor.insertText` behaves:
//   'missing' (older TM1 IDE: command not found), true / false (return value).
function setup({ activeTab = null, editors = [], activeTextEditor, tm1Insert = 'missing', settings = {}, updateDocs, picked, probes = [], remembered, vscodeLanguage = 'en' } = {}) {
  const calls = { edits: [], snippets: [], commands: [], commandArgs: [], clipboard: [], info: [], warnings: [], errors: [], shown: [], posted: [], updateDocs: [], log: [], dialogs: [], outputShown: 0 };
  const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'tm1ref-ext-'));
  const handlers = {};
  const store = remembered ? { language: remembered } : {};
  const configListeners = [];
  const updateOptions = [];
  class CancelledError extends Error {}
  let viewProvider;
  const makeEditor = (uri, viewColumn, languageId, selections) => ({
    viewColumn,
    selections,
    document: { uri: { scheme: 'file', toString: () => uri }, languageId },
    insertSnippet: async (snip) => { calls.snippets.push({ uri, value: snip.value }); return true; },
    edit: async (fn) => {
      fn({ replace: (sel, text) => calls.edits.push({ uri, sel, text }) });
      return true;
    },
  });
  const visible = editors.map((e) => makeEditor(e.uri, e.viewColumn, e.languageId, e.selections || ['sel']));
  const fake = {
    TabInputText, TabInputWebview, TabInputCustom, SnippetString,
    version: '1.99.0',
    ViewColumn: { Beside: -2 },
    ProgressLocation: { Notification: 15 },
    ConfigurationTarget: { Global: 1 },
    Uri: { joinPath: (base, ...p) => ({ fsPath: path.join(base.fsPath, ...p), toString: () => p.join('/') }) },
    Disposable: { from: (...d) => ({ dispose() {} }) },
    env: { language: vscodeLanguage, remoteName: undefined, clipboard: { writeText: async (t) => calls.clipboard.push(t) } },
    workspace: {
      getConfiguration: () => ({ get: (k, d) => (k in settings ? settings[k] : d), update: async () => {} }),
      onDidChangeConfiguration: (fn) => { configListeners.push(fn); return { dispose() {} }; },
    },
    commands: {
      registerCommand: (id, fn) => { handlers[id] = fn; return { dispose() {} }; },
      executeCommand: async (c, ...args) => {
        calls.commands.push(c);
        calls.commandArgs.push(args);
        if (c === 'tm1.editor.insertText') {
          if (tm1Insert === 'missing') throw new Error(`command '${c}' not found`);
          return tm1Insert;
        }
      },
    },
    window: {
      activeTextEditor: activeTextEditor !== undefined ? visible[activeTextEditor] : undefined,
      visibleTextEditors: visible,
      tabGroups: { activeTabGroup: { activeTab } },
      onDidChangeActiveTextEditor: () => ({ dispose() {} }),
      registerWebviewViewProvider: (_id, p) => { viewProvider = p; return { dispose() {} }; },
      createOutputChannel: () => ({ appendLine: (l) => calls.log.push(l), show: () => calls.outputShown++ }),
      showOpenDialog: async (opts) => { calls.dialogs.push(opts); return picked; },
      setStatusBarMessage: () => {},
      showInformationMessage: (m) => calls.info.push(m),
      showErrorMessage: (m) => calls.errors.push(m),
      showWarningMessage: (m) => calls.warnings.push(m),
      withProgress: async (_opts, task) => task({ report() {} }, { isCancellationRequested: false }),
      showTextDocument: async (doc, opts) => calls.shown.push({ doc, opts }),
    },
  };
  const origLoad = Module._load;
  const fakeDocs = {
    CancelledError,
    updateDocs: async (dir, opts) => {
      calls.updateDocs.push(dir);
      updateOptions.push(opts);
      return updateDocs ? updateDocs(dir, opts, { CancelledError, storage }) : { counts: { [opts.languages[0]]: { ti: 1, rules: 2 } } };
    },
  };
  const fromExtension = (parent) => parent && /extension\.js$/.test(parent.filename);
  Module._load = function (request, parent, ...rest) {
    if (request === 'vscode') return fake;
    if (request === './docs' && fromExtension(parent)) return fakeDocs;
    if (request === './diagnose' && fromExtension(parent)) return { ...origLoad.call(this, request, parent, ...rest), runProbes: async () => probes };
    return origLoad.call(this, request, parent, ...rest);
  };
  const extPath = require.resolve('../src/extension');
  delete require.cache[extPath];
  const ext = require('../src/extension');
  Module._load = origLoad;

  ext.activate({
    subscriptions: [],
    extensionUri: { fsPath: path.join(__dirname, '..') },
    globalStorageUri: { fsPath: storage },
    globalState: { get: (k) => store[k], update: async (k, v) => { if (v === undefined) delete store[k]; else store[k] = v; } },
  });

  let onMessage;
  const view = {
    webview: { options: {}, html: '', cspSource: 'x', asWebviewUri: (u) => u, postMessage: (m) => calls.posted.push(m), onDidReceiveMessage: (fn) => { onMessage = fn; return { dispose() {} }; } },
    onDidDispose() {},
  };
  viewProvider.resolveWebviewView(view);
  return { calls, storage, store, updateOptions, changeConfig: async (key) => { for (const fn of configListeners) await fn({ affectsConfiguration: (k) => k === key }); }, run: (id) => handlers[id](), message: (msg) => onMessage(msg), insert: (text, extra = {}) => onMessage({ type: 'insert', text, ...extra }) };
}

const tabOf = (input, viewColumn = 1) => ({ input, label: 't', group: { viewColumn } });

test('insert: active text editor (language ti) gets the text at every cursor, clipboard untouched', async () => {
  const t = setup({
    activeTab: tabOf(new TabInputText({ toString: () => 'file:///p.pro' }), 1),
    editors: [{ uri: 'file:///p.pro', viewColumn: 1, languageId: 'ti', selections: ['s1', 's2'] }],
  });
  await t.insert("CellPutN(1, 'c', 'e');");
  assert.deepStrictEqual(t.calls.edits.map((e) => [e.sel, e.text]), [['s1', "CellPutN(1, 'c', 'e');"], ['s2', "CellPutN(1, 'c', 'e');"]]);
  assert.strictEqual(t.calls.clipboard.length, 0);
  assert.strictEqual(t.calls.shown.length, 1, 'editor is focused afterwards');
});

test('insert: webview editor, TM1 IDE command missing (older version) -> clipboard, focus editor group, paste', async () => {
  const t = setup({
    activeTab: tabOf(new TabInputWebview('mainThreadWebview-tm1.processEditor')),
    editors: [{ uri: 'file:///other.txt', viewColumn: 2, languageId: 'plaintext' }],
  });
  await t.insert('ASCIIOutput(f, a);');
  assert.deepStrictEqual(t.calls.clipboard, ['ASCIIOutput(f, a);']);
  assert.deepStrictEqual(t.calls.commands, [
    'tm1.editor.insertText',
    'workbench.action.focusActiveEditorGroup',
    'editor.action.clipboardPasteAction',
  ]);
  assert.strictEqual(t.calls.edits.length, 0, 'must not edit an unrelated text editor');
});

test('insert: custom editor is treated like a webview editor', async () => {
  const t = setup({ activeTab: tabOf(new TabInputCustom('some.customEditor')) });
  await t.insert('x');
  assert.deepStrictEqual(t.calls.commands.slice(-1), ['editor.action.clipboardPasteAction']);
});

test('insert: nothing to insert into -> clipboard plus message', async () => {
  const t = setup({ activeTab: null, editors: [] });
  await t.insert('x');
  assert.deepStrictEqual(t.calls.clipboard, ['x']);
  assert.strictEqual(t.calls.info.length, 1);
  assert.deepStrictEqual(t.calls.commands, ['tm1.editor.insertText'], 'only TM1 IDE command is tried, no focus/paste');
});

test('insert: reference panel active -> falls back to the last used text editor', async () => {
  const t = setup({
    activeTab: tabOf(new TabInputWebview('mainThreadWebview-tm1ReferencePanel')),
    editors: [{ uri: 'file:///r.rux', viewColumn: 1, languageId: 'tm1rules' }],
    activeTextEditor: 0,
  });
  await t.insert("['a'] = N: 1;");
  assert.strictEqual(t.calls.edits.length, 1);
  assert.strictEqual(t.calls.edits[0].uri, 'file:///r.rux');
});

const tm1Tab = () => tabOf(new TabInputWebview('mainThreadWebview-tm1ProcessEditor'));

test('insert: TM1 IDE command succeeds -> used alone, no clipboard, no paste', async () => {
  const t = setup({ activeTab: tm1Tab(), tm1Insert: true });
  await t.insert("CellPutN(1, 'Cube', 'e1');");
  assert.deepStrictEqual(t.calls.commands, ['tm1.editor.insertText']);
  assert.deepStrictEqual(t.calls.commandArgs[0], [{ text: "CellPutN(1, 'Cube', 'e1');" }]);
  assert.strictEqual(t.calls.clipboard.length, 0);
  assert.strictEqual(t.calls.info.length, 0);
});

test('insert: TM1 IDE command returns false -> clipboard fallback', async () => {
  const t = setup({ activeTab: tm1Tab(), tm1Insert: false });
  await t.insert('x');
  assert.deepStrictEqual(t.calls.clipboard, ['x']);
  assert.deepStrictEqual(t.calls.commands.slice(-1), ['editor.action.clipboardPasteAction']);
});

test('insert: only a literal true counts as success', async () => {
  const t = setup({ activeTab: tm1Tab(), tm1Insert: 'ok' });
  await t.insert('x');
  assert.deepStrictEqual(t.calls.clipboard, ['x']);
});

test('insert: reference panel open beside a TM1 editor, no text editor -> TM1 IDE command', async () => {
  const t = setup({ activeTab: tabOf(new TabInputWebview('mainThreadWebview-tm1ReferencePanel')), tm1Insert: true });
  await t.insert('x');
  assert.deepStrictEqual(t.calls.commands, ['tm1.editor.insertText']);
  assert.strictEqual(t.calls.clipboard.length, 0);
});

test('insert: active text editor never calls the TM1 IDE command', async () => {
  const t = setup({
    activeTab: tabOf(new TabInputText({ toString: () => 'file:///p.pro' }), 1),
    editors: [{ uri: 'file:///p.pro', viewColumn: 1, languageId: 'ti' }],
    tm1Insert: true,
  });
  await t.insert('x');
  assert.strictEqual(t.calls.edits.length, 1);
  assert.ok(!t.calls.commands.includes('tm1.editor.insertText'));
});

const SYNTAX = 'CellPutN(x, Cube, e1, e2 [,..., en]);';
const SNIPPET = 'CellPutN(${1:x}, ${2:Cube}, ${3:e1}, ${4:e2});$0';
const textTab = () => tabOf(new TabInputText({ toString: () => 'file:///p.pro' }), 1);
const procEditor = [{ uri: 'file:///p.pro', viewColumn: 1, languageId: 'ti' }];

test('insert syntax into a text editor -> snippet with tab stops, no plain edit', async () => {
  const t = setup({ activeTab: textTab(), editors: procEditor });
  await t.insert(SYNTAX, { kind: 'syntax', section: 'ti' });
  assert.deepStrictEqual(t.calls.snippets, [{ uri: 'file:///p.pro', value: SNIPPET }]);
  assert.strictEqual(t.calls.edits.length, 0);
});

const EXAMPLE = "CellPutN(12345, 'y2ksales', 'Actual');";
const EXAMPLE_SNIPPET = "CellPutN(${1:12345}, '${2:y2ksales}', '${3:Actual}');$0";

test('insert an example -> tab stops for the arguments of the documented function, quotes stay outside', async () => {
  const t = setup({ activeTab: textTab(), editors: procEditor });
  await t.insert(EXAMPLE, { kind: 'example', section: 'ti', name: 'CellPutN', syntax: SYNTAX });
  assert.deepStrictEqual(t.calls.snippets, [{ uri: 'file:///p.pro', value: EXAMPLE_SNIPPET }]);
  assert.strictEqual(t.calls.edits.length, 0);
});

test('insert an example that has no call of the documented function -> unchanged', async () => {
  const t = setup({ activeTab: textTab(), editors: procEditor });
  await t.insert("x = '$1';", { kind: 'example', section: 'ti', name: 'CellPutN', syntax: SYNTAX });
  assert.strictEqual(t.calls.snippets.length, 0);
  assert.strictEqual(t.calls.edits[0].text, "x = '$1';");
});

test('example call name also comes from the syntax line (name differs in case/spelling)', async () => {
  const t = setup({ activeTab: textTab(), editors: procEditor });
  await t.insert("AttrSL('Region', 'DE', 'Name');", { kind: 'example', section: 'ti', name: 'ATTRSL', syntax: 'AttrSL(DimName, ElName, AttrName);' });
  assert.strictEqual(t.calls.snippets[0].value, "AttrSL('${1:Region}', '${2:DE}', '${3:Name}');$0");
});

test('insert syntax of a rules function drops the trailing semicolon', async () => {
  const t = setup({ activeTab: textTab(), editors: procEditor });
  await t.insert('CellValueN(cube, element1,..., elementN);', { kind: 'syntax', section: 'rules' });
  assert.strictEqual(t.calls.snippets[0].value, 'CellValueN(${1:cube}, ${2:element1})$0');
});

test('syntax that is not a plain call is inserted unchanged', async () => {
  const t = setup({ activeTab: textTab(), editors: procEditor });
  await t.insert('ChoreQuit;', { kind: 'syntax', section: 'ti' });
  assert.strictEqual(t.calls.snippets.length, 0);
  assert.strictEqual(t.calls.edits[0].text, 'ChoreQuit;');
});

test('setting insertAsSnippet=false inserts syntax and examples unchanged', async () => {
  const t = setup({ activeTab: textTab(), editors: procEditor, settings: { insertAsSnippet: false } });
  await t.insert(SYNTAX, { kind: 'syntax', section: 'ti' });
  assert.strictEqual(t.calls.snippets.length, 0);
  assert.strictEqual(t.calls.edits[0].text, SYNTAX);
  await t.insert(EXAMPLE, { kind: 'example', section: 'ti', name: 'CellPutN', syntax: SYNTAX });
  assert.strictEqual(t.calls.edits[1].text, EXAMPLE);
});

test('TM1 IDE editor gets { text: snippet, snippet: true }; plain text when there is no stop; clipboard fallback stays plain', async () => {
  const t = setup({ activeTab: tm1Tab(), tm1Insert: true });
  await t.insert(SYNTAX, { kind: 'syntax', section: 'ti' });
  assert.deepStrictEqual(t.calls.commandArgs[0], [{ text: SNIPPET, snippet: true }]);

  const e = setup({ activeTab: tm1Tab(), tm1Insert: true });
  await e.insert(EXAMPLE, { kind: 'example', section: 'ti', name: 'CellPutN', syntax: SYNTAX });
  assert.deepStrictEqual(e.calls.commandArgs[0], [{ text: EXAMPLE_SNIPPET, snippet: true }]);

  const u = setup({ activeTab: tm1Tab(), tm1Insert: true });
  await u.insert('ChoreQuit;', { kind: 'example', section: 'ti', name: 'ChoreQuit', syntax: 'ChoreQuit;' });
  assert.deepStrictEqual(u.calls.commandArgs[0], [{ text: 'ChoreQuit;' }], 'nothing to turn into a stop -> plain');

  const f = setup({ activeTab: tm1Tab(), tm1Insert: 'missing' });
  await f.insert(SYNTAX, { kind: 'syntax', section: 'ti' });
  assert.deepStrictEqual(f.calls.clipboard, [SYNTAX], 'clipboard fallback gets the readable syntax, not snippet markup');
});

// ---- documentation download -------------------------------------------------------------------

test('ready: nothing downloaded yet -> empty data and no status', async () => {
  const t = setup();
  await t.message({ type: 'ready' });
  const m = t.calls.posted.at(-1);
  assert.strictEqual(m.type, 'data');
  assert.strictEqual(m.status, null);
  assert.deepStrictEqual(m.data.ti.entries, []);
  assert.strictEqual(m.busy, false);
});

test('ready: downloaded documentation in the storage directory is served', async () => {
  const t = setup();
  const docs = path.join(t.storage, 'docs');
  fs.mkdirSync(path.join(docs, 'en'), { recursive: true });
  fs.writeFileSync(path.join(docs, 'en', 'ti.json'), JSON.stringify({ meta: {}, entries: [{ id: 'a', name: 'A' }] }));
  fs.writeFileSync(path.join(docs, 'meta.json'), JSON.stringify({ fetched: '2026-10-02T10:00:00Z', version: '2.1.0', counts: {} }));
  await t.message({ type: 'ready' });
  const m = t.calls.posted.at(-1);
  assert.deepStrictEqual(m.data.ti.entries, [{ id: 'a', name: 'A' }]);
  assert.strictEqual(m.status.fetched, '2026-10-02T10:00:00Z');
});

test('download: runs only on request, into <globalStorage>/docs, reports busy and refreshes the view', async () => {
  const t = setup({
    updateDocs: async (_dir, opts) => {
      opts.onProgress({ done: 0, total: 20 });
      opts.onProgress({ done: 10, total: 20 });
      opts.onProgress({ done: 20, total: 20 });
      return { counts: { en: { ti: 298, rules: 116 }, de: { ti: 298, rules: 116 } }, failed: {}, kept: [] };
    },
  });
  assert.strictEqual(t.calls.updateDocs.length, 0, 'nothing is downloaded on activation');
  await t.message({ type: 'download' });
  assert.deepStrictEqual(t.calls.updateDocs, [path.join(t.storage, 'docs')]);
  const busy = t.calls.posted.filter((m) => m.type === 'busy');
  assert.deepStrictEqual(busy.map((m) => [m.busy, m.done, m.total]), [[true, 0, 0], [true, 0, 20], [true, 10, 20], [true, 20, 20]]);
  assert.strictEqual(t.calls.posted.at(-1).type, 'data');
  assert.strictEqual(t.calls.posted.at(-1).busy, false);
  assert.match(t.calls.info.at(-1), /298 TurboIntegrator and 116 Rules/);
});

test('download: failure is reported and the view returns to normal', async () => {
  const t = setup({ updateDocs: async () => { throw new Error('getaddrinfo ENOTFOUND www.ibm.com'); } });
  await t.message({ type: 'download' });
  assert.match(t.calls.errors[0], /previous documentation was kept.*ENOTFOUND/);
  assert.strictEqual(t.calls.posted.at(-1).busy, false);
});

test('download: cancel is not an error', async () => {
  const t = setup({ updateDocs: async (_d, _o, { CancelledError }) => { throw new CancelledError(); } });
  await t.message({ type: 'download' });
  assert.strictEqual(t.calls.errors.length, 0);
  assert.match(t.calls.info.at(-1), /cancelled/);
});

test('download: a second request while one runs is refused', async () => {
  let release;
  const t = setup({ updateDocs: () => new Promise((resolve) => { release = () => resolve({ counts: { en: { ti: 1, rules: 1 } } }); }) });
  const first = t.message({ type: 'download' });
  await new Promise((r) => setImmediate(r));
  await t.message({ type: 'download' });
  assert.strictEqual(t.calls.updateDocs.length, 1);
  assert.match(t.calls.info.at(-1), /already running/);
  release();
  await first;
});

test('download: one language unavailable -> warning names it and says what happened to its old data', async () => {
  const kept = setup({
    updateDocs: async () => ({
      counts: { en: { ti: 298, rules: 116 }, de: { ti: 298, rules: 116 } },
      languages: { en: {}, de: {} },
      failed: { de: 'https://www.ibm.com/docs/api/v1/toc/SSD29G_2.1.0?parent=x&lang=de: HTTP 404' },
      kept: ['de'],
    }),
  });
  await kept.message({ type: 'download' });
  assert.strictEqual(kept.calls.info.length, 0);
  assert.match(kept.calls.warnings[0], /Updated English\. Deutsch could not be downloaded \(HTTP 404\); the previous version was kept\./);

  const none = setup({
    updateDocs: async () => ({ counts: { en: { ti: 1, rules: 1 } }, languages: { en: {} }, failed: { de: 'HTTP 404' }, kept: [] }),
  });
  await none.message({ type: 'download' });
  assert.match(none.calls.warnings[0], /Deutsch could not be downloaded \(HTTP 404\); it is not available\./);
});

test('download: HTTP 403 gets a specific message and the details go to the log, not the dialog', async () => {
  const t = setup({ updateDocs: async () => { throw Object.assign(new Error('https://x/toc: HTTP 403 (https), HTTP 403 (fetch)'), { status: 403 }); } });
  await t.message({ type: 'download' });
  assert.match(t.calls.errors[0], /IBM refused the download \(HTTP 403/);
  assert.ok(!/https:\/\/x/.test(t.calls.errors[0]));
});

// ---- import from file, connection check, failure details --------------------------------------

const bundleFile = (languages) => {
  const entries = (p, n) => Array.from({ length: n }, (_, i) => ({ id: `${p}${i}`, name: `${p}${i}` }));
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tm1ref-imp-')), 'docs.json');
  const body = Object.fromEntries(languages.map((l) => [l, { fetched: '2026-10-01T00:00:00Z', ti: { meta: {}, entries: entries('t', 110) }, rules: { meta: {}, entries: entries('r', 60) } }]));
  fs.writeFileSync(file, JSON.stringify({ format: 'tm1-reference-docs', version: 1, docsVersion: '2.1.0', languages: body }));
  return file;
};

test('import: file dialog, install, view refreshed, message names the languages', async () => {
  const file = bundleFile(['en', 'de']);
  const t = setup({ picked: [{ fsPath: file }] });
  await t.message({ type: 'import' });
  assert.deepStrictEqual(t.calls.dialogs[0].filters, { 'TM1 Reference': ['json'] });
  assert.match(t.calls.info.at(-1), /imported \(English, Deutsch\)/);
  const m = t.calls.posted.at(-1);
  assert.strictEqual(m.type, 'data');
  assert.strictEqual(m.data.ti.entries.length, 110);
  assert.strictEqual(m.status.counts.en.rules, 60);
});

test('import: cancelling the dialog does nothing', async () => {
  const t = setup({ picked: undefined });
  await t.message({ type: 'import' });
  assert.strictEqual(t.calls.info.length + t.calls.errors.length, 0);
  assert.strictEqual(t.calls.posted.length, 0);
});

test('import: a file that is not documentation is reported and nothing changes', async () => {
  const bad = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tm1ref-imp-')), 'x.json');
  fs.writeFileSync(bad, '{"hello": 1}');
  const t = setup({ picked: [{ fsPath: bad }] });
  await t.message({ type: 'import' });
  assert.match(t.calls.errors[0], /Import failed.*previous documentation was kept.*Not a TM1 Reference documentation file/);
  assert.ok(!fs.existsSync(path.join(t.storage, 'docs')));
  fs.writeFileSync(bad, 'not json at all');
  await t.message({ type: 'import' });
  assert.match(t.calls.errors[1], /Import failed/);
});

test('checkConnection: report with environment goes to the output channel, proxy credentials masked', async () => {
  const probes = [{ target: 'IBM root en', ibm: true, via: 'https', profile: 'client headers', status: 403, server: 'AkamaiGHost', page: 'Denied', ms: 12 }];
  const t = setup({ probes, settings: { proxy: 'http://user:pw@proxy.corp:3128' } });
  await t.run('tm1Reference.checkConnection');
  const report = t.calls.log.join('\n');
  assert.match(report, /=== TM1 Reference: connection check ===/);
  assert.match(report, /VS Code: 1\.99\.0/);
  assert.match(report, /http\.proxy: http:\/\/\*\*\*@proxy\.corp:3128/);
  assert.ok(!report.includes('pw@') && !report.includes('user:pw'));
  assert.match(report, /HTTP 403 +https +client headers +IBM root en +12 ms server=AkamaiGHost page="Denied"/);
  assert.match(report, /Result: /);
  assert.strictEqual(t.calls.outputShown, 1, 'output channel is shown');
  assert.match(t.calls.info.at(-1), /output channel/);
});

test('download failure: server and error-page details are written to the log, not into the dialog', async () => {
  const details = [{ via: 'https', server: 'AkamaiGHost', page: 'Access Denied Reference #18.1' }, { via: 'fetch', server: 'AkamaiGHost', page: 'Access Denied' }];
  const t = setup({ updateDocs: async () => { throw Object.assign(new Error('HTTP 403 (https), HTTP 403 (fetch)'), { status: 403, details }); } });
  await t.message({ type: 'download' });
  const log = t.calls.log.join('\n');
  assert.match(log, /download: failed: HTTP 403 \(https\), HTTP 403 \(fetch\)/);
  assert.match(log, /download: details: \[\{"via":"https","server":"AkamaiGHost","page":"Access Denied Reference #18\.1"\}/);
  assert.ok(!/Reference #18/.test(t.calls.errors[0]));
});

// ---- remembered language, download of the selected language only -----------------------------------

const dataMessages = (t) => t.calls.posted.filter((m) => m.type === 'data');

test('language: the choice in the view is remembered (globalState, not the settings) and all views follow', async () => {
  const t = setup();
  await t.message({ type: 'ready' });
  assert.strictEqual(dataMessages(t).at(-1).lang, 'en');
  await t.message({ type: 'setLanguage', lang: 'de' });
  assert.strictEqual(t.store.language, 'de');
  assert.strictEqual(dataMessages(t).at(-1).lang, 'de');
  await t.message({ type: 'setLanguage', lang: 'xx' });
  assert.strictEqual(t.store.language, 'de', 'unknown languages are ignored');
});

test('language: next start uses the remembered choice, before the setting and VS Code', async () => {
  const t = setup({ remembered: 'de', vscodeLanguage: 'en', settings: { language: 'en' } });
  await t.message({ type: 'ready' });
  assert.strictEqual(dataMessages(t).at(-1).lang, 'de');
  const fresh = setup({ vscodeLanguage: 'de-DE' });
  await fresh.message({ type: 'ready' });
  assert.strictEqual(dataMessages(fresh).at(-1).lang, 'de', 'nothing remembered: VS Code language');
  const configured = setup({ vscodeLanguage: 'de', settings: { language: 'en' } });
  await configured.message({ type: 'ready' });
  assert.strictEqual(dataMessages(configured).at(-1).lang, 'en', 'nothing remembered: the setting');
});

test('language: changing the setting on purpose forgets the remembered choice', async () => {
  const t = setup({ remembered: 'de', settings: { language: 'en' } });
  await t.changeConfig('tm1Reference.insertAsSnippet');
  assert.strictEqual(t.store.language, 'de', 'unrelated settings do not matter');
  await t.changeConfig('tm1Reference.language');
  assert.strictEqual(t.store.language, undefined);
  assert.strictEqual(dataMessages(t).at(-1).lang, 'en', 'the view follows the setting now');
});

test('download: only the selected language is requested', async () => {
  const en = setup();
  await en.message({ type: 'download' });
  assert.deepStrictEqual(en.updateOptions[0].languages, ['en']);
  const de = setup({ remembered: 'de' });
  await de.message({ type: 'download' });
  assert.deepStrictEqual(de.updateOptions[0].languages, ['de']);
  assert.match(de.calls.info.at(-1), /Dokumentation \(Deutsch\) aktualisiert \(1 TurboIntegrator- und 2 Rules-Einträge\)/, 'message in the selected language');
});

test('download: the language is fixed when the download starts, even if the dropdown changes meanwhile', async () => {
  let release;
  const t = setup({ updateDocs: (_d, opts) => new Promise((resolve) => { release = () => resolve({ counts: { en: { ti: 1, rules: 1 } } }); }) });
  const running = t.message({ type: 'download' });
  await new Promise((r) => setImmediate(r));
  await t.message({ type: 'setLanguage', lang: 'de' });
  release();
  await running;
  assert.deepStrictEqual(t.updateOptions[0].languages, ['en']);
  assert.match(t.calls.info.at(-1), /English documentation updated/);
});

test('download: language not provided by IBM (404) gets its own message', async () => {
  const t = setup({ remembered: 'de', updateDocs: async () => { throw Object.assign(new Error('https://x/toc?lang=de: HTTP 404'), { status: 404 }); } });
  await t.message({ type: 'download' });
  assert.match(t.calls.errors[0], /IBM bietet die Dokumentation auf Deutsch nicht an \(HTTP 404\)|IBM does not provide the Deutsch documentation \(HTTP 404\)/);
  assert.ok(!t.calls.errors[0].includes('https://x'));
  assert.strictEqual(dataMessages(t).at(-1).busy, false);
});
