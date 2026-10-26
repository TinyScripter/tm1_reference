'use strict';

// Exchange file for the documentation: one JSON file with all languages and sections. It lets the
// documentation be moved to a machine that cannot reach IBM (npm run export-docs on a machine that can,
// "TM1 Reference: Import Documentation from File" in VS Code).

const fs = require('fs');
const path = require('path');
const { LANGUAGES, SECTIONS, loadSection } = require('./lib');
const { SECTIONS: SECTION_LIMITS, VERSION, installDocs } = require('./docs');

const FORMAT = 'tm1-reference-docs';

/** Reads the documentation directory (<dir>/<lang>/<section>.json) into a bundle object. */
function exportBundle(dir) {
  let meta = {};
  try {
    meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
  } catch {
    /* optional */
  }
  const languages = {};
  for (const lang of LANGUAGES) {
    const sections = {};
    for (const section of SECTIONS) {
      const loaded = loadSection(dir, lang, section);
      if (loaded.entries.length) sections[section] = loaded;
    }
    if (Object.keys(sections).length === SECTIONS.length) {
      const fetched = ((meta.languages || {})[lang] || {}).fetched || sections.ti.meta.fetched || meta.fetched || null;
      languages[lang] = { fetched, ...sections };
    }
  }
  if (Object.keys(languages).length === 0) throw new Error('No documentation found to export');
  return { format: FORMAT, version: 1, product: 'IBM Planning Analytics', docsVersion: meta.version || VERSION, created: new Date().toISOString(), languages };
}

/** Throws a descriptive Error unless `bundle` is a usable bundle; returns the languages it contains. */
function validateBundle(bundle) {
  if (!bundle || bundle.format !== FORMAT) throw new Error('Not a TM1 Reference documentation file');
  if (bundle.version !== 1) throw new Error(`Unsupported file version ${bundle.version}`);
  const found = Object.keys(bundle.languages || {}).filter((l) => LANGUAGES.includes(l));
  if (found.length === 0) throw new Error('The file contains no documentation');
  for (const lang of found) {
    for (const section of SECTIONS) {
      const part = bundle.languages[lang][section];
      const entries = part && part.entries;
      const min = SECTION_LIMITS[section].minEntries;
      if (!Array.isArray(entries) || entries.length < min) {
        throw new Error(`${lang}/${section}: expected at least ${min} entries, found ${Array.isArray(entries) ? entries.length : 0}`);
      }
      if (!entries.every((e) => e && typeof e.id === 'string' && typeof e.name === 'string')) {
        throw new Error(`${lang}/${section}: entries without id or name`);
      }
    }
  }
  return found;
}

/**
 * Installs a bundle into `finalDir` (atomically). Languages in the bundle replace the installed ones,
 * other installed languages stay.
 */
async function importBundle(bundle, finalDir) {
  const langs = validateBundle(bundle);
  const tmp = `${finalDir}.tmp-${Date.now()}`;
  await fs.promises.rm(tmp, { recursive: true, force: true });
  await fs.promises.mkdir(tmp, { recursive: true });
  try {
    const counts = {};
    const languages = {};
    // keep what is installed for the languages the file does not contain
    let previous = {};
    try {
      previous = JSON.parse(await fs.promises.readFile(path.join(finalDir, 'meta.json'), 'utf8'));
    } catch {
      /* none */
    }
    for (const lang of LANGUAGES.filter((l) => !langs.includes(l))) {
      const existing = SECTIONS.map((s) => loadSection(finalDir, lang, s));
      if (existing.every((e) => e.entries.length)) {
        await fs.promises.mkdir(path.join(tmp, lang), { recursive: true });
        for (const [i, section] of SECTIONS.entries()) {
          await fs.promises.writeFile(path.join(tmp, lang, `${section}.json`), JSON.stringify({ meta: existing[i].meta, entries: existing[i].entries }, null, 1) + '\n');
        }
        counts[lang] = Object.fromEntries(SECTIONS.map((s, i) => [s, existing[i].entries.length]));
        languages[lang] = { fetched: ((previous.languages || {})[lang] || {}).fetched || existing[0].meta.fetched || null };
      }
    }
    for (const lang of langs) {
      const src = bundle.languages[lang];
      await fs.promises.mkdir(path.join(tmp, lang), { recursive: true });
      counts[lang] = {};
      for (const section of SECTIONS) {
        const { meta, entries } = src[section];
        await fs.promises.writeFile(path.join(tmp, lang, `${section}.json`), JSON.stringify({ meta: meta || {}, entries }, null, 1) + '\n');
        counts[lang][section] = entries.length;
      }
      languages[lang] = { fetched: src.fetched || bundle.created || null };
    }
    const fetched = Object.values(languages).map((l) => l.fetched).filter(Boolean).sort().at(-1) || null;
    const summary = { fetched, version: bundle.docsVersion || VERSION, counts, languages, failed: {}, kept: [], imported: langs };
    await fs.promises.writeFile(path.join(tmp, 'meta.json'), JSON.stringify(summary, null, 1) + '\n');
    await installDocs(tmp, finalDir);
    return summary;
  } catch (err) {
    await fs.promises.rm(tmp, { recursive: true, force: true });
    throw err;
  }
}

module.exports = { exportBundle, validateBundle, importBundle, FORMAT };
