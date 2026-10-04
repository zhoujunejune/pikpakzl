import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ENGINE_VERSION = 'FLAML_QLIB_ROLLING_RIVER_V3';
const PYTHON = process.env.SHADOW_V3_PYTHON || 'python3';
const SCRIPT = fileURLToPath(new URL('./shadow-v3.py', import.meta.url));

function atomicWrite(file, value) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(value), 'utf8');
  fs.renameSync(tmp, file);
}

function runPython(args, input = null, timeoutMs = 240000) {
  return new Promise((resolve, reject) => {
    const child = spawn(PYTHON, [SCRIPT, ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONUNBUFFERED: '1' },
    });
    let stdout = '';
    let stderr = '';
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      child.kill('SIGKILL');
      reject(new Error('SHADOW_V3_PYTHON_TIMEOUT'));
    }, timeoutMs);
    child.stdout.on('data', d => { stdout += d.toString(); });
    child.stderr.on('data', d => { stderr += d.toString(); });
    child.on('error', err => {
      if (done) return;
      done = true; clearTimeout(timer); reject(err);
    });
    child.on('close', code => {
      if (done) return;
      done = true; clearTimeout(timer);
      const line = stdout.split(/\r?\n/).reverse().find(x => x.startsWith('SHADOW_V3_RESULT='));
      if (code !== 0 || !line) {
        return reject(new Error(`SHADOW_V3_PYTHON_FAILED code=${code} stderr=${stderr.slice(-2000)} stdout=${stdout.slice(-1000)}`));
      }
      try {
        resolve(JSON.parse(line.slice('SHADOW_V3_RESULT='.length)));
      } catch (e) {
        reject(new Error(`SHADOW_V3_BAD_JSON: ${e.message}`));
      }
    });
    if (input != null) child.stdin.end(JSON.stringify(input));
    else child.stdin.end();
  });
}

export function createShadowV3Client({
  historyFile,
  dir,
  minSamples = 300,
  forwardTarget = 60,
  maxCandidates = 8,
  trainEveryRounds = 20,
  trainTimeBudget = 75,
  log = () => {},
} = {}) {
  const registryFile = `${dir}/registry.json`;
  let state = {
    schemaVersion: 1,
    engineVersion: ENGINE_VERSION,
    lastAttemptRound: 0,
    candidates: [],
  };
  let trainingBusy = false;
  const predictingRounds = new Set();

  function save() {
    try {
      fs.mkdirSync(dir, { recursive: true });
      atomicWrite(registryFile, state);
    } catch (e) {
      log('shadow_v3_save_failed', { error: e?.message || String(e) });
    }
  }

  function load() {
    try {
      fs.mkdirSync(dir, { recursive: true });
      const parsed = JSON.parse(fs.readFileSync(registryFile, 'utf8'));
      if (parsed?.schemaVersion === 1 && Array.isArray(parsed?.candidates)) {
        state = parsed;
        state.engineVersion = ENGINE_VERSION;
      }
      deleteRetiredCandidates();
      log('shadow_v3_registry_loaded', {
        candidates: state.candidates.length,
        lastAttemptRound: state.lastAttemptRound || 0,
        engineVersion: ENGINE_VERSION,
      });
      return true;
    } catch (e) {
      if (e?.code !== 'ENOENT') log('shadow_v3_load_failed', { error: e?.message || String(e) });
      return false;
    }
  }

  function summaryOf(c) {
    const settled = (c.observations || []).filter(o =>
      (o.actual === 'UP' || o.actual === 'DOWN') && Number.isFinite(Number(o.probability))
    );
    let hits = 0, brier = 0, streak = 0, maxStreak = 0;
    for (const o of settled) {
      const y = o.actual === 'UP' ? 1 : 0;
      const p = Number(o.probability);
      const pred = p >= Number(c.threshold ?? 0.5) ? 1 : 0;
      const ok = pred === y;
      hits += ok ? 1 : 0;
      brier += (p - y) ** 2;
      if (ok) streak = 0;
      else { streak += 1; maxStreak = Math.max(maxStreak, streak); }
    }
    const recent20 = settled.slice(-20);
    const recentHits = recent20.reduce((n, o) => {
      const y = o.actual === 'UP' ? 1 : 0;
      return n + ((Number(o.probability) >= Number(c.threshold ?? 0.5) ? 1 : 0) === y ? 1 : 0);
    }, 0);
    const n = settled.length;
    const acc = n ? hits / n : null;
    let status = n < forwardTarget ? 'COLLECTING' : 'FORWARD_COMPLETE';
    if (n >= forwardTarget && acc >= 0.70) status = 'FORWARD_70_MET';
    else if (n >= forwardTarget && acc < 0.60) status = 'RETIRED_LOW_ACCURACY';
    if (c.drift?.driftDetected && n < forwardTarget) status = 'DRIFT_WARNING';
    return {
      modelVersion: c.modelVersion,
      engineVersion: c.engineVersion,
      trainedAt: c.trainedAt,
      lastTrainRound: c.lastTrainRound,
      trainedSamples: c.trainedSamples,
      windowSize: c.windowSize,
      estimator: c.bestEstimator,
      threshold: c.threshold,
      outerHoldoutAccuracy: c.outerHoldout?.accuracy ?? null,
      outerHoldoutBaselineAccuracy: c.outerHoldout?.baselineAccuracy ?? null,
      forwardSamples: n,
      targetSamples: forwardTarget,
      remainingSamples: Math.max(0, forwardTarget - n),
      hits,
      misses: n - hits,
      forwardAccuracy: n ? Number(acc.toFixed(4)) : null,
      forwardBrier: n ? Number((brier / n).toFixed(4)) : null,
      recent20Accuracy: recent20.length ? Number((recentHits / recent20.length).toFixed(4)) : null,
      maxConsecutiveErrors: maxStreak,
      drift: c.drift || null,
      status,
    };
  }

  function deleteRetiredCandidates(){
    const removed=[];
    state.candidates=state.candidates.filter(c=>{
      const s=summaryOf(c);
      const retired=s.forwardSamples>=forwardTarget &&
        Number.isFinite(Number(s.forwardAccuracy)) &&
        Number(s.forwardAccuracy)<0.60;
      if(!retired) return true;
      if(c.modelPath){
        try{
          if(fs.existsSync(c.modelPath)) fs.unlinkSync(c.modelPath);
        }catch(e){
          log('shadow_v3_model_file_delete_failed',{modelVersion:c.modelVersion,modelPath:c.modelPath,error:e?.message||String(e)});
        }
      }
      removed.push({
        modelVersion:c.modelVersion,
        estimator:c.bestEstimator||null,
        forwardSamples:s.forwardSamples,
        forwardAccuracy:s.forwardAccuracy,
        modelPath:c.modelPath||null,
        reason:'STRICT_FORWARD_BELOW_60',
      });
      return false;
    });
    if(removed.length){
      save();
      log('shadow_v3_retired_models_deleted',{count:removed.length,models:removed});
    }
    return removed;
  }

  function prune() {
    while (state.candidates.length > maxCandidates) {
      let idx = state.candidates.findIndex(c => summaryOf(c).forwardSamples >= forwardTarget);
      if (idx < 0) idx = 0;
      const [removed] = state.candidates.splice(idx, 1);
      log('shadow_v3_candidate_pruned', { modelVersion: removed?.modelVersion || null });
    }
  }

  async function maybeTrain(latestRound = 0) {
    const round = Number(latestRound || 0);
    if (trainingBusy) return null;
    if (round <= 0 && Number(state.lastAttemptRound || 0) > 0) return null;
    if (
      round > 0 &&
      Number(state.lastAttemptRound || 0) > 0 &&
      round - Number(state.lastAttemptRound) < trainEveryRounds * 300000
    ) return null;
    if (!fs.existsSync(historyFile)) return null;

    trainingBusy = true;
    try {
      const result = await runPython([
        'train',
        '--history', historyFile,
        '--out-dir', dir,
        '--min-samples', String(minSamples),
        '--time-budget', String(trainTimeBudget),
      ], null, Math.max(300000, trainTimeBudget * 6000));

      if (Number.isFinite(Number(result?.lastTrainRound))) {
        state.lastAttemptRound = Number(result.lastTrainRound);
      }

      if (result?.status === 'CANDIDATE_REGISTERED' && result?.modelVersion && result?.modelPath) {
        if (!state.candidates.some(c => c.modelVersion === result.modelVersion)) {
          state.candidates.push({
            ...result,
            observations: [],
            drift: null,
            registeredAt: Date.now(),
          });
          prune();
          log('shadow_v3_candidate_registered', {
            modelVersion: result.modelVersion,
            estimator: result.bestEstimator,
            windowSize: result.windowSize,
            threshold: result.threshold,
            outerHoldoutAccuracy: result.outerHoldout?.accuracy ?? null,
            outerHoldoutBaselineAccuracy: result.outerHoldout?.baselineAccuracy ?? null,
            trainedSamples: result.trainedSamples,
            targetSamples: forwardTarget,
            productionEffect: 'NONE_SHADOW_ONLY',
          });
        }
      } else if (result?.status === 'REJECTED_BEFORE_FORWARD') {
        log('shadow_v3_candidate_rejected_before_forward', {
          engineVersion: result.engineVersion,
          lastTrainRound: result.lastTrainRound,
          estimator: result.bestEstimator,
          windowSize: result.windowSize,
          innerValidation: result.innerValidation,
          outerHoldout: result.outerHoldout,
          reasons: result.reasons || [],
        });
      } else {
        log('shadow_v3_training_result', result || {});
      }
      save();
      return result;
    } catch (e) {
      log('shadow_v3_training_failed', { error: e?.message || String(e) });
      return null;
    } finally {
      trainingBusy = false;
    }
  }

  async function observe(row, facts) {
    const round = Number(row?.roundStartMs);
    const observedAt = Number(row?.shadowObservedAt);
    if (!Number.isFinite(round) || !Number.isFinite(observedAt) || !facts) return;
    const delay = observedAt - round;
    if (delay < 8000 || delay > 20000) return;
    if (predictingRounds.has(round)) return;

    const active = state.candidates.filter(c => {
      const s = summaryOf(c);
      return c.engineVersion === ENGINE_VERSION &&
        s.forwardSamples < forwardTarget &&
        round > Number(c.lastTrainRound || 0) &&
        !(c.observations || []).some(o => Number(o.roundStartMs) === round);
    });
    if (!active.length) return;

    predictingRounds.add(round);
    try {
      const result = await runPython(['predict'], {
        facts,
        models: active.map(c => ({ modelVersion: c.modelVersion, modelPath: c.modelPath })),
      }, 60000);
      let changed = false;
      for (const pred of result?.predictions || []) {
        const c = state.candidates.find(x => x.modelVersion === pred.modelVersion);
        if (!c || !Number.isFinite(Number(pred.probability))) continue;
        if ((c.observations || []).some(o => Number(o.roundStartMs) === round)) continue;
        c.observations.push({
          roundStartMs: round,
          observedAt,
          observedDelayMs: delay,
          probability: Number(pred.probability),
          actual: null,
          settledAt: null,
        });
        changed = true;
      }
      if (changed) save();
    } catch (e) {
      log('shadow_v3_prediction_failed', { round, error: e?.message || String(e) });
    } finally {
      predictingRounds.delete(round);
    }
  }

  async function updateDrift(c) {
    const settled = (c.observations || []).filter(o => o.actual === 'UP' || o.actual === 'DOWN');
    if (settled.length < 20) return;
    const errors = settled.map(o => {
      const y = o.actual === 'UP' ? 1 : 0;
      const pred = Number(o.probability) >= Number(c.threshold ?? 0.5) ? 1 : 0;
      return pred === y ? 0 : 1;
    });
    try {
      const result = await runPython(['drift'], { errors }, 30000);
      const before = Boolean(c.drift?.driftDetected);
      c.drift = {
        driftDetected: Boolean(result?.driftDetected),
        detectedAt: result?.detectedAt ?? null,
        samples: result?.samples ?? settled.length,
        width: result?.width ?? null,
        estimation: result?.estimation ?? null,
        library: result?.library || 'river.ADWIN',
        evaluatedAt: Date.now(),
      };
      save();
      if (!before && c.drift.driftDetected) {
        log('shadow_v3_drift_detected', {
          modelVersion: c.modelVersion,
          forwardSamples: settled.length,
          estimation: c.drift.estimation,
          detectedAt: c.drift.detectedAt,
        });
      }
    } catch (e) {
      log('shadow_v3_drift_check_failed', { modelVersion: c.modelVersion, error: e?.message || String(e) });
    }
  }

  function settle(row) {
    if (row?.actual !== 'UP' && row?.actual !== 'DOWN') return;
    const round = Number(row.roundStartMs);
    let changed = false;
    const touched = [];
    for (const c of state.candidates) {
      const o = (c.observations || []).find(x => Number(x.roundStartMs) === round);
      if (!o) continue;
      const before = o.actual;
      if (before === row.actual) continue;
      o.actual = row.actual;
      o.settledAt = Number(row.settledAt) || Date.now();
      changed = true;
      touched.push(c);
      if (before === 'UP' || before === 'DOWN') {
        log('shadow_v3_official_label_corrected', {
          modelVersion: c.modelVersion, round, from: before, to: row.actual,
        });
      }
      const s = summaryOf(c);
      if (s.forwardSamples === forwardTarget || s.forwardSamples % 10 === 0) {
        log('shadow_v3_forward_progress', s);
      }
    }
    if (changed) {
      save();
      for (const c of touched) void updateDrift(c);
      deleteRetiredCandidates();
    }
  }

  function invalidateRounds(roundIds) {
    const ids = new Set(Array.from(roundIds || []).map(x => String(Number(x))));
    let reset = 0;
    for (const c of state.candidates) {
      for (const o of c.observations || []) {
        if (!ids.has(String(Number(o.roundStartMs)))) continue;
        if (o.actual === 'UP' || o.actual === 'DOWN') {
          o.actual = null;
          o.settledAt = null;
          reset += 1;
        }
      }
    }
    if (reset) {
      save();
      log('shadow_v3_labels_invalidated', { rounds: ids.size, observationsReset: reset });
    }
    return reset;
  }

  function stats() {
    const candidates = state.candidates
      .map(summaryOf)
      .sort((a, b) => Number(b.trainedAt || 0) - Number(a.trainedAt || 0));
    const completed = candidates
      .filter(x => x.forwardSamples >= forwardTarget)
      .sort((a, b) => Number(b.forwardAccuracy ?? -1) - Number(a.forwardAccuracy ?? -1));
    return {
      ok: true,
      engineVersion: ENGINE_VERSION,
      trainerStack: ['FLAML', 'LightGBM', 'XGBoost', 'CatBoost', 'ExtraTrees', 'QLIB_STYLE_ROLLING_PURGE', 'River_ADWIN'],
      productionEffect: 'NONE_SHADOW_ONLY',
      trainingBusy,
      lastAttemptRound: state.lastAttemptRound || 0,
      candidates,
      bestCompleted: completed[0] || null,
    };
  }

  return { load, save, maybeTrain, observe, settle, invalidateRounds, deleteRetiredCandidates, stats };
}
