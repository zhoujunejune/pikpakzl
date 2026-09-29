import http from 'node:http';

const PORT = Number(process.env.PORT || 3000);
const ORIGIN = (process.env.SITE_ORIGIN || '').replace(/\/$/, '');
const candidatePaths = new Set([
  '/api/market',
  '/api/state',
  '/api/prediction',
  '/api/decision',
  '/api/status',
  '/api/z3-background/state',
  '/api/z3-background/latest',
  '/api/z3-background/decision'
]);
const relevantKey = /direction|prediction|predict|final|locked|decision|signal|result|outcome|confidence|score|recommend/i;

function pickRelevant(value, path = '', out = {}, depth = 0) {
  if (depth > 5 || value == null || Object.keys(out).length >= 50) return out;
  if (Array.isArray(value)) {
    for (let i = 0; i < Math.min(value.length, 20); i++) pickRelevant(value[i], `${path}[${i}]`, out, depth + 1);
    return out;
  }
  if (typeof value !== 'object') return out;
  for (const [k, v] of Object.entries(value)) {
    const p = path ? `${path}.${k}` : k;
    if ((typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') && relevantKey.test(k)) out[p] = v;
    else if (v && typeof v === 'object') pickRelevant(v, p, out, depth + 1);
    if (Object.keys(out).length >= 50) break;
  }
  return out;
}

async function fetchText(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  const text = await res.text();
  return { res, text };
}

async function discoverFromFrontend() {
  if (!ORIGIN) return;
  try {
    const { res, text } = await fetchText(`${ORIGIN}/`);
    console.log(JSON.stringify({ event: 'frontend_root', status: res.status, contentType: res.headers.get('content-type') || '' }));
    const scriptSrcs = [...text.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)].map(m => m[1]).slice(0, 25);
    const blobs = [text];
    for (const src of scriptSrcs) {
      try {
        const u = new URL(src, ORIGIN).toString();
        const r = await fetchText(u);
        if (r.res.ok && r.text.length < 3_000_000) blobs.push(r.text);
      } catch {}
    }
    const joined = blobs.join('\n');
    const apiMatches = joined.match(/\/api\/[A-Za-z0-9_?=&.\/-]+/g) || [];
    for (const raw of apiMatches) {
      const clean = raw.split('?')[0].replace(/["'`),;]+$/g, '');
      if (clean.length < 160 && /prediction|decision|signal|state|status|market|z3|final|lock|result/i.test(clean)) candidatePaths.add(clean);
    }
    console.log(JSON.stringify({ event: 'discovered_endpoints', count: candidatePaths.size, paths: [...candidatePaths].slice(0, 80) }));
  } catch (e) {
    console.log(JSON.stringify({ event: 'frontend_discovery_error', error: String(e?.message || e) }));
  }
}

async function probePath(path) {
  try {
    const res = await fetch(`${ORIGIN}${path}`, { method: 'GET', signal: AbortSignal.timeout(8000) });
    const ct = res.headers.get('content-type') || '';
    const out = { event: 'signal_probe', path, status: res.status, contentType: ct };
    if (ct.includes('application/json')) {
      try {
        const json = await res.json();
        if (json && typeof json === 'object' && !Array.isArray(json)) out.topLevelKeys = Object.keys(json).slice(0, 80);
        const relevant = pickRelevant(json);
        if (Object.keys(relevant).length) out.relevantFields = relevant;
      } catch (e) {
        out.parseError = String(e?.message || e);
      }
    }
    console.log(JSON.stringify(out));
  } catch (e) {
    console.log(JSON.stringify({ event: 'signal_probe', path, error: String(e?.message || e) }));
  }
}

async function runProbes() {
  if (!ORIGIN) {
    console.log(JSON.stringify({ event: 'diagnostic_blocked', reason: 'SITE_ORIGIN_MISSING' }));
    return;
  }
  for (const path of [...candidatePaths].slice(0, 80)) await probePath(path);
}

http.createServer((req, res) => {
  if (req.url === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, hasSiteOrigin: Boolean(ORIGIN), endpointCount: candidatePaths.size }));
    return;
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: true, service: 'prediction-signal-diagnostic' }));
}).listen(PORT, '0.0.0.0', () => console.log(JSON.stringify({ event: 'diagnostic_started', port: PORT, hasSiteOrigin: Boolean(ORIGIN) })));

await discoverFromFrontend();
await runProbes();
setInterval(runProbes, 60_000).unref();
