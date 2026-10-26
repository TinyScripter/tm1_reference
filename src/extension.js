'use strict';

const vscode = require('vscode');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { resolveLanguage, loadLanguage, readStatus, LANGUAGES } = require('./lib');
const { updateDocs, CancelledError } = require('./docs');
const { importBundle } = require('./bundle');
const { runProbes, formatReport, maskProxy } = require('./diagnose');
const { chooseInsertTarget } = require('./insert-target');
const { buildSnippet, buildExampleSnippet } = require('./snippet');

const VIEW_ID = 'tm1Reference.view';

const LANGUAGE_KEY = 'language'; // globalState: the language last chosen in the view
let globalState; // set in activate()

/** Last choice in the view, else the setting, else the VS Code display language. */
function currentLanguage() {
  const setting = vscode.workspace.getConfiguration('tm1Reference').get('language', 'auto');
  return resolveLanguage(setting, vscode.env.language, globalState && globalState.get(LANGUAGE_KEY));
}

const PANEL_TYPE = 'tm1ReferencePanel';
const TM1_IDE_INSERT_COMMAND = 'tm1.editor.insertText';
const LANGUAGE_NAMES = { en: 'English', de: 'Deutsch' };
const MESSAGES = {
  en: {
    noTarget: 'TM1 Reference: No editor to insert into. The text was copied to the clipboard.',
    pasted: 'TM1 Reference: Paste sent to the editor. If nothing appeared, the text is on the clipboard (Ctrl+V).',
    downloadTitle: (name) => `TM1 Reference: Downloading the ${name} documentation from ibm.com`,
    downloadDone: (name, c) => `TM1 Reference: ${name} documentation updated (${c.ti} TurboIntegrator and ${c.rules} Rules entries).`,
    downloadNotAvailable: (name) => `TM1 Reference: IBM does not provide the ${name} documentation (HTTP 404), the previous documentation was kept. Switch the language in the view or try again later.`,
    downloadPartial: (updated, problems) =>
      `TM1 Reference: Updated ${updated}. ${problems.map((p) => `${p.name} could not be downloaded (${p.reason}); ${p.kept ? 'the previous version was kept' : 'it is not available'}.`).join(' ')}`,
    downloadFailed: 'TM1 Reference: Download failed, the previous documentation was kept.',
    downloadCancelled: 'TM1 Reference: Download cancelled, the previous documentation was kept.',
    downloadBlocked: 'TM1 Reference: IBM refused the download (HTTP 403, probably its bot protection), the previous documentation was kept. Details are in the "TM1 Reference" output channel.',
    downloadRunning: 'TM1 Reference: A download is already running.',
    importOpen: 'Import',
    importDone: (langs) => `TM1 Reference: Documentation imported (${langs}).`,
    importFailed: (reason) => `TM1 Reference: Import failed, the previous documentation was kept. ${reason}`,
    checkTitle: 'TM1 Reference: Checking the connection',
    checkDone: 'TM1 Reference: The result of the connection check is in the output channel "TM1 Reference".',
  },
  de: {
    noTarget: 'TM1 Reference: Kein Editor zum Einfügen vorhanden. Der Text wurde in die Zwischenablage kopiert.',
    pasted: 'TM1 Reference: Einfügen an den Editor gesendet. Falls nichts erschien, liegt der Text in der Zwischenablage (Strg+V).',
    downloadTitle: (name) => `TM1 Reference: Dokumentation (${name}) wird von ibm.com geladen`,
    downloadDone: (name, c) => `TM1 Reference: Dokumentation (${name}) aktualisiert (${c.ti} TurboIntegrator- und ${c.rules} Rules-Einträge).`,
    downloadNotAvailable: (name) => `TM1 Reference: IBM bietet die Dokumentation auf ${name} nicht an (HTTP 404), die bisherige Dokumentation wurde beibehalten. Wechsle die Sprache in der Ansicht oder versuche es später erneut.`,
    downloadPartial: (updated, problems) =>
      `TM1 Reference: ${updated} aktualisiert. ${problems.map((p) => `${p.name} konnte nicht geladen werden (${p.reason}); ${p.kept ? 'die bisherige Fassung wurde beibehalten' : 'sie ist nicht verfügbar'}.`).join(' ')}`,
    downloadFailed: 'TM1 Reference: Download fehlgeschlagen, die bisherige Dokumentation wurde beibehalten.',
    downloadCancelled: 'TM1 Reference: Download abgebrochen, die bisherige Dokumentation wurde beibehalten.',
    downloadBlocked: 'TM1 Reference: IBM hat den Download abgelehnt (HTTP 403, vermutlich der Bot-Schutz), die bisherige Dokumentation wurde beibehalten. Details stehen im Ausgabekanal "TM1 Reference".',
    downloadRunning: 'TM1 Reference: Es läuft bereits ein Download.',
    importOpen: 'Importieren',
    importDone: (langs) => `TM1 Reference: Dokumentation importiert (${langs}).`,
    importFailed: (reason) => `TM1 Reference: Import fehlgeschlagen, die bisherige Dokumentation wurde beibehalten. ${reason}`,
    checkTitle: 'TM1 Reference: Verbindung wird geprüft',
    checkDone: 'TM1 Reference: Das Ergebnis der Verbindungsprüfung steht im Ausgabekanal "TM1 Reference".',
  },
};

let output; // lazily created log channel, shows which insert path was taken
let lastEditor = null; // last text editor the user worked in: { uri, viewColumn }

function getOutput() {
  if (!output) output = vscode.window.createOutputChannel('TM1 Reference');
  return output;
}

function log(message) {
  getOutput().appendLine(`[${new Date().toISOString()}] ${message}`);
}

/** Text editors that are real editor tabs (not the output panel, terminal, debug console, ...). */
function isUserEditor(editor) {
  return !!editor && editor.viewColumn !== undefined &&
    !['output', 'vscode-terminal', 'debug', 'comment'].includes(editor.document.uri.scheme);
}

function rememberEditor(editor) {
  if (isUserEditor(editor)) lastEditor = { uri: editor.document.uri.toString(), viewColumn: editor.viewColumn };
}

function describeActiveTab() {
  const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
  if (!tab) return null;
  const input = tab.input;
  if (input instanceof vscode.TabInputText) {
    return { kind: 'text', uri: input.uri.toString(), viewColumn: tab.group.viewColumn, label: tab.label };
  }
  if (input instanceof vscode.TabInputWebview) {
    return { kind: 'webview', ownPanel: String(input.viewType).includes(PANEL_TYPE), viewType: input.viewType, label: tab.label };
  }
  if (input instanceof vscode.TabInputCustom) {
    // Custom editors (registered via customEditors) are not TextEditors either.
    return { kind: 'webview', ownPanel: false, viewType: input.viewType, label: tab.label };
  }
  return { kind: 'other', label: tab.label };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Inserts text at the cursor of the editor the user was working in. With `snippet` (Monaco snippet
 * syntax with tab stops) editors that support it get the snippet, everything else the plain `text`:
 *  - text editor (incl. the `ti` / `tm1rules` languages): direct edit at every cursor;
 *  - editor that lives in a webview (not reachable through the TextEditor API): TM1 IDE's
 *    `tm1.editor.insertText` command, then clipboard + focus the editor + paste command as fallback;
 *  - no editor found: try TM1 IDE's command too (it knows the last active process editor),
 *    otherwise copy to the clipboard and tell the user.
 */
async function insertText(text, { snippet = null } = {}) {
  const lang = currentLanguage();
  const activeTab = describeActiveTab();
  const visibleEditors = vscode.window.visibleTextEditors
    .filter(isUserEditor)
    .map((e) => ({ uri: e.document.uri.toString(), viewColumn: e.viewColumn }));
  const target = chooseInsertTarget({ activeTab, visibleEditors, lastEditor });
  log(`insert: activeTab=${JSON.stringify(activeTab)} target=${target.type}`);

  if (target.type === 'text') {
    const editor = vscode.window.visibleTextEditors.find(
      (e) => e.document.uri.toString() === target.uri && e.viewColumn === target.viewColumn
    ) || vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === target.uri);
    if (editor) {
      await vscode.window.showTextDocument(editor.document, { viewColumn: editor.viewColumn, preserveFocus: false });
      const ok = snippet
        ? await editor.insertSnippet(new vscode.SnippetString(snippet))
        : await editor.edit((b) => editor.selections.forEach((sel) => b.replace(sel, text)));
      log(`insert: text editor ${editor.document.languageId} ${snippet ? 'snippet ' : ''}${ok ? 'ok' : 'failed'}`);
      return;
    }
  }

  // Editors in webviews (TM1 IDE's process and rule editors) cannot be reached through the TextEditor
  // API or the paste command. TM1 IDE offers a public command for them; it returns true when the text
  // was handed to an editor and rejects/returns false when the command is missing (older TM1 IDE
  // versions) or no editor is open.
  if (target.type === 'paste' || target.type === 'none') {
    const inserted = await vscode.commands
      .executeCommand(TM1_IDE_INSERT_COMMAND, snippet ? { text: snippet, snippet: true } : { text })
      .then((r) => r === true, () => false);
    log(`insert: ${TM1_IDE_INSERT_COMMAND}${snippet ? ' (snippet)' : ''} -> ${inserted}`);
    if (inserted) return;
  }

  await vscode.env.clipboard.writeText(text);
  if (target.type === 'paste') {
    // Fallback for other webview editors: focus the editor group and run the paste command. The paste
    // is only taken once the webview reports itself as focused, hence the wait. It does not work in
    // TM1 IDE's editors (browser paste has no clipboard access there), which is why the command above
    // comes first.
    const delay = vscode.workspace.getConfiguration('tm1Reference').get('webviewPasteDelayMs', 400);
    await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
    await sleep(delay);
    await vscode.commands.executeCommand('editor.action.clipboardPasteAction');
    vscode.window.setStatusBarMessage(MESSAGES[lang].pasted, 6000);
    log(`insert: paste command sent to webview editor after ${delay} ms (cannot verify that the webview accepted it)`);
    return;
  }
  vscode.window.showInformationMessage(MESSAGES[lang].noTarget);
}

/**
 * Tab-stop snippet for the inserted code, or null to insert it unchanged (setting off, nothing to
 * turn into a stop). Syntax lines get a stop per argument; in examples every argument of the
 * documented function does (the call name comes from the entry name and from its syntax line).
 */
function snippetFor(msg) {
  if (!vscode.workspace.getConfiguration('tm1Reference').get('insertAsSnippet', true)) return null;
  if (msg.kind === 'syntax') {
    return buildSnippet(msg.text, { section: msg.section === 'rules' ? 'rules' : 'ti' });
  }
  if (msg.kind === 'example') {
    const syntaxName = /^\s*([A-Za-z_]\w*)\s*\(/.exec(String(msg.syntax || ''));
    return buildExampleSnippet(msg.text, [msg.name, syntaxName && syntaxName[1]]);
  }
  return null;
}

function buildHtml(webview, extensionUri) {
  const nonce = crypto.randomBytes(16).toString('base64');
  const asset = (name) => webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', name));
  const csp = [
    "default-src 'none'",
    `style-src ${webview.cspSource}`,
    `script-src 'nonce-${nonce}'`,
  ].join('; ');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${asset('main.css')}">
  <title>TM1 Reference</title>
</head>
<body>
  <div id="app"></div>
  <script nonce="${nonce}" src="${asset('search.js')}"></script>
  <script nonce="${nonce}" src="${asset('main.js')}"></script>
</body>
</html>`;
}

// ---- documentation storage, download and view state ------------------------------------------

let docsDir = ''; // <globalStorage>/docs, set in activate()
const download = { busy: false, done: 0, total: 0 };
const attached = new Set(); // webviews (sidebar view and editor panels) currently showing the reference

function dataMessage() {
  const lang = currentLanguage();
  return {
    type: 'data',
    lang,
    languages: LANGUAGES,
    data: loadLanguage(docsDir, lang),
    status: readStatus(docsDir),
    busy: download.busy,
    progress: { done: download.done, total: download.total },
  };
}

function broadcast(message) {
  for (const webview of attached) webview.postMessage(message);
}

function broadcastData() {
  broadcast(dataMessage());
}

/**
 * Downloads (or updates) the documentation from ibm.com. Runs only when the user asks for it.
 * The previous documentation stays in place unless the whole download succeeds.
 */
async function downloadDocsCommand() {
  const lang = currentLanguage();
  const text = MESSAGES[lang];
  if (download.busy) {
    vscode.window.showInformationMessage(text.downloadRunning);
    return;
  }
  Object.assign(download, { busy: true, done: 0, total: 0 });
  broadcast({ type: 'busy', busy: true, done: 0, total: 0 });
  log('download: started');
  try {
    const summary = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: text.downloadTitle(LANGUAGE_NAMES[lang]), cancellable: true },
      async (progress, token) => {
        let reported = 0;
        return updateDocs(docsDir, {
          languages: [lang], // only the selected language; the other one stays as it is
          isCancelled: () => token.isCancellationRequested,
          onProgress: ({ done, total }) => {
            Object.assign(download, { done, total });
            progress.report({ increment: total ? ((done - reported) * 100) / total : 0, message: `${done} / ${total}` });
            reported = done;
            if (done === total || done % 10 === 0) broadcast({ type: 'busy', busy: true, done, total });
          },
        });
      }
    );
    log(`download: finished ${JSON.stringify(summary)}`);
    const failedLanguages = Object.keys(summary.failed || {});
    if (failedLanguages.length === 0) {
      vscode.window.showInformationMessage(text.downloadDone(LANGUAGE_NAMES[lang], summary.counts[lang]));
    } else {
      // e.g. IBM currently does not serve one language: the rest was installed, old data of that language kept
      const names = (langs) => langs.map((l) => LANGUAGE_NAMES[l] || l).join(', ');
      const problems = failedLanguages.map((l) => ({
        name: LANGUAGE_NAMES[l] || l,
        reason: summary.failed[l].replace(/^https?:\/\/\S+:\s*/, ''),
        kept: (summary.kept || []).includes(l),
      }));
      vscode.window.showWarningMessage(text.downloadPartial(names(Object.keys(summary.languages || summary.counts).filter((l) => !failedLanguages.includes(l))), problems));
    }
  } catch (err) {
    if (err instanceof CancelledError) {
      log('download: cancelled');
      vscode.window.showInformationMessage(text.downloadCancelled);
    } else {
      log(`download: failed: ${err && err.message}`);
      const details = (err && (err.details || (err.detail && [err.detail]))) || [];
      if (details.length) log(`download: details: ${JSON.stringify(details)}`);
      vscode.window.showErrorMessage(
        err && err.status === 403
          ? text.downloadBlocked
          : err && err.status === 404
            ? text.downloadNotAvailable(LANGUAGE_NAMES[lang])
            : `${text.downloadFailed} (${err && err.message})`
      );
    }
  } finally {
    Object.assign(download, { busy: false, done: 0, total: 0 });
    broadcastData();
  }
}

/** Installs documentation from a file made by `npm run export-docs` (for machines that cannot reach IBM). */
async function importDocsCommand() {
  const text = MESSAGES[currentLanguage()];
  if (download.busy) {
    vscode.window.showInformationMessage(text.downloadRunning);
    return;
  }
  const picked = await vscode.window.showOpenDialog({
    canSelectMany: false,
    openLabel: text.importOpen,
    filters: { 'TM1 Reference': ['json'] },
  });
  if (!picked || picked.length === 0) return;
  try {
    const bundle = JSON.parse(await fs.promises.readFile(picked[0].fsPath, 'utf8'));
    const summary = await importBundle(bundle, docsDir);
    log(`import: ${picked[0].fsPath} -> ${JSON.stringify(summary.counts)}`);
    vscode.window.showInformationMessage(text.importDone(summary.imported.map((l) => LANGUAGE_NAMES[l] || l).join(', ')));
    broadcastData();
  } catch (err) {
    log(`import: failed: ${err && err.message}`);
    vscode.window.showErrorMessage(text.importFailed(err && err.message));
  }
}

/** Tries several ways to reach IBM and writes the result to the output channel. */
async function checkConnectionCommand() {
  const text = MESSAGES[currentLanguage()];
  const http = vscode.workspace.getConfiguration('http');
  const env = {
    'VS Code': vscode.version,
    'Node / Electron': `${process.versions.node} / ${process.versions.electron || '-'}`,
    Platform: `${process.platform} ${process.arch}`,
    Remote: vscode.env.remoteName || 'none',
    'http.proxy': maskProxy(http.get('proxy')),
    'http.proxySupport': http.get('proxySupport'),
    'http.proxyStrictSSL': http.get('proxyStrictSSL'),
    'http.systemCertificates': http.get('systemCertificates'),
    HTTPS_PROXY: maskProxy(process.env.HTTPS_PROXY || process.env.https_proxy),
    HTTP_PROXY: maskProxy(process.env.HTTP_PROXY || process.env.http_proxy),
    NO_PROXY: process.env.NO_PROXY || process.env.no_proxy,
  };
  const results = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: text.checkTitle },
    () => runProbes()
  );
  getOutput().appendLine(formatReport(env, results));
  getOutput().show(true);
  vscode.window.showInformationMessage(text.checkDone);
}

/**
 * Wires a webview (sidebar view or editor panel) to the extension:
 * serves the downloaded documentation and persists the language choice.
 */
function attachWebview(webview, context) {
  webview.options = {
    enableScripts: true,
    localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')],
  };
  webview.html = buildHtml(webview, context.extensionUri);
  attached.add(webview);

  const subscriptions = [
    { dispose: () => attached.delete(webview) },
    webview.onDidReceiveMessage(async (msg) => {
      if (msg && msg.type === 'ready') {
        webview.postMessage(dataMessage());
      } else if (msg && msg.type === 'setLanguage' && LANGUAGES.includes(msg.lang)) {
        // remembered for the next time the view is opened; all open views follow
        await globalState.update(LANGUAGE_KEY, msg.lang);
        broadcastData();
      } else if (msg && msg.type === 'download') {
        await downloadDocsCommand();
      } else if (msg && msg.type === 'import') {
        await importDocsCommand();
      } else if (msg && msg.type === 'copy' && typeof msg.text === 'string') {
        await vscode.env.clipboard.writeText(msg.text);
      } else if (msg && msg.type === 'insert' && typeof msg.text === 'string') {
        await insertText(msg.text, { snippet: snippetFor(msg) });
      }
    }),
  ];
  return vscode.Disposable.from(...subscriptions);
}

class ReferenceViewProvider {
  constructor(context) {
    this.context = context;
    this.view = undefined;
  }

  resolveWebviewView(view) {
    this.view = view;
    const disposable = attachWebview(view.webview, this.context);
    view.onDidDispose(() => {
      disposable.dispose();
      this.view = undefined;
    });
  }

  focusSearch() {
    if (this.view) {
      this.view.show(false);
      this.view.webview.postMessage({ type: 'focusSearch' });
    }
  }
}

function activate(context) {
  globalState = context.globalState;
  docsDir = path.join(context.globalStorageUri.fsPath, 'docs');
  fs.mkdirSync(context.globalStorageUri.fsPath, { recursive: true });
  const provider = new ReferenceViewProvider(context);
  rememberEditor(vscode.window.activeTextEditor);

  context.subscriptions.push(
    // Changing the setting on purpose wins over the remembered choice, which is then forgotten.
    vscode.workspace.onDidChangeConfiguration(async (e) => {
      if (e.affectsConfiguration('tm1Reference.language')) {
        await globalState.update(LANGUAGE_KEY, undefined);
        broadcastData();
      }
    }),
    vscode.window.onDidChangeActiveTextEditor(rememberEditor),
    vscode.window.registerWebviewViewProvider(VIEW_ID, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand('tm1Reference.search', async () => {
      await vscode.commands.executeCommand(`${VIEW_ID}.focus`);
      provider.focusSearch();
    }),
    vscode.commands.registerCommand('tm1Reference.downloadDocs', downloadDocsCommand),
    vscode.commands.registerCommand('tm1Reference.importDocs', importDocsCommand),
    vscode.commands.registerCommand('tm1Reference.checkConnection', checkConnectionCommand),
    vscode.commands.registerCommand('tm1Reference.openInEditor', () => {
      const panel = vscode.window.createWebviewPanel(
        PANEL_TYPE,
        'TM1 Reference',
        vscode.ViewColumn.Beside,
        { enableScripts: true, retainContextWhenHidden: true }
      );
      const disposable = attachWebview(panel.webview, context);
      panel.onDidDispose(() => disposable.dispose());
    })
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
