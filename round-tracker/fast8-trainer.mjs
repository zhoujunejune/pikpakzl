import { parentPort, workerData } from 'node:worker_threads';
import { trainFast8 } from './fast8-model.mjs';
try { parentPort.postMessage({ ok: true, result: trainFast8(workerData.samples) }); }
catch { parentPort.postMessage({ ok: false }); }
