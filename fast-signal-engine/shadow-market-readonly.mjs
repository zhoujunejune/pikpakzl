// Binance public OHLCV -> Railway read-only data feed for the standalone Cloudflare shadow.
// Does not import or write production signals, trading controls, Redis, or orders.
const SYMBOL = 'BTCUSDT';
const PROVIDERS = ['https://data-api.binance.vision', 'https://api.binance.com'];
const LIMITS = Object.freeze({ '1m': 1000, '5m': 240 });
const CACHE_MS = 1800;
const MAX_SPOT_AGE_MS = 12000;

const finite = (v) => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : null;
const errorMessage = (e) => String(e?.message || e).slice(0, 180);

export function createReadOnlyMarketFeed({
  fetchImpl = globalThis.fetch,
  live = () => null,
  now = () => Date.now(),
  wsCandles = () => [],
  allowRest = () => true,
} = {}) {
  let cache = null;
  let inFlight = null;

  async function getCandles(interval) {
    const errors = [];
    // Prefer Binance's actual *closed* spot WebSocket klines, recorded by V3.
    // Never interpolate missing periods, substitute futures, or use synthetic OHLCV.
    const duration = interval === '1m' ? 60000 : 300000;
    try {
      const rows = wsCandles(interval);
      if (Array.isArray(rows) && rows.length >= 35) {
        const valid = rows.every((r,i) => r?.closed === true &&
          [r.startMs,r.open,r.high,r.low,r.close,r.volume,r.endMs].every(v =>
            Number.isFinite(Number(v))) &&
          (i===0 || r.startMs-rows[i-1].startMs===duration));
        const last=rows.at(-1);
        const age=now()-last.startMs;
        if(valid && age>=0 && age<=(interval==='1m'?125000:610000)) {
          return {interval,provider:'BINANCE_SPOT_WEBSOCKET_CLOSED_KLINES',
            rows,lastCandleStartMs:last.startMs,ageMs:age};
        }
        errors.push('WS_KLINES_DISCONTINUOUS_OR_STALE');
      } else {
        errors.push('WS_WARMING_UP_'+(Array.isArray(rows)?rows.length:0)+'_OF_35');
      }
    } catch(e){errors.push('WS_ERROR_'+errorMessage(e));}
    // Render Free egress Spot REST returned 418; do not repeatedly probe banned IP.
    if (!allowRest()) throw new Error(interval+'_WS_ONLY_'+errors.join('|').slice(0,180));
    for (const origin of PROVIDERS) {
      try {
        const endpoint = origin + '/api/v3/klines?symbol=' + SYMBOL + '&interval=' + interval + '&limit=' + LIMITS[interval];
        const response = await fetchImpl(endpoint, {
          method: 'GET', cache: 'no-store', signal: AbortSignal.timeout(2600),
          headers: { accept: 'application/json' },
        });
        if (!response.ok) throw new Error('HTTP_' + response.status);
        const raw = await response.json();
        if (!Array.isArray(raw) || raw.length < 35) throw new Error('INSUFFICIENT_CANDLES');
        const at = now();
        const rows = raw.map((r) => {
          if (!Array.isArray(r) || r.length < 7) throw new Error('INVALID_ROW');
          const values = r.slice(0, 7).map(finite);
          if (values.some(v => v === null)) throw new Error('NON_NUMERIC_CANDLE');
          return {
            startMs: values[0], open: values[1], high: values[2], low: values[3],
            close: values[4], volume: values[5], endMs: values[6],
            closed: at > values[6],
          };
        });
        const last = rows.at(-1);
        const age = at - last.startMs;
        if (age < -3000 || age > (interval === '1m' ? 125000 : 610000)) {
          throw new Error('STALE_CANDLES');
        }
        return { interval, provider: origin, rows, lastCandleStartMs: last.startMs, ageMs: age };
      } catch (e) {
        errors.push(origin + ':' + errorMessage(e));
      }
    }
    throw new Error(interval + '_UNAVAILABLE_' + errors.join('|').slice(0, 180));
  }

  function spot() {
    const snapshot = live();
    const facts = snapshot?.signal?.facts;
    const integrity = snapshot?.dataIntegrity;
    const at = finite(snapshot?.signal?.factsCalculatedAt);
    const price = finite(facts?.lastPrice);
    const age = at === null ? null : now() - at;
    if (!integrity?.wsConnected || price === null || price <= 0 ||
        age === null || age > MAX_SPOT_AGE_MS || age < -3000) {
      throw new Error('RAILWAY_SPOT_DATA_MISSING_OR_STALE');
    }
    return {
      source: 'BINANCE_SPOT_WEBSOCKET_V3_COLLECTOR',
      eventMs: at, ageMs: age, lastPrice: price,
      roundStartMs: finite(snapshot?.signal?.roundStartMs),
      roundOpenPrice: finite(facts?.roundOpenPrice),
      marketFeedConnected: true,
    };
  }

  async function assemble() {
    const results = await Promise.allSettled([getCandles('1m'), getCandles('5m')]);
    const one = results[0].status === 'fulfilled' ? results[0].value : null;
    const five = results[1].status === 'fulfilled' ? results[1].value : null;
    let latest = null, spotError = null;
    try { latest = spot(); } catch (e) { spotError = errorMessage(e); }
    const errors = results.flatMap((r, i) =>
      r.status === 'rejected' ? [(i === 0 ? '1m:' : '5m:') + errorMessage(r.reason)] : []);
    if (spotError) errors.push('spot:' + spotError);
    const ok = Boolean(one && five && latest);
    return {
      ok, schemaVersion: 1, service: 'breakout20-shadow-market-readonly',
      symbol: SYMBOL, readOnly: true, generatedAtMs: now(),
      source: one?.provider==='BINANCE_SPOT_WEBSOCKET_CLOSED_KLINES' &&
        five?.provider==='BINANCE_SPOT_WEBSOCKET_CLOSED_KLINES'
        ? 'BINANCE_OFFICIAL_SPOT_WEBSOCKET_KLINES'
        : 'BINANCE_PUBLIC_CANDLES_AND_LIVE_SPOT_COLLECTOR',
      latest,
      candles: { '1m': one, '5m': five },
      integrity: {
        complete: ok,
        oneMinuteSamples: one?.rows?.length || 0,
        fiveMinuteSamples: five?.rows?.length || 0,
        errors,
      },
      constraints: 'Real OHLCV only. No production predictions, orders, credentials or synthetic candles.',
    };
  }

  return {
    async read() {
      if (cache && now() - cache.at < CACHE_MS) return cache.value;
      if (!inFlight) {
        inFlight = assemble().then(value => {
          cache = { at: now(), value };
          return value;
        }).finally(() => { inFlight = null; });
      }
      return await inFlight;
    },
  };
}
