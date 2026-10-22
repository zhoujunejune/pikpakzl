import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';

const originalBlobSha = '6a3f4fa32ad6211732270b3b5102e7f6461c34a7';
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

const default300 = "const POLL_MS = Math.max(300, Number(process.env.AUTO_RISK_POLL_MS || process.env.AUTO_TAKE_PROFIT_POLL_MS || 300));";
const default500 = "const POLL_MS = Math.max(300, Number(process.env.AUTO_RISK_POLL_MS || process.env.AUTO_TAKE_PROFIT_POLL_MS || 500));";
test('default risk worker interval is 300ms and still honors the hard 300ms lower bound',()=>{
  assert.equal(source.split(default300).length-1,1);
  assert.equal(source.split(default500).length-1,0);
  assert.match(source,/const RETRY_MS = Math.max\(1000,/);
});

test('risk-worker has exactly one asynchronous payment prefetch and awaits at SELL', () => {
  assert.equal(source.split(newPrepare).length - 1, 1);
  assert.equal(source.split(newSell).length - 1, 1);
  assert.match(source, /const positionsResult = await queryOngoingPositions\(wallet\.walletAddress\);/);
  assert.match(source, /const quoteResult = await getSellQuote\(wallet, position, topic\);/);
});

test('risk formulas, thresholds, quote rules, SELL and retry code are byte-for-byte unchanged', () => {
  const baseline = source.replace(newPrepare, oldPrepare).replace(newSell, oldSell).replace(default300, default500);
  const gitObject = crypto.createHash('sha1')
    .update('blob ' + Buffer.byteLength(baseline) + String.fromCharCode(0))
    .update(baseline).digest('hex');
  assert.equal(gitObject, originalBlobSha);
});
