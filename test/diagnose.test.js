'use strict';
const test = require('node:test');
const assert = require('node:assert');
const https = require('https');
const childProcess = require('child_process');
const { Readable } = require('stream');
const { runProbes, formatReport, verdict, maskProxy } = require('../src/diagnose');

test('maskProxy: credentials never reach the report', () => {
  assert.strictEqual(maskProxy('http://user:s3cret@proxy.corp:8080'), 'http://***@proxy.corp:8080');
  assert.strictEqual(maskProxy('http://proxy.corp:8080'), 'http://proxy.corp:8080');
  assert.strictEqual(maskProxy(undefined), undefined);
  assert.ok(!formatReport({ proxy: maskProxy('http://u:p@h:1') }, []).includes('p@'));
});

/** Stubs both transports: answer(url, via, headers) -> status | 'error' */
async function withNetwork(answer, fn) {
  const realFetch = global.fetch;
  const realGet = https.get;
  const realExec = childProcess.execFile;
  const calls = [];
  childProcess.execFile = (file, args, opts, cb) => {
    const url = args[args.length - 1];
    calls.push(['curl', url, null]);
    const r = answer(url, 'curl', null);
    setImmediate(() => {
      if (r === 'missing') return cb(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }), Buffer.alloc(0), Buffer.alloc(0));
      if (r === 'error') return cb(new Error('failed'), Buffer.alloc(0), Buffer.from('curl: (6) Could not resolve host'));
      cb(null, Buffer.from(`${r === 200 ? 'ok' : '<html><title>Denied</title>Reference #1</html>'}\n${r}`), Buffer.alloc(0));
    });
    return {};
  };
  global.fetch = async (url, opts) => {
    calls.push(['fetch', url, opts.headers]);
    const r = answer(url, 'fetch', opts.headers);
    if (r === 'error') throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
    return { status: r, headers: { get: () => 'AkamaiGHost' }, text: async () => (r === 200 ? 'ok' : '<html><title>Denied</title>Reference #1</html>') };
  };
  https.get = (url, opts, cb) => {
    calls.push(['https', url, opts.headers]);
    const r = answer(url, 'https', opts.headers);
    const handlers = {};
    const req = { setTimeout() {}, on: (e, h) => { handlers[e] = h; return req; }, destroy() {} };
    setImmediate(() => {
      if (r === 'error') return handlers.error(new Error('socket hang up'));
      cb(Object.assign(Readable.from([Buffer.from(r === 200 ? 'ok' : '<html><title>Denied</title>Reference #1</html>')]), { statusCode: r, headers: { server: 'AkamaiGHost' } }));
    });
    return req;
  };
  try {
    return await fn(calls);
  } finally {
    global.fetch = realFetch;
    https.get = realGet;
    childProcess.execFile = realExec;
  }
}

test('runProbes: every combination is tried, errors are results not exceptions', async () => {
  await withNetwork((url) => (url.includes('example.com') ? 200 : 403), async (calls) => {
    const results = await runProbes({ timeoutMs: 50 });
    // neutral site: https, fetch (client headers) and curl; IBM: 3 targets x (2 profiles x 2 transports + curl)
    assert.strictEqual(results.length, 3 + 3 * (2 * 2 + 1));
    assert.ok(results.filter((r) => !r.ibm).every((r) => r.status === 200));
    const ibm = results.filter((r) => r.ibm);
    assert.ok(ibm.filter((r) => r.via !== 'curl').every((r) => r.status === 403 && r.server === 'AkamaiGHost' && /^Denied Reference #1$/.test(r.page)));
    assert.ok(ibm.filter((r) => r.via === 'curl').every((r) => r.status === 403 && /^Denied Reference #1$/.test(r.page)));
    // the "client headers" profile really carries the headers IBM needs, the other one does not
    const headersFor = (profile) => calls.filter((c) => c[1].includes('ibm.com') && c[0] === 'https').map((c) => c[2]);
    assert.ok(headersFor().some((h) => h['accept-language'] && h.connection === 'keep-alive'));
    assert.ok(headersFor().some((h) => !h['accept-language'] && !h.connection));
  });
  await withNetwork(() => 'error', async () => {
    const results = await runProbes({ timeoutMs: 50 });
    assert.ok(results.every((r) => r.error && r.status === undefined));
    assert.ok(results.some((r) => /ECONNRESET/.test(r.error)), 'fetch error code is shown');
  });
});

test('verdict: tells the three situations apart', async () => {
  const run = (answer) => withNetwork(answer, () => runProbes({ timeoutMs: 50 }));
  assert.match(verdict(await run(() => 'error')), /No connection to the internet/);
  assert.match(verdict(await run((url) => (url.includes('example.com') ? 200 : 403))), /refuses every request.*including curl.*Import Documentation from File/);
  // the situation of the Windows machine: https and fetch refused, curl accepted
  const curlOnly = verdict(await run((url, via) => (url.includes('example.com') || via === 'curl' ? 200 : 403)));
  assert.match(curlOnly, /IBM answers for: curl with curl defaults\. The download uses curl automatically\./);
  assert.match(verdict(await run((url, via, h) => (url.includes('example.com') || (via === 'https' && h['accept-language']) ? 200 : 403))), /IBM answers for: https with client headers/);
});

test('formatReport: environment, one line per probe, result', async () => {
  const results = await withNetwork((url) => (url.includes('example.com') ? 200 : 403), () => runProbes({ timeoutMs: 50 }));
  const report = formatReport({ 'VS Code': '1.99.0', Remote: undefined }, results);
  assert.match(report, /^=== TM1 Reference: connection check ===\nVS Code: 1\.99\.0\nRemote: -\n/);
  assert.match(report, /HTTP 403 +https +client headers +IBM root en +\d+ ms server=AkamaiGHost page="Denied Reference #1"/);
  assert.match(report, /HTTP 403 +curl +curl defaults +IBM root en +\d+ ms page="Denied Reference #1"/);
  assert.match(report, /\nResult: /);
});

test('runProbes: curl not installed is reported as such, not as a block', async () => {
  await withNetwork((url, via) => (via === 'curl' ? 'missing' : url.includes('example.com') ? 200 : 403), async () => {
    const results = await runProbes({ timeoutMs: 50 });
    const curl = results.filter((r) => r.via === 'curl');
    assert.ok(curl.length && curl.every((r) => r.error === 'curl is not installed' && r.status === undefined));
  });
});
