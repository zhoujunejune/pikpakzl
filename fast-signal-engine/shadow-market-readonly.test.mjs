import test from 'node:test';
import assert from 'node:assert/strict';
import { createReadOnlyMarketFeed } from './shadow-market-readonly.mjs';

const at = Date.parse('2026-10-15T12:45:30.000Z');
function klines(interval) {
  const duration = interval === '1m' ? 60000 : 300000;
  const start = Math.floor(at / duration) * duration - 99 * duration;
  return Array.from({ length: 100 }, (_, i) => {
    const ms = start + duration * i;
    const price = 60000 + i;
    return [ms, String(price), String(price + 4), String(price - 4),
      String(price + 1), '1.5', ms + duration - 1, '0', '0', 0, '0', '0'];
  });
}
const live = () => ({
  signal: {
    direction: 'DOWN',
    score: -0.95,
    factsCalculatedAt: at - 150,
    roundStartMs: Math.floor(at / 300000) * 300000,
    facts: { lastPrice: 60200, roundOpenPrice: 60100 },
  },
  dataIntegrity: { wsConnected: true },
});

test('returns fresh 1m/5m public candles and sanitized live spot without direction', async () => {
  let calls = 0;
  const model = createReadOnlyMarketFeed({
    live, now: () => at,
    fetchImpl: async (url) => {
      calls++;
      return { ok: true, json: async () => klines(url.includes('interval=1m') ? '1m' : '5m') };
    },
  });
  const x = await model.read();
  assert.equal(x.ok, true);
  assert.equal(x.integrity.oneMinuteSamples, 100);
  assert.equal(x.integrity.fiveMinuteSamples, 100);
  assert.equal(x.latest.lastPrice, 60200);
  assert.equal(x.latest.ageMs, 150);
  assert.ok(x.candles['1m'].rows.at(-1).startMs <= at);
  assert.ok(!JSON.stringify(x).includes('"direction"'));
  assert.ok(!JSON.stringify(x).includes('"score"'));
  assert.equal((await model.read()).generatedAtMs, x.generatedAtMs);
  assert.equal(calls, 2);
});

test('fails closed when Binance denies public candles (HTTP 451)', async () => {
  const model = createReadOnlyMarketFeed({
    live, now: () => at,
    fetchImpl: async () => ({ ok: false, status: 451 }),
  });
  const x = await model.read();
  assert.equal(x.ok, false);
  assert.equal(x.candles['1m'], null);
  assert.equal(x.candles['5m'], null);
  assert.match(x.integrity.errors.join(' '), /HTTP_451/);
});

test('fails closed on stale upstream price instead of inventing data', async () => {
  const model = createReadOnlyMarketFeed({
    live: () => ({ ...live(), signal: { ...live().signal, factsCalculatedAt: at - 20000 } }),
    now: () => at,
    fetchImpl: async url => ({ ok: true, json: async () => klines(url.includes('interval=1m') ? '1m' : '5m') }),
  });
  assert.equal((await model.read()).ok, false);
});


test('Render preview uses authentic contiguous CLOSED WebSocket candles and never calls banned REST', async () => {
  let calls=0;
  const rowsFor=(interval)=>{
    const step=interval==='1m'?60000:300000;
    const end=Math.floor(at/step)*step-step;
    return Array.from({length:35},(_,i)=>{
      const startMs=end-(34-i)*step;
      return {startMs,endMs:startMs+step-1,open:61000,high:61100,
        low:60900,close:61020,volume:2,closed:true};
    });
  };
  const feed=createReadOnlyMarketFeed({
    now:()=>at,live,wsCandles:rowsFor,allowRest:()=>false,
    fetchImpl:async()=>{calls++;throw Error('REST_MUST_NOT_BE_CALLED');}
  });
  const data=await feed.read();
  assert.equal(data.ok,true);
  assert.equal(data.candles['1m'].provider,'BINANCE_SPOT_WEBSOCKET_CLOSED_KLINES');
  assert.equal(data.candles['5m'].provider,'BINANCE_SPOT_WEBSOCKET_CLOSED_KLINES');
  assert.equal(calls,0);
  assert.equal(data.source,'BINANCE_OFFICIAL_SPOT_WEBSOCKET_KLINES');
});

test('Render preview fails closed on too few WebSocket samples, without REST fallback',async()=>{
  let calls=0;
  const feed=createReadOnlyMarketFeed({
    now:()=>at,live,wsCandles:()=>[],allowRest:()=>false,
    fetchImpl:async()=>{calls++;throw Error('NEVER');}
  });
  const result=await feed.read();
  assert.equal(result.ok,false);
  assert.equal(calls,0);
  assert.match(result.integrity.errors.join(' '),/WS_WARMING_UP_0_OF_35/);
});
