'use strict';

// Converts one IBM Docs (DITA) topic page into a reference entry.
const cheerio = require('cheerio/slim');

const clean = (s) => s.replace(/[ \t\r\n ]+/g, ' ').trim();

/** Inline text of an element with whitespace collapsed. */
function inline($, el) {
  return clean($(el).text());
}

/** Text of a <ul>/<ol>, one "• item" per line (nested lists indented). */
function listText($, list, depth = 0) {
  const lines = [];
  $(list)
    .children('li')
    .each((_, li) => {
      const $li = $(li).clone();
      const nested = $li.children('ul, ol').remove().toArray();
      const own = clean($li.text());
      if (own) lines.push('  '.repeat(depth) + '• ' + own);
      nested.forEach((n) => lines.push(listText($, n, depth + 1)));
    });
  return lines.join('\n');
}

/** Text of a table: header row skipped, one "cell — cell" line per row. */
function tableText($, table) {
  const rows = [];
  $(table)
    .find('tbody tr')
    .each((_, tr) => {
      const cells = $(tr)
        .children('td')
        .toArray()
        .map((td) => clean($(td).text()));
      if (cells.some(Boolean)) rows.push(cells.join(' — '));
    });
  return rows.join('\n');
}

/** Rows of a two-column table as [{name, description}] (paragraphs kept). */
function tableParams($, table) {
  const params = [];
  $(table)
    .find('tbody tr')
    .each((_, tr) => {
      const tds = $(tr).children('td').toArray();
      if (tds.length !== 2) return;
      const name = clean($(tds[0]).text());
      const description = $(tds[1])
        .find('p, li')
        .toArray()
        .map((p) => inline($, p))
        .filter(Boolean)
        .join('\n\n') || inline($, tds[1]);
      if (name) params.push({ name, description });
    });
  return params;
}

/** Rows of a <dl> (term = name, definition = description) as params. */
function dlParams($, dl) {
  const params = [];
  $(dl)
    .children('dt')
    .each((_, dt) => {
      const dd = $(dt).next('dd');
      const description = dd
        .find('p, li')
        .toArray()
        .map((p) => inline($, p))
        .filter(Boolean)
        .join('\n\n') || inline($, dd);
      const name = inline($, dt);
      if (name) params.push({ name, description });
    });
  return params;
}

/** A code sample directly inside a section: <pre>, or a bare <code> without surrounding paragraph. */
function isCodeSample($, el) {
  const tag = (el.tagName || '').toLowerCase();
  return tag === 'pre' || tag === 'code';
}

const codeOf = ($, el) => $(el).text().replace(/\s+$/, '');

const MODES = [
  ['syntax', /^(syntax)\b/i],
  ['params', /^(parameters?|arguments?|argumente?|parameter)\b/i],
  ['example', /^(examples?|beispiele?)\b/i],
  ['returns', /^(returns?|return values?|rückgabe)/i],
];

function sectionMode($section, title) {
  for (const [mode, re] of MODES) if (re.test(title)) return mode;
  return $section.is('.refsyn') ? 'intro' : 'other';
}

function isTwoColumn($, table) {
  return $(table).find('tbody tr').first().children('td').length === 2;
}

/** Converts block-level content into paragraphs of plain text. */
function blockText($, el) {
  const $el = $(el);
  const tag = (el.tagName || '').toLowerCase();
  if (tag === 'ul' || tag === 'ol') return listText($, el);
  if (tag === 'table') return tableText($, el);
  if ($el.is('div.tablenoborder')) return $el.children('table').toArray().map((t) => tableText($, t)).join('\n\n');
  if ($el.is('div.note, div.important, div.tip, div.warning, div.attention, div.restriction')) {
    // "notetitle" (older pages) or "note__title" (newer pages): any span whose class mentions "title"
    const title = clean($el.children('span[class*="title"]').text());
    const body = clean($el.clone().children('span[class*="title"]').remove().end().text());
    return (title ? title + ' ' : '') + body;
  }
  if (tag === 'pre') return $el.text().replace(/\s+$/, '');
  if (tag === 'p' || $el.is('span.shortdesc')) return inline($, el);
  if (tag === 'div' || tag === 'section') {
    return $el
      .children()
      .toArray()
      .map((c) => blockText($, c))
      .filter(Boolean)
      .join('\n\n') || inline($, el);
  }
  return inline($, el);
}

/**
 * @param {string} html  page HTML from the IBM Docs content API
 * @param {{id: string, category: string, source: string}} info
 */
function parsePage(html, info) {
  const $ = cheerio.load(html);
  const article = $('article').first();
  const body = article.find('> div.body').first();

  const entry = {
    id: info.id,
    name: inline($, article.find('h1').first()),
    category: info.category,
    summary: inline($, body.find('.shortdesc').first()),
    syntax: '',
    description: '',
    params: [],
    returns: '',
    remarks: '',
    examples: [],
    source: info.source,
  };

  const description = [];
  const remarks = [];
  const syntax = [];

  const handleExample = (el) => {
    const $el = $(el);
    const intro = [];
    let current = null;
    $el.children().each((_, c) => {
      const $c = $(c);
      if ($c.is('h2, h3, h4')) return;
      if (isCodeSample($, c)) {
        current = { code: codeOf($, c), description: '' };
        entry.examples.push(current);
      } else {
        const text = blockText($, c);
        if (!text) return;
        if (current) current.description += (current.description ? '\n\n' : '') + text;
        else intro.push(text);
      }
    });
    if (intro.length) {
      if (entry.examples.length) entry.examples[0].title = intro.join('\n\n');
      else remarks.push(intro.join('\n\n'));
    }
  };

  body.children().each((_, el) => {
    const $el = $(el);

    if ($el.is('div.abstract')) {
      $el.children().each((_, c) => {
        const $c = $(c);
        if ($c.is('.shortdesc')) return;
        const t = blockText($, c);
        if (t) description.push(t);
      });
      return;
    }

    if ($el.is('div.example')) {
      handleExample(el);
      return;
    }

    if ($el.is('section, div.section')) {
      const title = inline($, $el.children('h2, h3').first());
      const mode = sectionMode($el, title);
      if (mode === 'example') {
        handleExample(el);
        return;
      }
      const parts = [];
      $el.children().each((_, c) => {
        const $c = $(c);
        if ($c.is('h2, h3')) return;
        if ((mode === 'syntax' || mode === 'params') && isCodeSample($, c)) {
          syntax.push(codeOf($, c));
          return;
        }
        if (mode === 'syntax' || mode === 'params') {
          if ($c.is('dl')) {
            entry.params.push(...dlParams($, c));
            return;
          }
          // a table, wrapped in div.tablenoborder (older pages) or directly in the section (newer pages)
          const tables = $c.is('table') ? [c] : $c.is('div.tablenoborder') ? $c.children('table').toArray() : [];
          if (tables.length && tables.every((t) => isTwoColumn($, t))) {
            tables.forEach((t) => entry.params.push(...tableParams($, t)));
            return;
          }
        }
        if (mode === 'other' && isCodeSample($, c) && c.tagName.toLowerCase() === 'pre') {
          parts.push(codeOf($, c));
          return;
        }
        const t = blockText($, c);
        if (t) parts.push(t);
      });
      if (mode === 'returns') entry.returns = parts.join('\n\n');
      else if (mode === 'syntax' || mode === 'params' || mode === 'intro') {
        if (parts.length) description.push(parts.join('\n\n'));
      } else if (parts.length) remarks.push((title ? title + '\n' : '') + parts.join('\n\n'));
      return;
    }

    if ($el.is('pre')) {
      entry.examples.push({ code: $el.text().replace(/\s+$/, ''), description: '' });
      return;
    }

    const t = blockText($, el);
    if (t) description.push(t);
  });

  entry.syntax = syntax.join('\n');
  entry.description = description.join('\n\n');
  entry.remarks = remarks.join('\n\n');
  return entry;
}

/** Title of a page (its h1), whitespace collapsed; '' when there is none. */
function pageTitle(html) {
  const $ = cheerio.load(html);
  return clean($('h1').first().text());
}

/**
 * Child topics linked from a page (the "ulchildlink" list that every section and category page has),
 * as paths relative to the content root, in page order. Newer IBM pages list every link more than
 * once, so duplicates are dropped. Relative links are resolved against `pagePath`
 * ("c_x.html", "folder/c_x.html"); external links and fragments-only links are ignored.
 * @returns {{path: string, label: string}[]}
 */
function childLinks(html, pagePath) {
  const $ = cheerio.load(html);
  const base = new URL(String(pagePath || '').replace(/^\/+/, ''), 'https://content.invalid/');
  const seen = new Set();
  const out = [];
  $('li.ulchildlink').each((_, li) => {
    const a = $(li).find('a[href]').first();
    const href = (a.attr('href') || '').trim();
    if (!href || href.startsWith('#') || /^[a-z][a-z0-9+.-]*:/i.test(href)) return;
    const url = new URL(href, base);
    const linkPath = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
    if (!linkPath || seen.has(linkPath)) return;
    seen.add(linkPath);
    out.push({ path: linkPath, label: clean(a.text()) });
  });
  return out;
}

module.exports = { parsePage, childLinks, pageTitle };
