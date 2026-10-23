import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('./risk-worker.mjs', import.meta.url), 'utf8');

const newPrepare = `    // Warm the existing payment lookup while unchanged position/quote checks run.
    // No extra API request, cached route and SELL parameters remain identical.
    const paymentReady = getPaymentRoute();
    const activeTokens = new Set();`;
const newSell = `      // Payment routing is needed only at the original SELL submission point.
      const payment = await paymentReady;
      await sellPosition(wallet, payment, position, topic, targets, quoteResult, evaluation);
    }

    // Preserve the original one-payment-lookup-per-tick error/refresh behavior.
    await paymentReady;
    cleanupSellState(activeTokens);`;

const default300 = "const POLL_MS = Math.max(300, Number(process.env.AUTO_RISK_POLL_MS || process.env.AUTO_TAKE_PROFIT_POLL_MS || 300));";
test('default risk worker interval is 300ms and still honors the hard 300ms lower bound',()=>{
  assert.equal(source.split(default300).length-1,1);
  assert.equal(source.includes('AUTO_TAKE_PROFIT_POLL_MS || 500));'),false);
  assert.match(source,/const RETRY_MS = Math.max\(1000,/);
});

test('risk-worker has exactly one asynchronous payment prefetch and awaits at SELL', () => {
  assert.equal(source.split(newPrepare).length - 1, 1);
  assert.equal(source.split(newSell).length - 1, 1);
  assert.match(source, /const positionsResult = await queryOngoingPositions\(wallet\.walletAddress\);/);
  assert.match(source, /const quoteResult = await getSellQuote\(wallet, position, topic\);/);
});

test('risk formulas, market SELL call, and unknown status guard remain unchanged', () => {
  for (const marker of [
    'out.slTarget = base.totalCost * (1 - STOP_LOSS_PERCENT / 100);',
    'base.totalCost + maxProfit * (TAKE_PROFIT_PERCENT / 100)',
    'currentSellAmount >= targets.tpTarget',
    'currentSellAmount <= targets.slTarget',
    "side: 'SELL'",
    "orderType: 'MARKET'",
    "timeInForce: 'FOK'",
    "const QUOTE_MIN_REMAINING_MS = 250;",
    "const statusUnknown = Boolean(call?.network) || Number(call?.status || 0) >= 500;",
    'return Boolean(state?.inFlight || state?.submitted || state?.statusUnknown);',
  ]) assert.ok(source.includes(marker), marker);
  assert.match(source, /const RETRY_MS = Math.max\(1000, Number\(/);
  assert.match(source, /const UNKNOWN_RECONCILE_MS = 10000/);
  assert.match(source, /async function reconcileUnknownSell\(/);
});
