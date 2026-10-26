'use strict';

/**
 * Decides where "Insert" should put text. Pure function (no vscode import) so it can be unit tested.
 *
 * @param {object} state
 * @param {{kind: 'text'|'webview'|'other'|null, uri?: string, viewColumn?: number, ownPanel?: boolean}|null} state.activeTab
 *        the active tab of the active editor group
 * @param {{uri: string, viewColumn: number}[]} state.visibleEditors  visible text editors
 * @param {{uri: string, viewColumn: number}|null} state.lastEditor    last text editor the user worked in
 * @returns {{type: 'text', uri: string, viewColumn: number} | {type: 'paste'} | {type: 'none'}}
 *
 * - Active tab is a text editor          -> insert there.
 * - Active tab is someone else's webview -> 'paste' (e.g. an editor rendered in a webview; it cannot be
 *                                           reached through the TextEditor API, so the caller pastes).
 * - Anything else (our own panel, diff, terminal, nothing) -> last used visible text editor, else none.
 */
function chooseInsertTarget({ activeTab, visibleEditors, lastEditor }) {
  const findVisible = (uri, viewColumn) =>
    visibleEditors.find((e) => e.uri === uri && e.viewColumn === viewColumn) ||
    visibleEditors.find((e) => e.uri === uri);

  if (activeTab && activeTab.kind === 'text') {
    const editor = findVisible(activeTab.uri, activeTab.viewColumn);
    if (editor) return { type: 'text', uri: editor.uri, viewColumn: editor.viewColumn };
  }
  if (activeTab && activeTab.kind === 'webview' && !activeTab.ownPanel) {
    return { type: 'paste' };
  }
  if (lastEditor) {
    const editor = findVisible(lastEditor.uri, lastEditor.viewColumn);
    if (editor) return { type: 'text', uri: editor.uri, viewColumn: editor.viewColumn };
  }
  return { type: 'none' };
}

module.exports = { chooseInsertTarget };
