'use strict';

// Downloads the IBM Planning Analytics reference (TurboIntegrator + Rules functions) and writes
// <outDir>/<lang>/{ti,rules}.json plus <outDir>/meta.json. Only used when the user asks for it
// (command "Download / Update Documentation") and by the development CLI (scripts/fetch-docs.js).

const https = require('https');
const childProcess = require('child_process');
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');
const { parsePage, childLinks, pageTitle } = require('./parse-page');
const { LANGUAGES } = require('./lib');

// IBM Docs content API (not a documented public API, so it may change; the plausibility checks below
// make sure a changed response never replaces good data). Pages are addressed by file path:
//   <API>/<PRODUCT>/<path>?lang=<lang>
// IBM's table of contents endpoint and its topic short names are not used: for German they disappeared
// and moved around more than once. Instead the two section root pages are found and their child links
// are followed (root -> categories -> functions), the same way a reader navigates.
const API = 'https://www.ibm.com/docs/api/v1/content';
const PRODUCT = 'SSD29G_2.1.0';
const VERSION = '2.1.0';

// Where the section root pages live. IBM served them in a documentation folder at first, later directly
// below the product (English and German); older locations stay as fallbacks. The first one that exists wins.
const LOCATIONS = ['', 'com.ibm.swg.ba.cognos.tm1_ref.2.0.0.doc', 'com.ibm.swg.ba.cognos.tm1_prism_gs.2.0.0.doc'];

const SECTIONS = {
  ti: {
    rootFile: 'c_tm1turbointegratorfunctions_n70006.html',
    fallbackCategory: { en: 'General', de: 'Allgemein' },
    minEntries: 100,
  },
  rules: {
    rootFile: 'c_rulesfunctions_n80006.html',
    fallbackCategory: { en: 'Operators', de: 'Operatoren' },
    minEntries: 50,
  },
};

class CancelledError extends Error {
  constructor() {
    super('Download cancelled');
    this.name = 'CancelledError';
  }
}

// IBM's edge (bot protection) answers HTTP 403 unless a request looks like an ordinary HTTP client:
// Accept, Accept-Language, Accept-Encoding and keep-alive have to be present (found by bisecting;
// the user agent itself can stay honest). VS Code's own network layer does not always send them,
// so they are set explicitly instead of relying on defaults.
const REQUEST_HEADERS = {
  'user-agent': 'vscode-tm1-reference',
  accept: '*/*',
  'accept-language': '*',
  'accept-encoding': 'gzip, deflate',
};

/** Readable text of an error page: tags, scripts and styles stripped, whitespace collapsed. */
function snippetOf(text) {
  return String(text || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}

/** `detail` (which transport, server header, start of the error page) is only for the log. */
const httpError = (status, detail = {}) => Object.assign(new Error(`HTTP ${status}`), { status, detail });

function decodeBody(buffer, encoding) {
  const kind = String(encoding || '').toLowerCase();
  if (kind === 'gzip') return zlib.gunzipSync(buffer);
  if (kind === 'deflate') return zlib.inflateSync(buffer);
  return buffer;
}

/** GET with https. Anything but HTTP 200 is an error (redirects would mean a changed API). */
function httpsGetText(url, { timeoutMs = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { ...REQUEST_HEADERS, connection: 'keep-alive' } }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => {
        try {
          const body = decodeBody(Buffer.concat(chunks), res.headers['content-encoding']).toString('utf8');
          if (res.statusCode !== 200) {
            reject(httpError(res.statusCode, { via: 'https', server: res.headers.server, page: snippetOf(body) }));
          } else {
            resolve(body);
          }
        } catch (err) {
          reject(res.statusCode !== 200 ? httpError(res.statusCode, { via: 'https', server: res.headers.server }) : err);
        }
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

async function fetchGetText(url, timeoutMs) {
  const { connection, ...headers } = { ...REQUEST_HEADERS }; // fetch manages the connection itself
  const res = await fetch(url, { headers, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
  if (res.status !== 200) {
    const page = await res.text().catch(() => '');
    throw httpError(res.status, { via: 'fetch', server: res.headers.get('server'), page: snippetOf(page) });
  }
  return res.text();
}

/**
 * GET with the system's curl (curl.exe ships with Windows 10/11). IBM's edge rejects the TLS profile
 * of Electron/Node on some machines while browsers and curl get through, so curl is the last resort.
 * curl's own user agent is deliberately not overridden: it has to match curl's connection profile.
 * Rejects with `unavailable: true` when curl is not installed.
 */
function curlGetText(url, { timeoutMs = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    const bin = process.platform === 'win32' ? 'curl.exe' : 'curl';
    const args = ['--silent', '--show-error', '--compressed', '--max-time', String(Math.ceil(timeoutMs / 1000)), '--write-out', '\n%{http_code}', '--url', url];
    childProcess.execFile(bin, args, { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      if (err && err.code === 'ENOENT') {
        reject(Object.assign(new Error('curl is not available'), { unavailable: true }));
        return;
      }
      const out = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout || '');
      const split = out.lastIndexOf(0x0a); // the status code follows the body after a newline
      const status = split >= 0 ? parseInt(out.subarray(split + 1).toString('latin1'), 10) : NaN;
      if (!Number.isInteger(status) || status === 0) {
        const reason = Buffer.isBuffer(stderr) ? stderr.toString('utf8').trim() : String(stderr || '').trim();
        reject(new Error(reason || (err && err.message) || 'curl failed'));
        return;
      }
      const body = out.subarray(0, split).toString('utf8');
      if (status !== 200) reject(httpError(status, { via: 'curl', page: snippetOf(body) }));
      else resolve(body);
    });
  });
}

const defaultTransports = () => ({
  https: (url, opts) => httpsGetText(url, opts),
  fetch: typeof fetch === 'function' ? (url, opts) => fetchGetText(url, opts.timeoutMs) : undefined,
  curl: (url, opts) => curlGetText(url, opts),
});

/**
 * Builds a "GET URL as text" function that tries https (VS Code patches it for proxies and
 * certificates), then fetch, then curl. The next transport is only tried after an HTTP 403 or a
 * network-level error; any other status (404 = not available) is final. The transport that worked
 * is remembered and tried first from then on, so a machine that IBM only serves via curl does not
 * pay two failed requests per page. If all fail, the message names every result.
 */
function createFetcher({ transports = defaultTransports, order = ['https', 'fetch', 'curl'] } = {}) {
  let preferred = null;
  return async function getText(url, { timeoutMs = 30000 } = {}) {
    const available = transports();
    const sequence = (preferred ? [preferred, ...order.filter((n) => n !== preferred)] : order).filter((n) => available[n]);
    const failures = [];
    for (const name of sequence) {
      try {
        const body = await available[name](url, { timeoutMs });
        preferred = name;
        return body;
      } catch (err) {
        if (err.status && err.status !== 403) throw err;
        if (!err.unavailable) failures.push({ name, err });
      }
    }
    if (failures.length === 1) throw failures[0].err;
    throw Object.assign(new Error(failures.map(({ name, err }) => `${err.message} (${name})`).join(', ')), {
      status: (failures.find((f) => f.err.status) || { err: {} }).err.status,
      details: failures.map((f) => f.err.detail).filter(Boolean),
    });
  };
}

/** One request with a fresh transport order (no memory); use createFetcher() for many requests. */
const httpGetText = (url, options) => createFetcher()(url, options);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const pageUrl = (lang, pagePath) => `${API}/${PRODUCT}/${pagePath.split('/').map(encodeURIComponent).join('/')}?lang=${lang}`;
const sourceUrl = (lang, pagePath) => `https://www.ibm.com/docs/${lang}/planning-analytics/${VERSION}?topic=${PRODUCT}/${pagePath}`;
const idOf = (pagePath) => path.posix.basename(pagePath).replace(/\.[^.]+$/, '');

/**
 * @param {object} options
 * @param {string} options.outDir            directory to write into (created; should be empty/new)
 * @param {string} [options.previousDir]     existing documentation; a language that cannot be downloaded is copied from there
 * @param {string[]} [options.languages]     languages to download (default: all); the others are carried over untouched
 * @param {(url: string) => Promise<string>} [options.fetchText]  injectable for tests / caching
 * @param {number} [options.concurrency]
 * @param {number} [options.attempts]        tries per request
 * @param {number} [options.retryDelayMs]
 * @param {(p: {done: number, total: number}) => void} [options.onProgress]
 * @param {() => boolean} [options.isCancelled]
 * @returns {Promise<{fetched: string, version: string, counts: object}>}
 */
async function downloadDocs({
  outDir,
  previousDir,
  languages = ['en', 'de'],
  fetchText = createFetcher(),
  concurrency = 8,
  attempts = 4,
  retryDelayMs = 1000,
  onProgress = () => {},
  isCancelled = () => false,
} = {}) {
  const get = async (url) => {
    let lastError;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      if (isCancelled()) throw new CancelledError();
      try {
        return await fetchText(url);
      } catch (err) {
        lastError = err;
        // 404 (not available) and 403 (every transport was already refused) are answers, not hiccups
        if (err.status === 404 || err.status === 403) break;
        if (attempt < attempts) await sleep(retryDelayMs * 2 ** (attempt - 1));
      }
    }
    // keep status and the IBM details of the failed request: the caller reacts to them
    throw Object.assign(new Error(`${url}: ${lastError.message}`), {
      status: lastError.status,
      details: lastError.details || (lastError.detail ? [lastError.detail] : undefined),
    });
  };

  const unknown = languages.filter((l) => !LANGUAGES.includes(l));
  if (unknown.length || languages.length === 0) throw new Error(`Unknown language: ${unknown.join(', ') || '(none requested)'}`);

  // A language that cannot be downloaded (IBM currently serves no German for 2.1.0, for example)
  // must not sink the others: it is recorded in `failed` and its previous data is kept.
  const failed = {};
  const failedErrors = {};

  const firstFailure = () => Object.values(failedErrors)[0]; // the original error: status and details intact
  let done = 0;
  let total = 0;
  const progress = () => onProgress({ done, total });
  progress();

  /** Section root page: the first location that has it (404 = not there, anything else is an error). */
  async function findRoot(lang, rootFile) {
    let notFound;
    for (const location of LOCATIONS) {
      const pagePath = location ? `${location}/${rootFile}` : rootFile;
      try {
        return { path: pagePath, html: await get(pageUrl(lang, pagePath)) };
      } catch (err) {
        if (err.status !== 404) throw err;
        notFound = err;
      }
    }
    throw notFound;
  }

  /**
   * All reference pages of one section as entries, in the order IBM lists them. Follows the child links
   * of the root page: its children are either categories (which list their functions) or pages in their
   * own right (reserved words, operators); a page counts as a category as soon as it lists children.
   */
  async function crawlSection(lang, section) {
    const cfg = SECTIONS[section];
    const root = await findRoot(lang, cfg.rootFile);
    const seen = new Set([root.path]);
    const adopt = (node) =>
      childLinks(node.html, node.path)
        .filter((l) => !seen.has(l.path) && seen.add(l.path))
        .map((l) => ({ path: l.path, label: l.label, html: null, children: [] }));

    const rootNode = { path: root.path, label: '', html: root.html, children: [] };
    rootNode.children = adopt(rootNode);
    const queue = [...rootNode.children];
    total += queue.length;
    progress();

    let active = 0;
    let abort = null;
    const worker = async () => {
      while (!abort) {
        const node = queue.shift();
        if (!node) {
          if (active === 0) return;
          await sleep(2);
          continue;
        }
        active++;
        try {
          node.html = await get(pageUrl(lang, node.path));
          node.children = adopt(node);
          queue.push(...node.children);
          total += node.children.length;
          done++;
          progress();
        } catch (err) {
          abort = abort || err;
        } finally {
          active--;
        }
      }
    };
    await Promise.all(Array.from({ length: concurrency }, worker));
    if (abort) throw abort;

    const leaves = [];
    const collect = (node, category) => {
      for (const child of node.children) {
        if (child.children.length === 0) leaves.push({ node: child, category });
        else collect(child, category);
      }
    };
    for (const child of rootNode.children) {
      if (child.children.length === 0) leaves.push({ node: child, category: cfg.fallbackCategory[lang] });
      // The category page's own title is the full name; the link text in the parent list can be abbreviated
      // (German: "Attributregeln –" for "Regelfunktionen für Attribute").
      else collect(child, pageTitle(child.html) || child.label);
    }
    if (leaves.length < cfg.minEntries) {
      throw new Error(`Only ${leaves.length} pages found for ${lang}/${section}; expected at least ${cfg.minEntries}`);
    }
    return leaves.map(({ node, category }) => {
      const entry = parsePage(node.html, { id: idOf(node.path), category, source: sourceUrl(lang, node.path) });
      if (!entry.name) entry.name = node.label;
      return entry;
    });
  }

  // 2. every language on its own: one that fails is recorded, the others carry on
  const results = {}; // lang -> { ti: entries, rules: entries }
  for (const lang of languages) {
    try {
      results[lang] = {};
      for (const section of Object.keys(SECTIONS)) results[lang][section] = await crawlSection(lang, section);
    } catch (err) {
      if (err instanceof CancelledError) throw err;
      delete results[lang];
      failed[lang] = err.message;
      failedErrors[lang] = err;
    }
  }
  const downloaded = Object.keys(results);
  if (downloaded.length === 0) throw firstFailure();

  // 3. write the languages that worked ...
  const fetched = new Date().toISOString();
  const counts = {};
  const languageInfo = {};
  for (const lang of downloaded) {
    const dir = path.join(outDir, lang);
    await fs.promises.mkdir(dir, { recursive: true });
    const meta = {
      product: 'IBM Planning Analytics',
      version: VERSION,
      language: lang,
      fetched,
      copyright: '© Copyright IBM Corporation. Content taken from the IBM Documentation.',
    };
    counts[lang] = {};
    for (const section of Object.keys(SECTIONS)) {
      const entries = results[lang][section];
      await fs.promises.writeFile(path.join(dir, `${section}.json`), JSON.stringify({ meta, entries }, null, 1) + '\n');
      counts[lang][section] = entries.length;
    }
    languageInfo[lang] = { fetched };
  }

  // ... and carry over what already exists for every other language: the ones that were not requested
  // (only the selected language is updated) and the ones that could not be downloaded. Counts and date
  // come from the files themselves, so this also works for documentation without a meta.json.
  const kept = [];
  for (const lang of LANGUAGES.filter((l) => !downloaded.includes(l))) {
    const langCounts = {};
    let langFetched = null;
    for (const section of Object.keys(SECTIONS)) {
      try {
        const raw = await fs.promises.readFile(path.join(previousDir || '', lang, `${section}.json`), 'utf8');
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed.entries) || parsed.entries.length === 0) throw new Error('empty');
        langCounts[section] = parsed.entries.length;
        langFetched = (parsed.meta && parsed.meta.fetched) || langFetched;
        await fs.promises.mkdir(path.join(outDir, lang), { recursive: true });
        await fs.promises.writeFile(path.join(outDir, lang, `${section}.json`), raw);
      } catch {
        /* nothing (usable) to keep for this section */
      }
    }
    if (Object.keys(langCounts).length === Object.keys(SECTIONS).length) {
      if (failed[lang]) kept.push(lang); // `kept`: requested but unavailable, old data stays
      counts[lang] = langCounts;
      languageInfo[lang] = { fetched: langFetched };
    } else {
      await fs.promises.rm(path.join(outDir, lang), { recursive: true, force: true });
    }
  }

  const summary = { fetched, version: VERSION, counts, languages: languageInfo, failed, kept };
  await fs.promises.writeFile(path.join(outDir, 'meta.json'), JSON.stringify(summary, null, 1) + '\n');
  return summary;
}

/**
 * Replaces `finalDir` by `newDir` so that a failure leaves the old documentation untouched.
 */
async function installDocs(newDir, finalDir) {
  const backup = `${finalDir}.old-${Date.now()}`;
  let hadOld = false;
  try {
    await fs.promises.rename(finalDir, backup);
    hadOld = true;
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  try {
    await fs.promises.rename(newDir, finalDir);
  } catch (err) {
    if (hadOld) await fs.promises.rename(backup, finalDir);
    throw err;
  }
  if (hadOld) await fs.promises.rm(backup, { recursive: true, force: true });
}

/**
 * Downloads into a temporary sibling directory and swaps it in on success.
 * On error or cancel the existing documentation stays as it was.
 */
async function updateDocs(finalDir, options = {}) {
  const tmp = `${finalDir}.tmp-${Date.now()}`;
  await fs.promises.rm(tmp, { recursive: true, force: true });
  await fs.promises.mkdir(tmp, { recursive: true });
  try {
    const summary = await downloadDocs({ ...options, outDir: tmp, previousDir: finalDir });
    await installDocs(tmp, finalDir);
    return summary;
  } catch (err) {
    await fs.promises.rm(tmp, { recursive: true, force: true });
    throw err;
  }
}

module.exports = { downloadDocs, updateDocs, installDocs, httpGetText, createFetcher, httpsGetText, fetchGetText, curlGetText, snippetOf, REQUEST_HEADERS, CancelledError, pageUrl, SECTIONS, LOCATIONS, VERSION };
