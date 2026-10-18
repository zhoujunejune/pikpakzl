// Render bootstrap for the existing Railway z3 collector.
// Do not commit the source bundles, signatures or trading credentials.
// The original encoded collector must be copied directly between secret stores.
import { createHash } from 'node:crypto';

function decodeChecked(prefix, required = false) {
  const encoded = process.env[prefix + '_CODE_BASE64'];
  const expected = process.env[prefix + '_CODE_SHA256'];
  if (!encoded && !required) return null;
  if (!encoded || !expected) throw new Error(prefix + ': missing bundle or checksum');
  const bytes = Buffer.from(encoded, 'base64');
  const hash = createHash('sha256').update(bytes).digest('hex');
  if (hash.toLowerCase() !== expected.toLowerCase()) {
    throw new Error(prefix + ': SHA256 checksum mismatch');
  }
  return bytes.toString('base64');
}

async function load(encoded) {
  return import('data:text/javascript;base64,' + encoded);
}

const source = await load(decodeChecked('Z3_COLLECTOR', true));
if (typeof source.main !== 'function') throw new Error('Collector main export missing');

for (const name of ['BINANCE_QUOTE_TEST3', 'BINANCE_QUOTE_TEST2', 'BINANCE_QUOTE_TEST', 'BINANCE_READONLY']) {
  if (!process.env[name + '_CODE_BASE64']) continue;
  try {
    const mod = await load(decodeChecked(name));
    if (typeof mod.startReadOnlyPreflight === 'function') {
      await mod.startReadOnlyPreflight();
    }
  } catch (error) {
    console.warn(JSON.stringify({event: 'render_readonly_probe_error', module: name,
      error: String(error?.message || error).slice(0, 160)}));
  }
  break;
}

if (process.env.EVENT10_RELAY_CODE_BASE64) {
  try {
    const relay = await load(decodeChecked('EVENT10_RELAY'));
    if (typeof relay.startEvent10Relay !== 'function') {
      throw new Error('Relay start function missing');
    }
    await relay.startEvent10Relay();
  } catch (error) {
    console.error(JSON.stringify({event: 'render_event_relay_error',
      error: String(error?.message || error).slice(0, 160)}));
  }
}

await source.main();
