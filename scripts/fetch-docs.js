// Development helper: downloads the documentation into ./data (git-ignored) with the same code the
// extension uses, so the data-dependent tests can run:  npm run fetch-docs && npm test
// Raw pages are cached in scripts/.cache; pass --refresh to ignore the cache.
// Behind a proxy run with NODE_USE_ENV_PROXY=1 (Node >= 22.21 / 24).
'use strict';
const fs = require('fs');
const path = require('path');
const { updateDocs, createFetcher } = require('../src/docs');

const httpGetText = createFetcher();

const ROOT = path.join(__dirname, '..');
const CACHE = path.join(__dirname, '.cache');
const refresh = process.argv.includes('--refresh');

/** Cache file for a request URL: <lang>/<page path with / replaced by __> */
function cacheFile(url) {
  const u = new URL(url);
  const lang = u.searchParams.get('lang');
  const pagePath = decodeURIComponent(u.pathname.split('/api/v1/content/')[1] || u.pathname).replace(/[\\/]+/g, '__');
  return path.join(CACHE, lang, pagePath);
}

async function cachedFetch(url) {
  const file = cacheFile(url);
  if (!refresh) {
    try {
      return await fs.promises.readFile(file, 'utf8');
    } catch {
      /* not cached */
    }
  }
  const text = await httpGetText(url);
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  await fs.promises.writeFile(file, text);
  return text;
}

let last = 0;
updateDocs(path.join(ROOT, 'data'), {
  fetchText: cachedFetch,
  onProgress: ({ done, total }) => {
    if (done === total || done - last >= 50) {
      last = done;
      console.log(`${done} / ${total}`);
    }
  },
})
  .then((summary) => console.log('done', JSON.stringify(summary.counts)))
  .catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
