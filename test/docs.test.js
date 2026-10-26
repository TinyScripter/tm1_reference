'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const childProcess = require('child_process');
const { downloadDocs, updateDocs, httpGetText, createFetcher, curlGetText, CancelledError, LOCATIONS } = require('../src/docs');

const PAGE = fs.readFileSync(path.join(__dirname, 'fixtures', 'cellputn-en.html'), 'utf8');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'tm1ref-docs-'));
const notFound = () => Object.assign(new Error('HTTP 404'), { status: 404 });

// ---- a fake IBM site ------------------------------------------------------------------------------
// Root pages list their children (every link twice, like IBM's newer pages); category pages list functions;
// a function page is the CellPutN fixture. TI: one category with `ti` functions. Rules: one category with
// `rules` functions plus an operator page directly under the root.

const link = (href, label) => `<li class="ulchildlink"><strong><a href="${href}">${label}</a></strong></li>`;
const listPage = (title, links) =>
  `<html><body><main><article><h1>${title}</h1></article></main><aside><nav><ul class="ullinks">${links
    .concat(links)
    .map(([href, label]) => link(href, label))
    .join('')}</ul></nav></aside></body></html>`;
const names = (prefix, n) => Array.from({ length: n }, (_, i) => `${prefix}-${i}.html`);

/** path (relative to the content root) -> html */
function site({ ti = 110, rules = 60, location = '', nested = 0 } = {}) {
  const at = (p) => (location ? `${location}/${p}` : p);
  const pages = {};
  const direct = names('t', ti - nested);
  pages[at('c_tm1turbointegratorfunctions_n70006.html')] = listPage('TurboIntegrator Functions', [['c1.html', 'Cat 1 (short link text)']]);
  pages[at('c1.html')] = listPage('Cat 1', [...direct, ...(nested ? ['sub.html'] : [])].map((f) => [f, f]));
  if (nested) pages[at('sub.html')] = listPage('Sub category', names('n', nested).map((f) => [f, f]));
  pages[at('c_rulesfunctions_n80006.html')] = listPage('Rules functions', [['c2.html', 'Cat 2'], ['op.html', 'Operator page']]);
  pages[at('c2.html')] = listPage('Cat 2', names('r', rules).map((f) => [f, f]));
  for (const f of [...direct, ...names('n', nested), ...names('r', rules), 'op.html']) pages[at(f)] = PAGE;
  return pages;
}

/** Fake IBM server: answers `pages` per language (a language without pages is a 404 everywhere). */
const fakeFetch = (opts = {}, hook = () => {}) => {
  const pages = site(opts);
  return async (url) => {
    hook(url);
    const m = /\/SSD29G_2\.1\.0\/(.+)\?lang=(\w+)$/.exec(url);
    if (!m || (opts.unavailable || []).includes(m[2])) throw notFound();
    const html = pages[decodeURIComponent(m[1])];
    if (!html) throw notFound();
    return html;
  };
};
const fast = { attempts: 2, retryDelayMs: 1 };
const ENTRIES = { ti: 110, rules: 61 }; // 60 functions + the operator page

test('downloadDocs: writes both languages and sections, meta.json, progress', async () => {
  const out = tmp();
  const progress = [];
  const summary = await downloadDocs({ outDir: out, fetchText: fakeFetch(), onProgress: (p) => progress.push(p), ...fast });

  assert.deepStrictEqual(summary.counts, { en: ENTRIES, de: ENTRIES });
  assert.strictEqual(summary.version, '2.1.0');
  for (const lang of ['en', 'de']) {
    const ti = JSON.parse(fs.readFileSync(path.join(out, lang, 'ti.json'), 'utf8'));
    assert.strictEqual(ti.entries.length, 110, 'duplicated links do not duplicate entries');
    assert.strictEqual(ti.entries[0].name, 'CellPutN');
    assert.strictEqual(ti.entries[0].id, 't-0');
    assert.strictEqual(ti.entries[0].category, 'Cat 1', "the category page's title, not the (abbreviated) link text");
    assert.match(ti.entries[0].source, new RegExp(`/docs/${lang}/planning-analytics/2\\.1\\.0\\?topic=SSD29G_2\\.1\\.0/t-0\\.html$`));
    const rules = JSON.parse(fs.readFileSync(path.join(out, lang, 'rules.json'), 'utf8'));
    assert.deepStrictEqual(rules.entries.map((e) => e.id).slice(0, 2), ['r-0', 'r-1'], "IBM's order is kept");
    assert.strictEqual(rules.entries.at(-1).id, 'op');
    assert.strictEqual(rules.entries.at(-1).category, lang === 'en' ? 'Operators' : 'Operatoren', 'page directly under the root gets the fallback category');
  }
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(out, 'meta.json'), 'utf8')).counts, summary.counts);
  assert.deepStrictEqual(progress[0], { done: 0, total: 0 });
  const last = progress.at(-1);
  assert.strictEqual(last.done, last.total);
  assert.strictEqual(last.total, 2 * (1 + 110 + 2 + 60), 'every page below the roots is counted once per language');
  assert.ok(progress.every((p, i) => i === 0 || (p.done >= progress[i - 1].done && p.done - progress[i - 1].done <= 1 && p.total >= progress[i - 1].total)));
});

test('downloadDocs: a nested sub-category is flattened under the top-level category', async () => {
  const out = tmp();
  await downloadDocs({ outDir: out, languages: ['en'], fetchText: fakeFetch({ nested: 10 }), ...fast });
  const ti = JSON.parse(fs.readFileSync(path.join(out, 'en', 'ti.json'), 'utf8')).entries;
  assert.strictEqual(ti.length, 110);
  assert.ok(ti.every((e) => e.category === 'Cat 1'));
  assert.ok(ti.some((e) => e.id === 'n-9'), 'pages of the sub-category are included');
});

test('downloadDocs: the section roots are found wherever IBM keeps them', async () => {
  for (const location of LOCATIONS.filter(Boolean)) {
    const out = tmp();
    const summary = await downloadDocs({ outDir: out, languages: ['de'], fetchText: fakeFetch({ location }), ...fast });
    assert.deepStrictEqual(summary.counts, { de: ENTRIES }, location);
  }
});

test('downloadDocs: retries a flaky request', async () => {
  let failures = 0;
  const inner = fakeFetch();
  const fetchText = async (url) => {
    if (url.includes('t-3.html?lang=en') && failures++ < 1) throw Object.assign(new Error('HTTP 500'), { status: 500 });
    return inner(url);
  };
  const summary = await downloadDocs({ outDir: tmp(), fetchText, ...fast });
  assert.strictEqual(summary.counts.en.ti, 110);
  assert.strictEqual(failures, 2);
});

test('downloadDocs: everything failing rejects with the URL in the message', async () => {
  const inner = fakeFetch();
  const fetchText = async (url) => {
    if (/c1\.html|c2\.html|op\.html|t-|r-/.test(url)) throw Object.assign(new Error('HTTP 500'), { status: 500 });
    return inner(url);
  };
  await assert.rejects(downloadDocs({ outDir: tmp(), fetchText, ...fast }), /SSD29G_2\.1\.0\/(c1|c2|op)\.html\?lang=(en|de): HTTP 500/);
  await assert.rejects(
    downloadDocs({ outDir: tmp(), fetchText: async () => { throw Object.assign(new Error('HTTP 403'), { status: 403 }); }, ...fast }),
    (e) => e.status === 403 && /c_tm1turbointegratorfunctions_n70006\.html.*HTTP 403/.test(e.message)
  );
});

test('downloadDocs: a language IBM does not serve is reported, the other one is still downloaded', async () => {
  const out = tmp();
  const summary = await downloadDocs({ outDir: out, fetchText: fakeFetch({ unavailable: ['de'] }), ...fast });
  assert.deepStrictEqual(Object.keys(summary.counts), ['en']);
  assert.match(summary.failed.de, /lang=de: HTTP 404/);
  assert.deepStrictEqual(summary.kept, []);
  assert.ok(fs.existsSync(path.join(out, 'en', 'ti.json')));
  assert.ok(!fs.existsSync(path.join(out, 'de')), 'no half-written German directory');
});

test('downloadDocs: a page failing in one language only drops that language', async () => {
  const inner = fakeFetch();
  const fetchText = async (url) => {
    if (url.includes('r-5.html?lang=de')) throw Object.assign(new Error('HTTP 500'), { status: 500 });
    return inner(url);
  };
  const out = tmp();
  const summary = await downloadDocs({ outDir: out, fetchText, ...fast });
  assert.deepStrictEqual(Object.keys(summary.counts), ['en']);
  assert.match(summary.failed.de, /HTTP 500/);
  assert.ok(!fs.existsSync(path.join(out, 'de')));
});

test('updateDocs: previous data of a language that is now unavailable is kept, the rest is updated', async () => {
  const final = path.join(tmp(), 'docs');
  const first = await updateDocs(final, { fetchText: fakeFetch(), ...fast });
  const germanBefore = fs.readFileSync(path.join(final, 'de', 'ti.json'), 'utf8');
  await new Promise((r) => setTimeout(r, 5));

  const summary = await updateDocs(final, { fetchText: fakeFetch({ ti: 120, unavailable: ['de'] }), ...fast });

  assert.deepStrictEqual(summary.kept, ['de']);
  assert.strictEqual(summary.counts.en.ti, 120, 'English was updated');
  assert.strictEqual(summary.counts.de.ti, 110, 'German counts come from the previous download');
  assert.strictEqual(fs.readFileSync(path.join(final, 'de', 'ti.json'), 'utf8'), germanBefore);
  assert.strictEqual(summary.languages.de.fetched, first.languages.de.fetched, 'German keeps its own date');
  assert.notStrictEqual(summary.languages.en.fetched, first.languages.en.fetched);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(final, 'meta.json'), 'utf8')).kept, ['de']);
  assert.deepStrictEqual(fs.readdirSync(path.dirname(final)), ['docs']);
});

test('downloadDocs: implausible or changed pages are rejected', async () => {
  await assert.rejects(downloadDocs({ outDir: tmp(), fetchText: fakeFetch({ ti: 5 }), ...fast }), /Only 5 pages found for en\/ti; expected at least 100/);
  // IBM moved the roots somewhere we do not look: 404 everywhere
  await assert.rejects(downloadDocs({ outDir: tmp(), fetchText: async () => { throw notFound(); }, ...fast }), (e) => e.status === 404);
  // pages without any child links
  await assert.rejects(downloadDocs({ outDir: tmp(), fetchText: async () => '<html><h1>Oops</h1></html>', ...fast }), /Only 0 pages found/);
  // a rejected download never touches existing data
  const final = path.join(tmp(), 'docs');
  fs.mkdirSync(final);
  fs.writeFileSync(path.join(final, 'keep.txt'), 'old');
  await assert.rejects(updateDocs(final, { fetchText: fakeFetch({ ti: 5 }), ...fast }));
  assert.strictEqual(fs.readFileSync(path.join(final, 'keep.txt'), 'utf8'), 'old');
});

test('downloadDocs: cancel stops quickly', async () => {
  let calls = 0;
  const fetchText = fakeFetch({}, () => calls++);
  await assert.rejects(downloadDocs({ outDir: tmp(), fetchText, isCancelled: () => calls > 10, ...fast }), CancelledError);
  assert.ok(calls < 30, `${calls} requests after cancel`);
});

test('updateDocs: replaces the old documentation on success', async () => {
  const final = path.join(tmp(), 'docs');
  fs.mkdirSync(path.join(final, 'en'), { recursive: true });
  fs.writeFileSync(path.join(final, 'old.txt'), 'old');
  await updateDocs(final, { fetchText: fakeFetch(), ...fast });
  assert.ok(!fs.existsSync(path.join(final, 'old.txt')));
  assert.ok(fs.existsSync(path.join(final, 'en', 'ti.json')));
  assert.deepStrictEqual(fs.readdirSync(path.dirname(final)), ['docs'], 'no temp or backup directories left');
});

test('updateDocs: first download creates the directory', async () => {
  const final = path.join(tmp(), 'storage', 'docs');
  fs.mkdirSync(path.dirname(final));
  await updateDocs(final, { fetchText: fakeFetch(), ...fast });
  assert.ok(fs.existsSync(path.join(final, 'meta.json')));
});

test('updateDocs: failure or cancel keeps the old documentation untouched', async () => {
  const final = path.join(tmp(), 'docs');
  fs.mkdirSync(final, { recursive: true });
  fs.writeFileSync(path.join(final, 'keep.txt'), 'old');

  await assert.rejects(updateDocs(final, { fetchText: async () => { throw new Error('offline'); }, ...fast }), /offline/);
  let calls = 0;
  await assert.rejects(updateDocs(final, { fetchText: fakeFetch({}, () => calls++), isCancelled: () => calls > 5, ...fast }), CancelledError);

  assert.strictEqual(fs.readFileSync(path.join(final, 'keep.txt'), 'utf8'), 'old');
  assert.deepStrictEqual(fs.readdirSync(path.dirname(final)), ['docs'], 'temp directory cleaned up');
});

test('updateDocs: previous data without meta.json (older layout) is still kept for an unavailable language', async () => {
  const final = path.join(tmp(), 'docs');
  await updateDocs(final, { fetchText: fakeFetch(), ...fast });
  fs.rmSync(path.join(final, 'meta.json'));
  const summary = await updateDocs(final, { fetchText: fakeFetch({ unavailable: ['de'] }), ...fast });
  assert.deepStrictEqual(summary.kept, ['de']);
  assert.deepStrictEqual(summary.counts.de, ENTRIES);
  assert.ok(summary.languages.de.fetched, 'date taken from the file');
});

test('updateDocs: a damaged previous language is not carried over', async () => {
  const final = path.join(tmp(), 'docs');
  await updateDocs(final, { fetchText: fakeFetch(), ...fast });
  fs.writeFileSync(path.join(final, 'de', 'rules.json'), '{ broken');
  const summary = await updateDocs(final, { fetchText: fakeFetch({ unavailable: ['de'] }), ...fast });
  assert.deepStrictEqual(summary.kept, []);
  assert.ok(!fs.existsSync(path.join(final, 'de')), 'no half German directory');
  assert.ok(fs.existsSync(path.join(final, 'en', 'ti.json')));
});

// ---- transport --------------------------------------------------------------------------------

const zlib = require('zlib');
const { Readable } = require('stream');

const curlMissing = (_file, _args, _opts, cb) => {
  setImmediate(() => cb(Object.assign(new Error('spawn curl ENOENT'), { code: 'ENOENT' }), Buffer.alloc(0), Buffer.alloc(0)));
  return {};
};
function withStubs({ fetch, httpsGet, execFile }, fn) {
  const realFetch = global.fetch;
  const realGet = https.get;
  const realExec = childProcess.execFile;
  global.fetch = fetch || (() => { throw new Error('fetch must not be used'); });
  https.get = httpsGet || (() => { throw new Error('https must not be used'); });
  childProcess.execFile = execFile || curlMissing;
  return Promise.resolve(fn()).finally(() => {
    global.fetch = realFetch;
    https.get = realGet;
    childProcess.execFile = realExec;
  });
}
const okFetch = (body) => async () => ({ status: 200, text: async () => body });
const statusFetch = (status, page = '') => async () => ({ status, headers: { get: (n) => (n === 'server' ? 'AkamaiGHost' : null) }, text: async () => page });
/** https.get stub; `seen` collects the request options */
const fakeHttpsGet = (status, body, { encoding, seen, server } = {}) => (_url, opts, cb) => {
  if (seen) seen.push(opts);
  const payload = encoding === 'gzip' ? zlib.gzipSync(body) : encoding === 'deflate' ? zlib.deflateSync(body) : Buffer.from(body);
  const res = Object.assign(Readable.from([payload]), { statusCode: status, headers: { ...(encoding ? { 'content-encoding': encoding } : {}), ...(server ? { server } : {}) } });
  setImmediate(() => cb(res));
  return { setTimeout() {}, on() {}, destroy() {} };
};

test('httpGetText: https first, with the headers IBM requires', async () => {
  const seen = [];
  await withStubs({ httpsGet: fakeHttpsGet(200, 'hello', { seen }) }, async () => {
    assert.strictEqual(await httpGetText('https://x/y'), 'hello');
  });
  const h = seen[0].headers;
  assert.strictEqual(h['user-agent'], 'vscode-tm1-reference', 'honest user agent');
  for (const name of ['accept', 'accept-language', 'accept-encoding']) assert.ok(h[name], name);
  assert.strictEqual(h.connection, 'keep-alive');
  assert.strictEqual(seen[0].agent, undefined, "no own agent, so VS Code's proxy support stays in charge");
});

test('httpGetText: gzip and deflate responses are decoded', async () => {
  const text = 'Würfel ünd mehr '.repeat(100);
  for (const encoding of ['gzip', 'deflate']) {
    await withStubs({ httpsGet: fakeHttpsGet(200, text, { encoding }) }, async () => {
      assert.strictEqual(await httpGetText('https://x/y'), text, encoding);
    });
  }
});

test('httpGetText: HTTP 403 from https -> fetch is tried (and its result used)', async () => {
  await withStubs({ httpsGet: fakeHttpsGet(403, ''), fetch: okFetch('via fetch') }, async () => {
    assert.strictEqual(await httpGetText('https://x/y'), 'via fetch');
  });
});

test('httpGetText: network error from https -> fetch is tried', async () => {
  const httpsGet = () => { throw new Error('socket'); };
  await withStubs({ httpsGet, fetch: okFetch('via fetch') }, async () => {
    assert.strictEqual(await httpGetText('https://x/y'), 'via fetch');
  });
});

test('httpGetText: 404 and other statuses are final (no second transport)', async () => {
  await withStubs({ httpsGet: fakeHttpsGet(404, '') }, async () => {
    await assert.rejects(httpGetText('https://x/y'), (e) => e.status === 404 && /^HTTP 404$/.test(e.message));
  });
  // other HTTP errors: final, fetch (whose stub throws when used) is never tried
  await withStubs({ httpsGet: fakeHttpsGet(500, '') }, async () => {
    await assert.rejects(httpGetText('https://x/y'), (e) => e.status === 500);
  });
});

test('httpGetText: both transports refused -> message names both, status 403 kept, details for the log', async () => {
  const page = '<html><head><title>Access Denied</title><style>.x{}</style></head><body><script>var a=1</script>Reference&nbsp;#18.abc</body></html>';
  await withStubs({ httpsGet: fakeHttpsGet(403, page, { server: 'AkamaiGHost' }), fetch: statusFetch(403, page) }, async () => {
    await assert.rejects(httpGetText('https://x/y'), (e) => {
      assert.strictEqual(e.status, 403);
      assert.match(e.message, /HTTP 403 \(https\), HTTP 403 \(fetch\)/);
      assert.deepStrictEqual(e.details.map((d) => [d.via, d.server]), [['https', 'AkamaiGHost'], ['fetch', 'AkamaiGHost']]);
      assert.match(e.details[0].page, /^Access Denied Reference/, 'tags, style and script stripped');
      assert.ok(!/var a|\.x\{/.test(e.details[0].page));
      return true;
    });
  });
});

test('httpGetText: fetch does not send the connection header it must not set', async () => {
  let sent;
  const fetch = async (_url, opts) => { sent = opts.headers; return { status: 200, text: async () => 'ok' }; };
  await withStubs({ httpsGet: fakeHttpsGet(403, ''), fetch }, async () => {
    await httpGetText('https://x/y');
  });
  assert.ok(sent['accept-language'] && sent['accept-encoding'] && !('connection' in sent));
});

// ---- curl as the last resort ---------------------------------------------------------------------

/** execFile stub for curl: answers `body` + "\n" + status; `seen` collects file, args and options */
const fakeCurl = (status, body = '', { seen, error, stderr = '' } = {}) => (file, args, opts, cb) => {
  if (seen) seen.push({ file, args, opts });
  setImmediate(() => cb(error || null, status === null ? Buffer.alloc(0) : Buffer.from(`${body}\n${status}`), Buffer.from(stderr)));
  return {};
};
const refusing = { httpsGet: fakeHttpsGet(403, ''), fetch: statusFetch(403) };

test('curl is used after https and fetch were refused', async () => {
  const seen = [];
  await withStubs({ ...refusing, execFile: fakeCurl(200, 'from curl\nwith two lines', { seen }) }, async () => {
    assert.strictEqual(await httpGetText('https://x/y?a=1&b=2'), 'from curl\nwith two lines');
  });
  const { file, args, opts } = seen[0];
  assert.strictEqual(file, process.platform === 'win32' ? 'curl.exe' : 'curl');
  assert.deepStrictEqual(args.slice(-2), ['--url', 'https://x/y?a=1&b=2'], 'URL only as the value of --url, never as a free argument');
  assert.ok(args.includes('--compressed') && args.includes('--silent'));
  assert.ok(!args.some((a) => /^-A$|--user-agent|^-H$|--header/.test(a)), "curl's own user agent and headers stay untouched");
  assert.strictEqual(opts.windowsHide, true);
});

test('curl: UTF-8 bodies and bodies without a trailing newline survive', async () => {
  await withStubs({ ...refusing, execFile: fakeCurl(200, 'Würfel — ü') }, async () => {
    assert.strictEqual(await httpGetText('https://x/y'), 'Würfel — ü');
  });
});

test('the transport that worked is remembered: later requests go straight to curl', async () => {
  let httpsCalls = 0;
  let fetchCalls = 0;
  const get = (...a) => { httpsCalls++; return fakeHttpsGet(403, '')(...a); };
  const fetch = async () => { fetchCalls++; return { status: 403, headers: { get: () => null }, text: async () => '' }; };
  const seen = [];
  await withStubs({ httpsGet: get, fetch, execFile: fakeCurl(200, 'ok', { seen }) }, async () => {
    const fetcher = createFetcher();
    for (let i = 0; i < 5; i++) assert.strictEqual(await fetcher(`https://x/${i}`), 'ok');
  });
  assert.deepStrictEqual([httpsCalls, fetchCalls, seen.length], [1, 1, 5]);
});

test('a remembered transport that starts failing is replaced by the next one that works', async () => {
  let curlWorks = true;
  const exec = (...a) => (curlWorks ? fakeCurl(200, 'curl') : fakeCurl(403, ''))(...a);
  await withStubs({ httpsGet: fakeHttpsGet(403, ''), fetch: statusFetch(403), execFile: exec }, async () => {
    const fetcher = createFetcher();
    assert.strictEqual(await fetcher('https://x/1'), 'curl');
    curlWorks = false;
  });
  await withStubs({ httpsGet: fakeHttpsGet(200, 'https again'), fetch: statusFetch(403), execFile: fakeCurl(403, '') }, async () => {
    // new fetcher state is not needed to prove it: a fetcher whose preferred transport failed tries the others
    const fetcher = createFetcher({ order: ['https', 'curl'], transports: () => ({ https: (u, o) => require('../src/docs').httpsGetText(u, o), curl: (u, o) => curlGetText(u, o) }) });
    assert.strictEqual(await fetcher('https://x/2'), 'https again');
  });
});

test('curl refused as well -> all three are named, curl details in the log data', async () => {
  const page = '<html><title>Access Denied</title>Reference #9</html>';
  await withStubs({ ...refusing, execFile: fakeCurl(403, page) }, async () => {
    await assert.rejects(httpGetText('https://x/y'), (e) => {
      assert.strictEqual(e.status, 403);
      assert.match(e.message, /HTTP 403 \(https\), HTTP 403 \(fetch\), HTTP 403 \(curl\)/);
      assert.deepStrictEqual(e.details.map((d) => d.via), ['https', 'fetch', 'curl'], 'one detail record per transport, in the order tried');
      assert.match(e.details.find((d) => d.via === 'curl').page, /^Access Denied Reference #9$/);
      return true;
    });
  });
});

test('curl: 404 is final, a network error is a failure like the others, curl missing is silent', async () => {
  await withStubs({ ...refusing, execFile: fakeCurl(404, '') }, async () => {
    await assert.rejects(httpGetText('https://x/y'), (e) => e.status === 404 && e.message === 'HTTP 404');
  });
  const failed = fakeCurl(null, '', { error: Object.assign(new Error('Command failed'), { code: 6 }), stderr: 'curl: (6) Could not resolve host: x' });
  await withStubs({ ...refusing, execFile: failed }, async () => {
    await assert.rejects(httpGetText('https://x/y'), /HTTP 403 \(https\), HTTP 403 \(fetch\), curl: \(6\) Could not resolve host: x \(curl\)/);
  });
  await withStubs({ ...refusing }, async () => {
    await assert.rejects(httpGetText('https://x/y'), (e) => e.message === 'HTTP 403 (https), HTTP 403 (fetch)');
  });
});

test('curlGetText: a status of 0 or garbage after the body is an error, not a success', async () => {
  await withStubs({ execFile: (f, a, o, cb) => { setImmediate(() => cb(null, Buffer.from('body\n000'), Buffer.alloc(0))); return {}; } }, async () => {
    await assert.rejects(curlGetText('https://x/y'), /curl failed/);
  });
  await withStubs({ execFile: (f, a, o, cb) => { setImmediate(() => cb(null, Buffer.from('no status line at all'), Buffer.alloc(0))); return {}; } }, async () => {
    await assert.rejects(curlGetText('https://x/y'), /curl failed/);
  });
});


// ---- only the selected language ----------------------------------------------------------------

const sha = (file) => require('crypto').createHash('sha1').update(fs.readFileSync(file)).digest('hex');

test('languages: only the requested language is fetched and written', async () => {
  const urls = [];
  const out = tmp();
  const summary = await downloadDocs({ outDir: out, languages: ['en'], fetchText: fakeFetch({}, (u) => urls.push(u)), ...fast });
  assert.ok(urls.length > 0 && urls.every((u) => u.includes('lang=en')), 'no request for the other language');
  assert.deepStrictEqual(Object.keys(summary.counts), ['en']);
  assert.ok(fs.existsSync(path.join(out, 'en', 'ti.json')) && !fs.existsSync(path.join(out, 'de')));
});

test('languages: unknown or empty language list is rejected before any request', async () => {
  let calls = 0;
  const fetchText = async () => { calls++; return ''; };
  await assert.rejects(downloadDocs({ outDir: tmp(), languages: ['fr'], fetchText }), /Unknown language: fr/);
  await assert.rejects(downloadDocs({ outDir: tmp(), languages: [], fetchText }), /Unknown language/);
  assert.strictEqual(calls, 0);
});

test('updateDocs with one language: the other language stays byte for byte as it was, with its own date', async () => {
  const final = path.join(tmp(), 'docs');
  const first = await updateDocs(final, { fetchText: fakeFetch(), ...fast });
  const enBefore = ['ti', 'rules'].map((s) => sha(path.join(final, 'en', `${s}.json`)));
  const deBefore = sha(path.join(final, 'de', 'ti.json'));

  const urls = [];
  await new Promise((r) => setTimeout(r, 5)); // a later timestamp
  const summary = await updateDocs(final, { languages: ['de'], fetchText: fakeFetch({ ti: 120 }, (u) => urls.push(u)), ...fast });

  assert.ok(urls.every((u) => u.includes('lang=de')));
  assert.deepStrictEqual(['ti', 'rules'].map((s) => sha(path.join(final, 'en', `${s}.json`))), enBefore, 'English untouched');
  assert.notStrictEqual(sha(path.join(final, 'de', 'ti.json')), deBefore, 'German replaced');
  assert.deepStrictEqual(summary.counts, { en: ENTRIES, de: { ti: 120, rules: 61 } });
  assert.strictEqual(summary.languages.en.fetched, first.languages.en.fetched, 'English keeps its date');
  assert.notStrictEqual(summary.languages.de.fetched, first.languages.de.fetched);
  assert.deepStrictEqual(summary.failed, {});
  assert.deepStrictEqual(summary.kept, [], '`kept` is only for languages that were requested but unavailable');
  assert.deepStrictEqual(fs.readdirSync(path.dirname(final)), ['docs']);
});

test('updateDocs with one language and nothing installed yet: just that language', async () => {
  const final = path.join(tmp(), 'docs');
  const summary = await updateDocs(final, { languages: ['de'], fetchText: fakeFetch(), ...fast });
  assert.deepStrictEqual(Object.keys(summary.counts), ['de']);
  assert.ok(!fs.existsSync(path.join(final, 'en')));
});

test('the requested language is unavailable (404): rejects with status, no retries, nothing changes', async () => {
  const final = path.join(tmp(), 'docs');
  await updateDocs(final, { languages: ['en'], fetchText: fakeFetch(), ...fast });
  const before = sha(path.join(final, 'en', 'ti.json'));
  let rootCalls = 0;
  const inner = fakeFetch({ unavailable: ['de'] }, (u) => { if (u.includes('lang=de')) rootCalls++; });
  await assert.rejects(updateDocs(final, { languages: ['de'], fetchText: inner, attempts: 4, retryDelayMs: 1 }), (e) => {
    assert.strictEqual(e.status, 404);
    assert.match(e.message, /lang=de: HTTP 404/);
    return true;
  });
  assert.strictEqual(rootCalls, LOCATIONS.length, 'each possible root location tried once, a 404 is not retried');
  assert.strictEqual(sha(path.join(final, 'en', 'ti.json')), before);
  assert.ok(!fs.existsSync(path.join(final, 'de')));
});

test('errors keep status and details through the retry wrapper; 403 is not retried, 500 is', async () => {
  let calls = 0;
  const detail = { via: 'curl', page: 'Access Denied' };
  const blocked = async () => { calls++; throw Object.assign(new Error('HTTP 403 (https), HTTP 403 (curl)'), { status: 403, details: [detail] }); };
  await assert.rejects(downloadDocs({ outDir: tmp(), languages: ['en'], fetchText: blocked, attempts: 4, retryDelayMs: 1 }), (e) => {
    assert.strictEqual(e.status, 403);
    assert.deepStrictEqual(e.details, [detail]);
    return true;
  });
  assert.strictEqual(calls, 1);

  calls = 0;
  const flaky = async () => { calls++; throw Object.assign(new Error('HTTP 500'), { status: 500 }); };
  await assert.rejects(downloadDocs({ outDir: tmp(), languages: ['en'], fetchText: flaky, attempts: 3, retryDelayMs: 1 }), (e) => e.status === 500);
  assert.strictEqual(calls, 3, '500 is retried');
});
