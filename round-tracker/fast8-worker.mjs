import { parentPort, workerData, Worker } from 'node:worker_threads';
import { createFast8Engine } from './fast8-engine.mjs';

const send = message => parentPort.postMessage(message);
const engine = createFast8Engine({ dir: workerData.dir,
  emit: (event, data) => send({ type: 'log', event, data }),
  publish: decision => send({ type: 'decision', decision }) });
let trainer = null;
function report() { send({ type: 'status', stats: engine.stats() }); }
function train() {
  if (trainer) return;
  const samples = engine.beginTraining();
  if (!samples) return;
  let finished = false;
  const finish = (result, error) => {
    if (finished) return;
    finished = true;
    clearTimeout(timeout);
    const previous = trainer;
    trainer = null;
    engine.finishTraining(result, error);
    void previous?.terminate();
    report();
  };
  trainer = new Worker(new URL('./fast8-trainer.mjs', import.meta.url), { workerData: { samples } });
  const timeout = setTimeout(() => finish(null, 'TRAINER_TIMEOUT'), 30000);
  trainer.once('message', m => finish(m.ok ? m.result : null, m.ok ? null : 'TRAINER_FAILED'));
  trainer.once('error', () => finish(null, 'TRAINER_FAILED'));
  trainer.once('exit', () => { if (!finished) finish(null, 'TRAINER_EXITED'); });
}
engine.load();
report();
send({ type: 'ready' });
engine.replayLatest();
// Deadline scheduling runs independently of production work and training.
setInterval(() => { try { engine.tick(); } catch { send({ type: 'log', event: 'fast8_error', data: { reason: 'TICK_FAILED' } }); } }, 25);
setInterval(report, 30000);
parentPort.on('message', m => {
  try {
    if (m.type === 'observe') engine.capture(m.live, m.receivedAt);
    if (m.type === 'published') { engine.acknowledge(m.roundStartMs, m.at); report(); }
    if (m.type === 'settle' && engine.settle(m.row)) { train(); report(); }
  } catch { send({ type: 'log', event: 'fast8_error', data: { reason: 'MESSAGE_FAILED' } }); }
});
train();
