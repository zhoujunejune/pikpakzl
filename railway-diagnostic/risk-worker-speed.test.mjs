import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('./risk-worker.mjs', import.meta.url), 'utf8');

const newPrepare = `    // Warm the existing payment lookup while unchanged position/quote checks run.
    // No extra API request, cached route and SELL parameters remain identical.
    const paymentReady = getPaymentRoute();
    const activeTokens = new Set();`;
const oldPrepare = `    const payment = await getPaymentRoute();
    const activeTokens = new Set();`;
const newSell = `      // Payment routing is needed only at the original SELL submission point.
      const payment = await paymentReady;
      await sellPosition(wallet, payment, position, topic, targets, quoteResult, evaluation);
    }

    // Preserve the original one-payment-lookup-per-tick error/refresh behavior.
    await paymentReady;
    cleanupSellState(activeTokens);`;
const oldSell = `      await sellPosition(wallet, payment, position, topic, targets, quoteResult, evaluation);
    }

    cleanupSellState(activeTokens);`;

test('risk-worker has exactly one asynchronous payment prefetch and awaits at SELL', () => {
  assert.equal(source.split(newPrepare).length - 1, 1);
  assert.equal(source.split(newSell).length - 1, 1);
  assert.match(source, /const positionsResult = await queryOngoingPositions\(wallet\.walletAddress\);/);
  assert.match(source, /const quoteResult = await getSellQuote\(wallet, position, topic\);/);
});

test('fixed exit quotes, targets, selling and retry loop remain active without dynamic GUARDIAN exit', () => {
  assert.match(source,/const tpTriggered = TAKE_PROFIT_ENABLED/);
  assert.match(source,/const slTriggered = STOP_LOSS_ENABLED/);
  assert.match(source,/const currentSellAmount = weiToDecimal\(quote\?\.amountOut\)/);
  assert.match(source,/await sellPosition\(wallet, payment, position, topic, targets, quoteResult, evaluation\)/);
  assert.match(source,/async function sellPosition/);
  assert.match(source,/const RETRY_MS =/);
  assert.match(source,/function evaluatePositionRisk\(position,targets,quote\)/);
  assert.match(source,/return evaluateRisk\(targets,quote\)/);
  assert.doesNotMatch(source,/guardianRiskQuote\(/);
  assert.doesNotMatch(source,/guardianRiskHeartbeat\(/);
});
