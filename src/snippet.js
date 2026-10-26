'use strict';

/**
 * Turns an IBM syntax line such as
 *     CellPutN(x, Cube, e1, e2 [,..., en]);
 * into a VS Code / Monaco snippet with one tab stop per argument:
 *     CellPutN(${1:x}, ${2:Cube}, ${3:e1}, ${4:e2});$0
 *
 * Returns null when the syntax is not a plain function call (statements like `ChoreQuit;`,
 * blocks like If ... EndIf, assignments); the caller then inserts the text unchanged.
 *
 * Argument rules:
 *  - `[arg]` and `<arg>` are optional in IBM's notation: dropped when trailing, kept as a normal
 *    placeholder when followed by a required argument.
 *  - repetition notation (`e2 [,..., en]`, `...Stringn`, `..., en`) is cut off.
 *  - several variants on separate lines (`F(a)` / `F(a, b)`): the first one is used.
 *  - a line continuation (`\` + newline) or a call wrapped over several lines is joined.
 *  - rules functions are expressions, so a trailing `;` is dropped for them (`section: 'rules'`).
 */

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const escapeSnippet = (s) => s.replace(/[\\$}]/g, '\\$&');

/** Index of the parenthesis closing the one at `open`, or -1. Quotes are skipped. */
function findClosingParen(text, open) {
  let depth = 0;
  let quote = null;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === "'" || c === '"') {
      quote = c;
    } else if (c === '(') {
      depth++;
    } else if (c === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Splits on commas that are not inside (), [] or quotes. */
function splitArgs(text) {
  const out = [];
  let depth = 0;
  let quote = null;
  let current = '';
  for (const c of text) {
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === "'" || c === '"') {
      quote = c;
    } else if (c === '(' || c === '[') {
      depth++;
    } else if (c === ')' || c === ']') {
      depth--;
    } else if (c === ',' && depth === 0) {
      out.push(current);
      current = '';
      continue;
    }
    current += c;
  }
  out.push(current);
  return out;
}

const clean = (s) => s.replace(/\s+/g, ' ').trim();

/** @returns {{name: string, optional: boolean}[]} arguments in order, repetition cut off */
function parseArgs(argsText) {
  const args = [];
  for (const raw of splitArgs(argsText)) {
    let arg = clean(raw);
    if (!arg) continue;
    if (/^(\.{2,}|…)/.test(arg)) break; // "...Stringn" / "..., en": nothing after it is a real argument
    const trailingDots = /^(\w+)\s*(\.{2,}|…)/.exec(arg); // "e3...,en": keep e3, then stop
    if (trailingDots) {
      args.push({ name: trailingDots[1], optional: false });
      break;
    }

    let optional = false;
    const bracketed = /^\[(.*)\]$/.exec(arg) || /^<(.*)>$/.exec(arg);
    if (bracketed) {
      optional = true;
      arg = clean(bracketed[1]);
      if (/^,/.test(arg)) arg = clean(arg.replace(/^,\s*/, ''));
    }
    arg = clean(arg.replace(/\s*\[.*$/, '')); // "e2 [,..., en]" -> "e2"
    if (!arg || /^(\.{2,}|…)/.test(arg)) {
      if (!arg) continue;
      break;
    }
    args.push({ name: arg, optional });
  }
  while (args.length && args[args.length - 1].optional) args.pop();
  return args;
}

/**
 * @param {string} syntax
 * @param {{section?: 'ti'|'rules'}} [options]
 * @returns {string|null}
 */
function buildSnippet(syntax, { section } = {}) {
  const text = String(syntax || '').replace(/\\[ \t]*\n/g, ' ').trim();
  const head = /^([A-Za-z_][\w.]*)\s*\(/.exec(text);
  if (!head) return null;

  const open = head[0].length - 1;
  const close = findClosingParen(text, open);
  if (close < 0) return null;

  const name = head[1];
  // Text after the call on the same line is an annotation ("... returns Address;"), not code.
  const [sameLine, ...laterLines] = text.slice(close + 1).split('\n');
  const hasSemicolon = sameLine.includes(';');
  // The following lines must be further variants of the same call; anything else is a block/script.
  const variant = new RegExp('^' + escapeRe(name) + '\\s*\\(', 'i');
  const restLines = laterLines.map((l) => l.trim()).filter(Boolean);
  if (!restLines.every((l) => variant.test(l))) return null;

  const args = parseArgs(text.slice(open + 1, close));
  const semicolon = hasSemicolon && section !== 'rules' ? ';' : '';
  if (args.length === 0) {
    // `F()` alone is inserted as written; with variants (`F()` / `F(user)`) only the first is used.
    return restLines.length ? `${name}()${semicolon}$0` : null;
  }

  const stops = args.map((a, i) => `\${${i + 1}:${escapeSnippet(a.name)}}`);
  return `${name}(${stops.join(', ')})${semicolon}$0`;
}

/** Index just after the string literal starting at `start` (a doubled quote is an escaped quote). */
function stringEnd(code, start) {
  const q = code[start];
  let j = start + 1;
  while (j < code.length) {
    if (code[j] === q) {
      if (code[j + 1] === q) {
        j += 2;
        continue;
      }
      return j + 1;
    }
    j++;
  }
  return code.length;
}

const escapeText = (s) => s.replace(/[\\$]/g, '\\$&');

/** One argument of an example call as a tab stop; the quotes of a pure string literal stay outside. */
function argToStop(raw, n) {
  const lead = /^\s*/.exec(raw)[0];
  const core = raw.trim();
  const trail = raw.slice(lead.length + core.length);
  if ((core[0] === "'" || core[0] === '"') && stringEnd(core, 0) === core.length && core.length >= 2) {
    const q = core[0];
    return `${lead}${q}\${${n}:${escapeSnippet(core.slice(1, -1))}}${q}${trail}`;
  }
  return `${lead}\${${n}:${escapeSnippet(core)}}${trail}`;
}

/**
 * Turns example code into a snippet: every argument of every call to one of `names`
 * (case-insensitive, the documented function) becomes a tab stop, prefilled with the example's value.
 * Quotes around a text argument stay outside the stop: 'Sales' -> '${1:Sales}'.
 * Everything else (other calls, comments, strings, whitespace) is kept exactly.
 * Returns null when there is nothing to turn into a stop.
 */
function buildExampleSnippet(code, names) {
  const wanted = new Set((names || []).filter(Boolean).map((n) => n.toLowerCase()));
  const src = String(code || '');
  if (wanted.size === 0) return null;

  let out = '';
  let stops = 0;
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === "'" || c === '"') {
      const end = stringEnd(src, i);
      out += escapeText(src.slice(i, end));
      i = end;
    } else if (c === '#') {
      const nl = src.indexOf('\n', i);
      const end = nl < 0 ? src.length : nl;
      out += escapeText(src.slice(i, end));
      i = end;
    } else if (/[A-Za-z_]/.test(c)) {
      const id = /^\w+/.exec(src.slice(i))[0];
      let j = i + id.length;
      while (src[j] === ' ' || src[j] === '\t') j++;
      const close = wanted.has(id.toLowerCase()) && src[j] === '(' ? findClosingParen(src, j) : -1;
      const parts = close > 0 ? splitArgs(src.slice(j + 1, close)) : [];
      if (close > 0 && parts.some((a) => a.trim())) {
        const converted = parts.map((a) => (a.trim() ? argToStop(a, ++stops) : a));
        out += escapeText(src.slice(i, j + 1)) + converted.join(',') + ')';
        i = close + 1;
      } else {
        out += id;
        i += id.length;
      }
    } else {
      out += escapeText(c);
      i++;
    }
  }
  return stops > 0 ? out + '$0' : null;
}

module.exports = { buildSnippet, buildExampleSnippet, parseArgs };
