import fs from 'node:fs';

const clamp = (v, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, Number(v)));

export function createAdaptiveGateShadow({
  file,
  version = 'ADAPTIVE_GATE_SHADOW_V1',
  minTrainSamples = 180,
  forwardTarget = 60,
  currentMin = 0.60,
  supportMin = 0.05,
  maxDelayMs = 22000,
  edgeCurrentMin = 0.52,
  edgeSupportMin = 0.02,
  edgeMaxDelayMs = 26000,
  targetAccuracy = 0.72,
  log = () => {},
} = {}) {
  let state = { schemaVersion: 1, model: null };

  function save() {
    if (!file) return;
    try {
      const temp = file + '.tmp-' + process.pid;
      fs.writeFileSync(temp, JSON.stringify(state), 'utf8');
      fs.renameSync(temp, file);
    } catch (e) {
      log('adaptive_gate_shadow_save_failed', { error: e?.message || String(e) });
    }
  }

  function load() {
    if (!file) return false;
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!parsed || typeof parsed !== 'object') return false;
      state = parsed;
      log('adaptive_gate_shadow_loaded', {
        modelVersion: state.model?.modelVersion ?? null,
        trainEndRound: state.model?.trainEndRound ?? null,
        threshold: state.model?.threshold ?? null,
      });
      return Boolean(state.model?.weights);
    } catch (e) {
      if (e?.code !== 'ENOENT') {
        log('adaptive_gate_shadow_load_failed', { error: e?.message || String(e) });
      }
      return false;
    }
  }

  function supportFor(row) {
    const dir = String(row?.prediction || '').toUpperCase();
    const upMid = Number(row?.predictionFacts?.predictionMarketUpMid);
    if (!Number.isFinite(upMid)) return null;
    if (dir === 'UP') return upMid - 0.5;
    if (dir === 'DOWN') return 0.5 - upMid;
    return null;
  }

  function quality(row) {
    const dir = String(row?.prediction || '').toUpperCase();
    if (dir !== 'UP' && dir !== 'DOWN') {
      return { eligible: false, baselinePass: false, edgeCandidate: false, hardReject: true, reasons: ['NO_BASE_DIRECTION'] };
    }
    const facts = row?.predictionFacts || {};
    const currentAbs = Math.abs(Number(facts.currentScore));
    const support = supportFor(row);
    const delayMs = Number(row?.predictionDelayMs);
    const absorption = facts.absorptionRisk === true;

    if (!Number.isFinite(currentAbs) || !Number.isFinite(support) || !Number.isFinite(delayMs)) {
      return {
        eligible: false,
        baselinePass: false,
        edgeCandidate: false,
        hardReject: true,
        reasons: ['MISSING_GATE_FEATURE'],
        currentAbs: Number.isFinite(currentAbs) ? currentAbs : null,
        support: Number.isFinite(support) ? support : null,
        delayMs: Number.isFinite(delayMs) ? delayMs : null,
        absorption,
      };
    }

    const violations = [];
    if (currentAbs < currentMin) violations.push('CURRENT_SCORE');
    if (support < supportMin) violations.push('PREDICTION_SUPPORT');
    if (delayMs >= maxDelayMs) violations.push('LOCK_DELAY');

    const baselinePass = !absorption && violations.length === 0;
    const hardReject =
      absorption ||
      currentAbs < edgeCurrentMin ||
      support < edgeSupportMin ||
      delayMs >= edgeMaxDelayMs ||
      violations.length !== 1;

    return {
      eligible: true,
      baselinePass,
      edgeCandidate: !baselinePass && !hardReject,
      hardReject,
      reasons: absorption ? ['ABSORPTION_RISK'] : violations,
      currentAbs,
      support,
      delayMs,
      absorption,
    };
  }

  function alignmentValue(v) {
    const x = String(v || '').toUpperCase();
    if (x === 'ALIGNED') return 1;
    if (x === 'COUNTERTREND') return -1;
    return 0;
  }

  function regimeValue(row) {
    const dir = String(row?.prediction || '').toUpperCase();
    const r = String(row?.predictionFacts?.regimeDirection || '').toUpperCase();
    if (r !== 'UP' && r !== 'DOWN') return 0;
    return r === dir ? 1 : -1;
  }

  function vector(row) {
    const q = quality(row);
    if (!q.eligible) return null;
    const f = row.predictionFacts || {};
    const scoreAbs = Math.abs(Number(row.predictionScore));
    const confidence = Number(row.predictionConfidence);
    const micro = Math.abs(Number(f.microScore));
    const trend = Math.abs(Number(f.currentTrendScore));
    const regimeAgreement = Number(f.regimeAgreement);
    const distance = Math.abs(Number(f.distanceFromOpenBps));
    return [
      clamp(q.currentAbs, 0, 1),
      clamp((q.support + 0.05) / 0.30, 0, 1),
      clamp(1 - q.delayMs / 30000, 0, 1),
      Number.isFinite(scoreAbs) ? clamp(scoreAbs, 0, 1) : 0.5,
      Number.isFinite(confidence) ? clamp(confidence, 0, 1) : 0.5,
      Number.isFinite(micro) ? clamp(micro, 0, 1) : 0,
      Number.isFinite(trend) ? clamp(trend, 0, 1) : 0,
      Number.isFinite(regimeAgreement) ? clamp(regimeAgreement, 0, 1) : 0,
      clamp(distance / 20, 0, 1),
      (alignmentValue(f.alignment) + 1) / 2,
      (regimeValue(row) + 1) / 2,
      String(f.volatilityRegime || '').toUpperCase() === 'HIGH_VOL' ? 1 : 0,
    ];
  }

  function sigmoid(z) {
    if (z >= 0) {
      const e = Math.exp(-z);
      return 1 / (1 + e);
    }
    const e = Math.exp(z);
    return e / (1 + e);
  }

  function fit(samples) {
    if (!samples.length) return null;
    const d = samples[0].x.length;
    let w = new Array(d + 1).fill(0);
    const lr = 0.055;
    const l2 = 0.035;
    const epochs = 360;
    for (let epoch = 0; epoch < epochs; epoch += 1) {
      const g = new Array(d + 1).fill(0);
      for (let i = 0; i < samples.length; i += 1) {
        const s = samples[i];
        let z = w[0];
        for (let j = 0; j < d; j += 1) z += w[j + 1] * s.x[j];
        const p = sigmoid(z);
        const recency = 0.55 + 0.45 * ((i + 1) / samples.length);
        const err = (p - s.y) * recency;
        g[0] += err;
        for (let j = 0; j < d; j += 1) g[j + 1] += err * s.x[j];
      }
      w[0] -= lr * g[0] / samples.length;
      for (let j = 1; j < w.length; j += 1) {
        w[j] -= lr * (g[j] / samples.length + l2 * w[j]);
      }
    }
    return w;
  }

  function predictWeights(weights, x) {
    if (!Array.isArray(weights) || !Array.isArray(x)) return null;
    let z = Number(weights[0] || 0);
    for (let j = 0; j < x.length; j += 1) z += Number(weights[j + 1] || 0) * x[j];
    return sigmoid(z);
  }

  function metric(rows, weights, threshold, onlyEdge = false) {
    const candidates = rows.filter(s => !onlyEdge || s.q.edgeCandidate);
    const passed = candidates.filter(s => predictWeights(weights, s.x) >= threshold);
    const hits = passed.filter(s => s.y === 1).length;
    return {
      candidates: candidates.length,
      passed: passed.length,
      hits,
      misses: passed.length - hits,
      accuracy: passed.length ? hits / passed.length : null,
      coverage: candidates.length ? passed.length / candidates.length : null,
    };
  }

  function ensureModel(rows) {
    if (state.model?.weights) return state.model;
    const labeled = (Array.isArray(rows) ? rows : [])
      .filter(r => (r?.actual === 'UP' || r?.actual === 'DOWN') && (r?.prediction === 'UP' || r?.prediction === 'DOWN'))
      .sort((a, b) => Number(a.roundStartMs) - Number(b.roundStartMs))
      .map(r => {
        const x = vector(r);
        const q = quality(r);
        if (!x || !q.eligible) return null;
        return {
          round: Number(r.roundStartMs),
          x,
          q,
          y: r.prediction === r.actual ? 1 : 0,
        };
      })
      .filter(Boolean);

    if (labeled.length < minTrainSamples) {
      log('adaptive_gate_shadow_collecting_training_data', {
        samples: labeled.length,
        minTrainSamples,
      });
      return null;
    }

    const holdoutN = Math.max(50, Math.min(100, Math.floor(labeled.length * 0.20)));
    const split = Math.max(120, labeled.length - holdoutN);
    const train = labeled.slice(0, split);
    const holdout = labeled.slice(split);
    const weights = fit(train);
    if (!weights) return null;

    let best = null;
    for (let t = 0.58; t <= 0.90 + 1e-9; t += 0.01) {
      const m = metric(holdout, weights, Number(t.toFixed(2)), true);
      if (m.passed < 6 || !Number.isFinite(m.accuracy) || m.accuracy < targetAccuracy) continue;
      if (!best || m.passed > best.metric.passed || (m.passed === best.metric.passed && t < best.threshold)) {
        best = { threshold: Number(t.toFixed(2)), metric: m };
      }
    }

    const threshold = best?.threshold ?? 0.78;
    const allMetric = metric(holdout, weights, threshold, false);
    const edgeMetric = metric(holdout, weights, threshold, true);
    const baselineRows = holdout.filter(s => s.q.baselinePass);
    const baselineHits = baselineRows.filter(s => s.y === 1).length;

    const trainedAt = Date.now();
    state.model = {
      version,
      modelVersion: version + '-' + trainedAt,
      trainedAt,
      trainEndRound: labeled[labeled.length - 1]?.round ?? null,
      trainingSamples: train.length,
      holdoutSamples: holdout.length,
      weights,
      threshold,
      thresholdSelection: best ? 'HOLDOUT_TARGET_ACCURACY' : 'SHADOW_DEFAULT_NO_SAFE_EDGE_THRESHOLD',
      targetAccuracy,
      holdoutAccuracy: allMetric.accuracy,
      holdoutPassed: allMetric.passed,
      holdoutCoverage: allMetric.coverage,
      edgeHoldoutCandidates: edgeMetric.candidates,
      edgeHoldoutPassed: edgeMetric.passed,
      edgeHoldoutAccuracy: edgeMetric.accuracy,
      baselineHoldoutSamples: baselineRows.length,
      baselineHoldoutAccuracy: baselineRows.length ? baselineHits / baselineRows.length : null,
      gate: {
        currentMin,
        supportMin,
        maxDelayMs,
        edgeCurrentMin,
        edgeSupportMin,
        edgeMaxDelayMs,
        maxSoftViolations: 1,
        hardRejectAbsorption: true,
      },
    };
    save();
    log('adaptive_gate_shadow_trained', {
      modelVersion: state.model.modelVersion,
      trainEndRound: state.model.trainEndRound,
      trainingSamples: state.model.trainingSamples,
      holdoutSamples: state.model.holdoutSamples,
      threshold: state.model.threshold,
      thresholdSelection: state.model.thresholdSelection,
      edgeHoldoutCandidates: state.model.edgeHoldoutCandidates,
      edgeHoldoutPassed: state.model.edgeHoldoutPassed,
      edgeHoldoutAccuracy: state.model.edgeHoldoutAccuracy,
      baselineHoldoutAccuracy: state.model.baselineHoldoutAccuracy,
      productionEffect: 'NONE_SHADOW_ONLY',
    });
    return state.model;
  }

  function evaluate(row) {
    const m = state.model;
    if (!m?.weights) return null;
    const dir = String(row?.prediction || '').toUpperCase();
    if (dir !== 'UP' && dir !== 'DOWN') return null;
    const q = quality(row);
    const x = vector(row);
    const p = x ? predictWeights(m.weights, x) : null;
    let decision = 'WAIT';
    let mode = 'HARD_WAIT';
    if (q.baselinePass) {
      decision = dir;
      mode = 'BASELINE_PASS';
    } else if (q.edgeCandidate && Number.isFinite(p) && p >= m.threshold) {
      decision = dir;
      mode = 'EDGE_PASS';
    } else if (q.edgeCandidate) {
      mode = 'EDGE_WAIT';
    }
    const out = {
      version,
      modelVersion: m.modelVersion,
      evaluatedAt: Date.now(),
      productionEffect: 'NONE_SHADOW_ONLY',
      baseDirection: dir,
      decision,
      mode,
      baselinePass: q.baselinePass,
      edgeCandidate: q.edgeCandidate,
      hardReject: q.hardReject,
      gateReasons: q.reasons,
      hitProbability: Number.isFinite(p) ? Number(p.toFixed(4)) : null,
      threshold: m.threshold,
      currentAbs: Number.isFinite(q.currentAbs) ? Number(q.currentAbs.toFixed(4)) : null,
      predictionSupport: Number.isFinite(q.support) ? Number(q.support.toFixed(4)) : null,
      delayMs: Number.isFinite(q.delayMs) ? q.delayMs : null,
    };
    if (out.edgeCandidate) {
      log('adaptive_gate_shadow_edge_evaluated', {
        round: row.roundStartMs,
        modelVersion: m.modelVersion,
        baseDirection: dir,
        decision,
        mode,
        hitProbability: out.hitProbability,
        threshold: out.threshold,
        gateReasons: out.gateReasons,
        currentAbs: out.currentAbs,
        predictionSupport: out.predictionSupport,
        delayMs: out.delayMs,
      });
    }
    return out;
  }

  function stats(rows) {
    const m = state.model;
    if (!m?.weights) {
      return {
        ok: true,
        version,
        status: 'NO_MODEL',
        productionEffect: 'NONE_SHADOW_ONLY',
        model: null,
      };
    }
    const settledAll = (Array.isArray(rows) ? rows : [])
      .filter(r => Number(r?.roundStartMs) > Number(m.trainEndRound || 0) && (r?.actual === 'UP' || r?.actual === 'DOWN'))
      .sort((a, b) => Number(a.roundStartMs) - Number(b.roundStartMs));
    const evaluated = settledAll.filter(r => r?.adaptiveGateShadow?.modelVersion === m.modelVersion);
    const decided = evaluated.filter(r => r.adaptiveGateShadow?.decision === 'UP' || r.adaptiveGateShadow?.decision === 'DOWN');
    const baseline = evaluated.filter(r => r.adaptiveGateShadow?.mode === 'BASELINE_PASS');
    const edge = evaluated.filter(r => r.adaptiveGateShadow?.mode === 'EDGE_PASS');
    const edgeWait = evaluated.filter(r => r.adaptiveGateShadow?.mode === 'EDGE_WAIT');

    const summarize = arr => {
      const hits = arr.filter(r => r.adaptiveGateShadow?.decision === r.actual).length;
      return {
        samples: arr.length,
        hits,
        misses: arr.length - hits,
        accuracy: arr.length ? Number((hits / arr.length).toFixed(4)) : null,
      };
    };

    const d = summarize(decided);
    const b = summarize(baseline);
    const e = summarize(edge);
    const totalRounds = settledAll.length;
    return {
      ok: true,
      version,
      status: d.samples >= forwardTarget ? 'FORWARD_COMPLETE' : 'FORWARD_COLLECTING',
      productionEffect: 'NONE_SHADOW_ONLY',
      model: {
        modelVersion: m.modelVersion,
        trainedAt: m.trainedAt,
        trainEndRound: m.trainEndRound,
        trainingSamples: m.trainingSamples,
        holdoutSamples: m.holdoutSamples,
        threshold: m.threshold,
        thresholdSelection: m.thresholdSelection,
        targetAccuracy: m.targetAccuracy,
        edgeHoldoutCandidates: m.edgeHoldoutCandidates,
        edgeHoldoutPassed: m.edgeHoldoutPassed,
        edgeHoldoutAccuracy: m.edgeHoldoutAccuracy,
        baselineHoldoutAccuracy: m.baselineHoldoutAccuracy,
        gate: m.gate,
      },
      forwardTarget,
      settledForwardRounds: totalRounds,
      evaluatedForwardRounds: evaluated.length,
      decided: d,
      baseline: b,
      edgeAdded: e,
      edgeWaitSamples: edgeWait.length,
      totalCoverage: totalRounds ? Number((d.samples / totalRounds).toFixed(4)) : null,
      baselineCoverage: totalRounds ? Number((b.samples / totalRounds).toFixed(4)) : null,
      incrementalCoverage: totalRounds ? Number((e.samples / totalRounds).toFixed(4)) : null,
      remainingDecisions: Math.max(0, forwardTarget - d.samples),
    };
  }

  function onSettled(row, rows) {
    if (!state.model?.weights) return;
    if (row?.adaptiveGateShadow?.modelVersion !== state.model.modelVersion) return;
    if (row?.actual !== 'UP' && row?.actual !== 'DOWN') return;
    const s = stats(rows);
    const edgeN = Number(s.edgeAdded?.samples || 0);
    const decidedN = Number(s.decided?.samples || 0);
    if ((edgeN > 0 && edgeN % 5 === 0) || (decidedN > 0 && decidedN % 10 === 0) || decidedN === forwardTarget) {
      log('adaptive_gate_shadow_forward_progress', {
        modelVersion: state.model.modelVersion,
        decidedSamples: decidedN,
        targetSamples: forwardTarget,
        forwardAccuracy: s.decided?.accuracy ?? null,
        totalCoverage: s.totalCoverage,
        baselineCoverage: s.baselineCoverage,
        edgeAddedSamples: edgeN,
        edgeAddedAccuracy: s.edgeAdded?.accuracy ?? null,
        incrementalCoverage: s.incrementalCoverage,
        remainingDecisions: s.remainingDecisions,
        productionEffect: 'NONE_SHADOW_ONLY',
      });
    }
  }

  return {
    load,
    ensureModel,
    evaluate,
    stats,
    onSettled,
    quality,
  };
}
