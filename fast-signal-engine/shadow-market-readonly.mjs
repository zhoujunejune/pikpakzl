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
} = {}) {
  let cache = null;
  let inFlight = null;

  async function getCandles(interval) {
    const errors = [];
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
      source: 'EXISTING_RAILWAY_BINANCE_SPOT_COLLECTOR',
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
      source: 'BINANCE_PUBLIC_CANDLES_AND_EXISTING_RAILWAY_SPOT_COLLECTOR',
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
    // Dedicated low-latency, strictly read-only spot snapshot for the
    // current five-minute prediction. No 1m/5m HTTP Klines or 1800ms cache.
    // Consumers must independently validate roundStartMs, eventMs, and price.
    readSpot() {
      try{
        const latest=spot();
        const valid=Number.isSafeInteger(latest.roundStartMs)&&
          latest.roundStartMs>0&&Number.isFinite(latest.roundOpenPrice)&&
          latest.roundOpenPrice>0&&latest.lastPrice>0;
        if(!valid)throw Error('CURRENT_ROUND_BTC_OPEN_UNAVAILABLE');
        return {
          ok:true,schemaVersion:1,readOnly:true,symbol:SYMBOL,
          source:'EXISTING_LIVE_BINANCE_SPOT_SNAPSHOT_NO_KLINES',
          generatedAtMs:now(),latest
        };
      }catch(e){
        return {ok:false,readOnly:true,symbol:SYMBOL,latest:null,
          error:errorMessage(e),generatedAtMs:now()};
      }
    },
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
