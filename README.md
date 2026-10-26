# TM1 Reference

Reference for IBM Planning Analytics (TM1) inside VS Code: **TurboIntegrator** and **Rules** functions with syntax, arguments, description, remarks and examples, in **English and German**. It shows up as its own icon in the activity bar.

## Documentation download

The extension does **not** contain IBM's documentation. On first use the view is empty; press **Download documentation** (or run *TM1 Reference: Download / Update Documentation*). Then:

- it is loaded from the IBM Documentation (Planning Analytics 2.1.0, about 1 MB per language) **only when you ask for it**, and **only for the language selected in the dropdown**; the extension never connects to the internet on its own;
- the data is stored in the extension's global storage and works offline from then on;
- to get both languages, download once per language (switch the dropdown, press the button); updating one language leaves the other one untouched, and each language keeps its own date;
- you can update it any time with the ⟳ button next to the language dropdown (its tooltip names the language and shows the date of its last update) or with the command; a notification shows the progress and lets you cancel;
- a failed or cancelled download leaves the previous documentation untouched;
- if IBM does not provide the selected language (HTTP 404; for a while IBM had no German documentation for 2.1.0) you get a message saying so and everything stays as it was.

If the download is blocked (IBM answers HTTP 403 to some networks, proxies and VPNs):

- run **TM1 Reference: Check Connection**; it tries several ways to reach IBM and a neutral site and writes the result (VS Code/Node versions, proxy settings with credentials masked, status, server header and start of the error page per attempt) to the "TM1 Reference" output channel;
- run **TM1 Reference: Import Documentation from File** (also offered in the empty view) with a file made on a machine that can reach IBM: `npm run fetch-docs && npm run export-docs` creates `tm1-reference-docs-<version>.json`. Languages in the file replace the installed ones, other installed languages stay; an invalid file changes nothing.

The download uses IBM's content API (`www.ibm.com/docs/api/v1/content`), which is not a documented public API and may change; checks make sure a changed response never replaces good data. The pages are found like a reader would: the two section pages (*TurboIntegrator functions*, *Rules functions*) are opened and their child links are followed (section → categories → functions), so IBM's table of contents is not needed. Several possible locations of the section pages are tried (IBM has moved them before), the category page's title is used as the category name, and page order is IBM's. IBM's edge answers HTTP 403 unless a request carries the usual client headers (`Accept`, `Accept-Language`, `Accept-Encoding`, `Connection: keep-alive`), so the extension sets them itself (honest user agent `vscode-tm1-reference`; it requests gzip, which makes the download about 6x smaller). It tries `https` first, then `fetch`, and as the last resort the system's `curl` (`curl.exe` ships with Windows 10/11) after a 403 or network error: on some machines IBM's edge rejects the connection profile of Electron/Node while browsers and curl get through. The transport that worked is remembered for the rest of the download; 8 requests run in parallel. The content is © IBM Corporation; it is downloaded to your machine and not redistributed by this extension.

## Using it

- Two tabs, **TurboIntegrator** and **Rules** (in German "Regeln"); categories are collapsible (collapsed by default, "Expand all / Collapse all").
- Search over names, descriptions, arguments and examples, across all categories of the active tab (also collapsed ones). Wildcards: `*` (any characters) and `?` (one character), e.g. `Cell*N`, `*put*`, `DB?`.
- Language dropdown: your last choice is remembered and preselected the next time. Before the first choice the setting `tm1Reference.language` (`auto`, `en`, `de`) applies, `auto` meaning the VS Code display language; changing that setting later resets the remembered choice. Selecting a language that has not been downloaded yet shows a button to download it.
- **Copy** and **Insert** buttons for the syntax and every example; "Open in Editor" in the view's title bar.

### Insert

Inserts at the cursor of the editor you were working in.

- **Tab stops:** a syntax line like `CellPutN(x, Cube, e1, e2 [,..., en]);` is inserted as `CellPutN(${1:x}, ${2:Cube}, ${3:e1}, ${4:e2});`; Tab jumps to the next argument. Optional arguments (`[..]`, `<..>`) and repetitions (`..., en`) are left out; for Rules functions the trailing `;` is dropped. Statements, blocks (`If`, `While`) and calls without arguments are inserted unchanged. In **examples** every argument of the documented function becomes a tab stop prefilled with the example's value; quotes around text values stay outside the stop (`'${1:Sales}'`), other calls, comments and strings are kept as they are. Turn it off with `tm1Reference.insertAsSnippet`.
- **Text editors** (all cursors, also `ti` / `tm1rules` files) are edited directly.
- **TM1 IDE editors:** the process and rule editors of the TM1 IDE extension live in webviews; for them the command `tm1.editor.insertText` of TM1 IDE is used (needs a TM1 IDE version that provides it; tab stops use its `snippet: true` flag).
- **Fallback:** if that is unavailable, the text is copied to the clipboard, the editor is focused and VS Code's paste command is tried (does not work in TM1 IDE's editors, then paste manually with Ctrl+V; wait time: `tm1Reference.webviewPasteDelayMs`). With no editor open the text is only copied.
- The "TM1 Reference" output channel logs which path was taken and how downloads went.

Requires VS Code 1.85 or newer.

## Development

```
npm install
npm run fetch-docs   # downloads the documentation into ./data (git-ignored) with the code the extension uses
npm test             # unit tests; the ones that need the real documentation are skipped without ./data
npm run build        # bundles src/ into dist/extension.js (esbuild)
npm run package      # builds the .vsix (runs the build)
```

`npm run fetch-docs` caches raw pages in `scripts/.cache` (use `-- --refresh` to ignore it). Behind a proxy, Node needs `NODE_USE_ENV_PROXY=1`.

After IBM changes something: `npm run fetch-docs -- --refresh && npm test`. The tests check the parser against saved pages of both markup variants (`test/fixtures`), the structure of the downloaded data, and that every syntax line and example turns into well-formed tab stops that reproduce the original code. Press F5 in VS Code to launch an Extension Development Host.
