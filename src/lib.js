'use strict';

const fs = require('fs');
const path = require('path');

const LANGUAGES = ['en', 'de'];
const SECTIONS = ['ti', 'rules'];

/**
 * Decides the documentation language:
 *  1. the language last chosen in the view (`remembered`), if any;
 *  2. the `tm1Reference.language` setting (`en` / `de`);
 *  3. the display language of VS Code (German if it starts with "de", otherwise English).
 */
function resolveLanguage(setting, vscodeLanguage, remembered) {
  if (LANGUAGES.includes(remembered)) {
    return remembered;
  }
  if (LANGUAGES.includes(setting)) {
    return setting;
  }
  return String(vscodeLanguage || '').toLowerCase().startsWith('de') ? 'de' : 'en';
}

/**
 * Loads <dir>/<lang>/<section>.json (the downloaded documentation). Returns an empty section when
 * the file is missing or unreadable so the view still renders.
 */
function loadSection(dir, lang, section) {
  if (!LANGUAGES.includes(lang) || !SECTIONS.includes(section)) {
    throw new Error(`Unknown language/section: ${lang}/${section}`);
  }
  const file = path.join(dir, lang, `${section}.json`);
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return {
      meta: parsed.meta || {},
      entries: Array.isArray(parsed.entries) ? parsed.entries : [],
    };
  } catch (err) {
    return { meta: { error: String(err.message || err) }, entries: [] };
  }
}

function loadLanguage(dir, lang) {
  const result = {};
  for (const section of SECTIONS) {
    result[section] = loadSection(dir, lang, section);
  }
  return result;
}

/** Summary of the last download (<dir>/meta.json), or null when nothing has been downloaded. */
function readStatus(dir) {
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
    return {
      fetched: meta.fetched || null,
      version: meta.version || null,
      counts: meta.counts || {},
      languages: meta.languages || {},
    };
  } catch {
    return null;
  }
}

module.exports = { LANGUAGES, SECTIONS, resolveLanguage, loadSection, loadLanguage, readStatus };
