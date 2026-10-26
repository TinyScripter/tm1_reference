/* Search over reference entries. Loaded in the webview and in node tests. */
(function (root) {
  'use strict';

  function norm(s) {
    return String(s || '').toLowerCase();
  }

  const escapeRe = (s) => s.replace(/[.+^${}()|[\]\\]/g, '\\$&');

  /**
   * Turns one search term into a matcher.
   *   *  any number of characters      ?  exactly one character
   * Without wildcards a term is a plain substring. With wildcards:
   *   - against a function name the pattern must match the whole name
   *     (Cell*N finds CellGetN, not "MyCellN2"), `*put*` matches anywhere;
   *   - against descriptions etc. it matches inside a single word, so
   *     Cell*N does not match across half a paragraph.
   */
  function makeTerm(term) {
    if (!/[*?]/.test(term)) {
      return { wild: false, inName: (s) => s.includes(term), inText: (s) => s.includes(term), term };
    }
    const src = (any, one) => escapeRe(term).replace(/\*/g, any).replace(/\?/g, one);
    const nameFull = new RegExp('^' + src('[\\s\\S]*', '[\\s\\S]') + '$');
    const text = new RegExp(src('\\S*', '\\S'));
    return { wild: true, inName: (s) => nameFull.test(s), inText: (s) => text.test(s), term };
  }

  function scoreEntry(entry, terms) {
    const name = norm(entry.name);
    const fields = [
      [norm(entry.category), 4],
      [norm(entry.summary), 3],
      [norm(entry.syntax), 2],
      [norm(entry.description), 2],
      [norm((entry.params || []).map((p) => p.name + ' ' + p.description).join(' ')), 1],
      [norm(entry.returns), 1],
      [norm(entry.remarks), 1],
      [norm((entry.examples || []).map((e) => (e.title || '') + ' ' + (e.description || '') + ' ' + e.code).join(' ')), 1],
    ];
    let total = 0;
    for (const t of terms) {
      let s = 0;
      if (t.wild) {
        if (t.inName(name)) s = 60;
      } else if (name === t.term) s = 100;
      else if (name.startsWith(t.term)) s = 50;
      else if (name.includes(t.term)) s = 25;
      for (const [text, weight] of fields) {
        if (t.inText(text)) s += weight;
      }
      if (s === 0) return 0; // every term must match somewhere
      total += s;
    }
    return total;
  }

  /**
   * Returns entries matching all whitespace-separated terms, best first.
   * An empty query returns all entries in their original order.
   */
  function searchEntries(entries, query) {
    const terms = norm(query).split(/\s+/).filter(Boolean).map(makeTerm);
    if (terms.length === 0) return entries.slice();
    return entries
      .map((entry, index) => ({ entry, index, score: scoreEntry(entry, terms) }))
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score || a.index - b.index)
      .map((r) => r.entry);
  }

  const api = { searchEntries };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.TM1Search = api;
})(typeof self !== 'undefined' ? self : this);
