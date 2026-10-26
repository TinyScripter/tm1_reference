'use strict';

// "TM1 Reference: Check Connection": tries several ways to reach IBM (and a neutral site) and writes a
// report to the output channel, so a blocked download can be understood from one copy and paste.

const https = require('https');
const zlib = require('zlib');
const { REQUEST_HEADERS, snippetOf, curlGetText } = require('./docs');

const IBM = 'https://www.ibm.com/docs/api/v1/content/SSD29G_2.1.0';
const TARGETS = [
  { name: 'neutral site', url: 'https://example.com/', ibm: false },
  { name: 'IBM root en', url: `${IBM}/c_tm1turbointegratorfunctions_n70006.html?lang=en`, ibm: true },
  { name: 'IBM root de', url: `${IBM}/c_tm1turbointegratorfunctions_n70006.html?lang=de`, ibm: true },
  { name: 'IBM rules en', url: `${IBM}/c_rulesfunctions_n80006.html?lang=en`, ibm: true },
];
// what is sent: the headers the extension uses, or only a user agent
const PROFILES = {
  'client headers': { ...REQUEST_HEADERS, connection: 'keep-alive' },
  'user agent only': { 'user-agent': REQUEST_HEADERS['user-agent'] },
};

function probeHttps(url, headers, timeoutMs) {
  return new Promise((resolve) => {
    const started = Date.now();
    const done = (result) => resolve({ ms: Date.now() - started, ...result });
    const req = https.get(url, { headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('error', (err) => done({ error: err.message }));
      res.on('end', () => {
        let page = '';
        try {
          const enc = String(res.headers['content-encoding'] || '').toLowerCase();
          let body = Buffer.concat(chunks);
          if (enc === 'gzip') body = zlib.gunzipSync(body);
          else if (enc === 'deflate') body = zlib.inflateSync(body);
          page = res.statusCode === 200 ? '' : snippetOf(body.toString('utf8'));
        } catch {
          /* undecodable body: no snippet */
        }
        done({ status: res.statusCode, server: res.headers.server, page });
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
    req.on('error', (err) => done({ error: err.message }));
  });
}

async function probeFetch(url, headers, timeoutMs) {
  const started = Date.now();
  const { connection, ...rest } = headers; // fetch manages the connection itself
  try {
    const res = await fetch(url, { headers: rest, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
    const page = res.status === 200 ? '' : snippetOf(await res.text().catch(() => ''));
    return { ms: Date.now() - started, status: res.status, server: res.headers.get('server'), page };
  } catch (err) {
    return { ms: Date.now() - started, error: err && (err.cause && err.cause.code ? `${err.message} (${err.cause.code})` : err.message) };
  }
}

/** curl with its own defaults (the download uses it as the last resort). */
async function probeCurl(url, _headers, timeoutMs) {
  const started = Date.now();
  try {
    await curlGetText(url, { timeoutMs });
    return { ms: Date.now() - started, status: 200 };
  } catch (err) {
    if (err.unavailable) return { ms: Date.now() - started, error: 'curl is not installed' };
    return { ms: Date.now() - started, status: err.status, error: err.status ? undefined : err.message, page: err.detail && err.detail.page };
  }
}

/** All probes run in parallel; each resolves (never rejects) with status or error. */
async function runProbes({ timeoutMs = 15000 } = {}) {
  const jobs = [];
  for (const target of TARGETS) {
    for (const [profile, headers] of Object.entries(PROFILES)) {
      if (!target.ibm && profile === 'user agent only') continue;
      for (const via of ['https', 'fetch']) {
        if (via === 'fetch' && typeof fetch !== 'function') continue;
        const run = via === 'https' ? probeHttps : probeFetch;
        jobs.push(run(target.url, headers, timeoutMs).then((r) => ({ target: target.name, ibm: target.ibm, via, profile, ...r })));
      }
    }
  }
  for (const target of TARGETS) {
    jobs.push(probeCurl(target.url, null, timeoutMs).then((r) => ({ target: target.name, ibm: target.ibm, via: 'curl', profile: 'curl defaults', ...r })));
  }
  return Promise.all(jobs);
}

/** user:password@ in a proxy URL must never end up in a report */
function maskProxy(value) {
  if (!value) return value;
  return String(value).replace(/\/\/[^/@\s]*@/, '//***@');
}

function verdict(results) {
  const ok = (r) => r.status === 200;
  const neutral = results.filter((r) => !r.ibm);
  const ibm = results.filter((r) => r.ibm);
  if (neutral.length && !neutral.some(ok)) {
    return 'No connection to the internet from VS Code (neutral site fails): check proxy / VPN / firewall settings.';
  }
  const working = ibm.filter(ok);
  if (working.length === 0) {
    const blocked = ibm.filter((r) => r.status === 403).length;
    return blocked
      ? 'IBM refuses every request with HTTP 403 (bot protection), including curl. Use "TM1 Reference: Import Documentation from File".'
      : 'IBM could not be reached (see errors above).';
  }
  const ways = [...new Set(working.map((r) => `${r.via} with ${r.profile}`))].join('; ');
  const onlyCurl = working.every((r) => r.via === 'curl');
  return `IBM answers for: ${ways}.${onlyCurl ? ' The download uses curl automatically.' : ''}`;
}

function formatReport(env, results) {
  const lines = ['=== TM1 Reference: connection check ==='];
  for (const [key, value] of Object.entries(env)) lines.push(`${key}: ${value === undefined || value === '' ? '-' : value}`);
  lines.push('');
  for (const r of results) {
    const outcome = r.error ? `ERROR ${r.error}` : `HTTP ${r.status}`;
    const extra = [r.server ? `server=${r.server}` : '', r.page ? `page="${r.page}"` : ''].filter(Boolean).join(' ');
    lines.push(`${outcome.padEnd(22)} ${r.via.padEnd(5)} ${r.profile.padEnd(15)} ${r.target.padEnd(13)} ${r.ms} ms ${extra}`.trimEnd());
  }
  lines.push('', `Result: ${verdict(results)}`);
  return lines.join('\n');
}

module.exports = { runProbes, formatReport, verdict, maskProxy, TARGETS };
