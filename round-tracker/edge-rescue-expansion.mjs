import { isOfficialStrictSettlement, isFrozenFinalBaselineWait, productionBaselineSummary, prospectiveCombinedSummary, wilsonLowerBound } from './edge-rescue-expansion-proof.mjs';
export function createEdgeRescueExpansion(options = {}) {
  const {
    version = 'SELECTIVE_V2_EDGE_EXPANSION_SHADOW_V1',
    startMs = 0,
    configs = [],
    lockPredictionSupport = () => null,
    minSamples = 60,
    targetSamples = 60,
    targetAccuracy = 0.75,
    recentWindow = 20,
    recentAccuracy = 0.75,
    directionMinSamples = 10,
    directionRecentWindow = 6,
    directionAccuracy = 0.70,
    maxMissStreak = 2,
    minIncrementalCoverage = 0.02,
    retireMinSamples = 20,
    retireAccuracy = 0.65,
    log = () => {},
    onPersist = () => {},
  } = options;

  // Missing values must not be coerced into numeric zero.
  const finite = x => x !== null && x !== undefined && x !== '' && Number.isFinite(Number(x));

  function normalizedRows(rowsInput) {
    if (!rowsInput) return [];
    if (Array.isArray(rowsInput)) return rowsInput;
    try {
      return Array.from(rowsInput);
    } catch {
      return [];
    }
  }

  function candidateDecision(direction, facts, delayMs, predictionScore, config) {
    const cfg = config || {};
    const reasons = [];
    const dir = direction === 'UP' || direction === 'DOWN' ? direction : null;
    const support = dir ? lockPredictionSupport(dir, facts) : null;
    const currentAbs = finite(facts?.currentScore) ? Math.abs(Number(facts.currentScore)) : NaN;
    const scoreAbs = finite(predictionScore) ? Math.abs(Number(predictionScore)) : NaN;
    const delay = finite(delayMs) ? Number(delayMs) : NaN;
    const absorption = facts?.absorptionRisk === true;

    if (!dir) reasons.push('NO_BASE_DIRECTION');
    if (!finite(support)) reasons.push('MISSING_PREDICTION_SUPPORT');
    if (!finite(currentAbs)) reasons.push('MISSING_CURRENT_SCORE');
    if (!finite(scoreAbs)) reasons.push('MISSING_BASE_SCORE');
    if (!finite(delay)) reasons.push('MISSING_LOCK_DELAY');
    if (cfg.rejectAbsorption !== false && absorption) reasons.push('ABSORPTION_RISK');

    if (finite(support) && finite(cfg.supportMin) && Number(support) < Number(cfg.supportMin)) {
      reasons.push('SUPPORT_BELOW_EXPANSION_MIN');
    }
    if (finite(currentAbs) && finite(cfg.currentMin) && currentAbs < Number(cfg.currentMin)) {
      reasons.push('CURRENT_BELOW_EXPANSION_MIN');
    }
    if (finite(scoreAbs) && finite(cfg.scoreMin) && scoreAbs < Number(cfg.scoreMin)) {
      reasons.push('SCORE_BELOW_EXPANSION_MIN');
    }
    if (finite(delay) && finite(cfg.maxDelayMs) && delay > Number(cfg.maxDelayMs)) {
      reasons.push('DELAY_ABOVE_EXPANSION_MAX');
    }

    const pass = reasons.length === 0;
    return {
      candidateId: cfg.id || null,
      decision: pass ? dir : 'WAIT',
      pass,
      reasons,
      facts: {
        predictionSupport: finite(support) ? Number(Number(support).toFixed(4)) : null,
        currentScoreAbs: finite(currentAbs) ? Number(currentAbs.toFixed(4)) : null,
        baseScoreAbs: finite(scoreAbs) ? Number(scoreAbs.toFixed(4)) : null,
        lockDelayMs: finite(delay) ? delay : null,
        absorptionRisk: absorption,
      },
      thresholds: {
        supportMin: finite(cfg.supportMin) ? Number(cfg.supportMin) : null,
        currentMin: finite(cfg.currentMin) ? Number(cfg.currentMin) : null,
        scoreMin: finite(cfg.scoreMin) ? Number(cfg.scoreMin) : null,
        maxDelayMs: finite(cfg.maxDelayMs) ? Number(cfg.maxDelayMs) : null,
        rejectAbsorption: cfg.rejectAbsorption !== false,
      },
    };
  }

  function evaluate(row, selectiveQuality, coreRescue) {
    if (!row || Number(row.roundStartMs) < Number(startMs)) return null;
    if (row.selectiveV2EdgeExpansionShadow?.version === version) {
      return row.selectiveV2EdgeExpansionShadow;
    }

    const direction = row.prediction === 'UP' || row.prediction === 'DOWN'
      ? row.prediction
      : null;
    if (!direction || selectiveQuality?.pass) return null;

    // Expansion is strictly incremental: never duplicate a Tier-1 Edge Rescue pass.
    if (coreRescue?.decision === direction) return null;

    const candidates = Object.fromEntries(
      configs.map(cfg => [
        cfg.id,
        candidateDecision(direction, row.predictionFacts, row.predictionDelayMs, row.predictionScore, cfg),
      ])
    );

    const evaluated = {
      version,
      evaluatedAt: Date.now(),
      productionEffect: 'AUTO_GATED_EXPANSION',
      baseDirection: direction,
      baseSelectiveReasons: Array.isArray(selectiveQuality?.reasons)
        ? [...selectiveQuality.reasons]
        : [],
      coreRescueReasons: Array.isArray(coreRescue?.reasons)
        ? [...coreRescue.reasons]
        : [],
      candidates,
    };

    row.selectiveV2EdgeExpansionShadow = evaluated;
    try { onPersist(); } catch {}

    log('selective_v2_edge_expansion_evaluated', {
      round: row.roundStartMs,
      version,
      baseDirection: direction,
      baseSelectiveReasons: evaluated.baseSelectiveReasons,
      coreRescueReasons: evaluated.coreRescueReasons,
      decisions: Object.fromEntries(
        Object.entries(candidates).map(([id, v]) => [id, v?.decision || 'WAIT'])
      ),
      productionEffect: 'AUTO_GATED_EXPANSION',
    });

    return evaluated;
  }

  function summarizeArray(arr) {
    const hits = arr.filter(x => x.decision === x.actual).length;
    return {
      samples: arr.length,
      hits,
      misses: arr.length - hits,
      accuracy: arr.length ? Number((hits / arr.length).toFixed(4)) : null,
    };
  }

  function directionStats(decided, direction) {
    const all = decided.filter(x => x.decision === direction);
    const recent = all.slice(-directionRecentWindow);
    let missStreak = 0;
    let maxConsecutiveErrors = 0;
    let running = 0;
    for (const x of all) {
      if (x.decision === x.actual) {
        running = 0;
      } else {
        running += 1;
        maxConsecutiveErrors = Math.max(maxConsecutiveErrors, running);
      }
    }
    for (let i = all.length - 1; i >= 0; i -= 1) {
      if (all[i].decision === all[i].actual) break;
      missStreak += 1;
    }
    const allStats = summarizeArray(all);
    const recentStats = summarizeArray(recent);
    const allowed =
      allStats.samples >= directionMinSamples &&
      Number.isFinite(allStats.accuracy) &&
      allStats.accuracy >= directionAccuracy &&
      recentStats.samples >= directionRecentWindow &&
      Number.isFinite(recentStats.accuracy) &&
      recentStats.accuracy >= directionAccuracy &&
      missStreak <= maxMissStreak &&
      maxConsecutiveErrors <= maxMissStreak;
    return {
      ...allStats,
      recent: recentStats,
      missStreak,
      maxConsecutiveErrors,
      allowed,
      blockReason: allowed
        ? null
        : allStats.samples < directionMinSamples
          ? 'NEEDS_DIRECTION_SAMPLES'
          : Number.isFinite(allStats.accuracy) && allStats.accuracy < directionAccuracy
            ? 'DIRECTION_ACCURACY_BELOW_70'
            : Number.isFinite(recentStats.accuracy) && recentStats.accuracy < directionAccuracy
              ? 'DIRECTION_RECENT_ACCURACY_BELOW_70'
              : missStreak > maxMissStreak || maxConsecutiveErrors > maxMissStreak
                ? 'DIRECTION_MISS_STREAK'
                : 'DIRECTION_GATE_NOT_READY',
    };
  }

  function summary(rowsInput) {
    const rows = normalizedRows(rowsInput)
      .filter(r => Number(r?.roundStartMs) >= Number(startMs))
      .sort((a, b) => Number(a.roundStartMs) - Number(b.roundStartMs));

    // Fail closed: count only certified official outcomes and frozen baseline WAIT.
    const settledSinceStart = rows.filter(isOfficialStrictSettlement);
    const observed = settledSinceStart.filter(r => isFrozenFinalBaselineWait(r, version));
    const baseline = productionBaselineSummary(settledSinceStart);

    const candidates = configs.map(cfg => {
      const decided = observed
        .map(row => ({
          row,
          actual: row.actual,
          decision: row.selectiveV2EdgeExpansionShadow?.candidates?.[cfg.id]?.decision || 'WAIT',
        }))
        .filter(x => x.decision === 'UP' || x.decision === 'DOWN');

      const overall = summarizeArray(decided);
      const recent = summarizeArray(decided.slice(-recentWindow));
      const confidenceLower95 = wilsonLowerBound(overall.hits, overall.samples);
      const combined = prospectiveCombinedSummary(baseline, decided);

      let running = 0;
      let maxConsecutiveErrors = 0;
      for (const x of decided) {
        if (x.decision === x.actual) {
          running = 0;
        } else {
          running += 1;
          maxConsecutiveErrors = Math.max(maxConsecutiveErrors, running);
        }
      }

      const up = directionStats(decided, 'UP');
      const down = directionStats(decided, 'DOWN');
      const allowedDirections = [];
      if (up.allowed) allowedDirections.push('UP');
      if (down.allowed) allowedDirections.push('DOWN');

      const incrementalCoverage = settledSinceStart.length
        ? Number((overall.samples / settledSinceStart.length).toFixed(4))
        : null;
      const poolCoverage = observed.length
        ? Number((overall.samples / observed.length).toFixed(4))
        : null;

      const qualifiedBase =
        overall.samples >= minSamples &&
        Number.isFinite(overall.accuracy) &&
        overall.accuracy >= targetAccuracy &&
        confidenceLower95 !== null && confidenceLower95 >= 0.70 &&
        baseline.samples >= 20 &&
        combined.meetsAbsoluteFloor && combined.notWorseThanBaseline &&
        recent.samples >= recentWindow &&
        summarizeArray(decided.slice(-10)).accuracy >= 0.70 &&
        up.samples >= directionMinSamples &&
        down.samples >= directionMinSamples &&
        up.allowed && down.allowed &&
        Number.isFinite(recent.accuracy) &&
        recent.accuracy >= recentAccuracy &&
        maxConsecutiveErrors <= maxMissStreak &&
        Number.isFinite(incrementalCoverage) &&
        incrementalCoverage >= minIncrementalCoverage;

      let status = 'FORWARD_COLLECTING';
      if (
        overall.samples >= retireMinSamples &&
        Number.isFinite(overall.accuracy) &&
        overall.accuracy < retireAccuracy
      ) {
        status = 'RETIRED_LOW_ACCURACY';
      } else if (qualifiedBase && allowedDirections.length > 0) {
        status = 'AUTO_QUALIFIED';
      } else if (qualifiedBase) {
        status = 'QUALIFIED_WAITING_DIRECTION';
      } else if (
        overall.samples >= minSamples &&
        (
          (Number.isFinite(overall.accuracy) && overall.accuracy < recentAccuracy) ||
          (recent.samples >= recentWindow && Number.isFinite(recent.accuracy) && recent.accuracy < recentAccuracy) ||
          maxConsecutiveErrors > maxMissStreak
        )
      ) {
        status = 'AUTO_DEMOTED_DRIFT';
      }

      return {
        candidateId: cfg.id,
        relaxationRank: Number(cfg.relaxationRank || 999),
        config: cfg,
        status,
        productionEffect: 'AUTO_GATED_EXPANSION',
        strictForwardSamples: overall.samples,
        targetSamples,
        remainingSamples: Math.max(0, targetSamples - overall.samples),
        hits: overall.hits,
        misses: overall.misses,
        forwardAccuracy: overall.accuracy,
        confidenceLower95,
        prospectiveCombined: combined,
        baselineSamples: baseline.samples,
        recent20Accuracy: recent.accuracy,
        recent20Samples: recent.samples,
        recent10Accuracy: summarizeArray(decided.slice(-10)).accuracy,
        recent10Samples: Math.min(10, decided.length),
        maxConsecutiveErrors,
        incrementalCoverage,
        poolCoverage,
        up,
        down,
        allowedDirections,
      };
    }).sort((a, b) =>
      Number(b.incrementalCoverage || 0) - Number(a.incrementalCoverage || 0) ||
      Number(b.forwardAccuracy || 0) - Number(a.forwardAccuracy || 0) ||
      Number(a.relaxationRank || 999) - Number(b.relaxationRank || 999)
    );

    const autoQualified = candidates.filter(x => x.status === 'AUTO_QUALIFIED');

    return {
      ok: true,
      version,
      startMs,
      productionEffect: 'AUTO_GATED_EXPANSION',
      autoPromotionEnabled: true,
      settledRoundsSinceStart: settledSinceStart.length,
      observedTier1RejectedSettledRounds: observed.length,
      baselineProduction: baseline,
      proofPolicy: 'OFFICIAL_ROUND_ALIGNED_FROZEN_BASELINE_WAIT_COMBINED_V1',
      gates: {
        minSamples,
        targetSamples,
        targetAccuracy,
        recentWindow,
        recentAccuracy,
        directionMinSamples,
        directionRecentWindow,
        directionAccuracy,
        maxMissStreak,
        minIncrementalCoverage,
        retireMinSamples,
        retireAccuracy,
      },
      candidates,
      leader: candidates[0] || null,
      autoQualified,
    };
  }

  function selectProductionCandidate(rowsInput, currentEvaluation, direction) {
    const dir = direction === 'UP' || direction === 'DOWN' ? direction : null;
    if (!dir || currentEvaluation?.version !== version) {
      return { allowed: false, reason: 'NO_CURRENT_EXPANSION_EVALUATION', candidate: null, summary: summary(rowsInput) };
    }

    const s = summary(rowsInput);
    const eligible = s.candidates.filter(candidate => {
      if (candidate.status !== 'AUTO_QUALIFIED') return false;
      if (!candidate.allowedDirections.includes(dir)) return false;
      const current = currentEvaluation?.candidates?.[candidate.candidateId];
      return current?.decision === dir;
    });

    if (!eligible.length) {
      return {
        allowed: false,
        reason: 'NO_AUTO_QUALIFIED_EXPANSION_CANDIDATE',
        candidate: null,
        summary: s,
      };
    }

    const candidate = eligible[0];
    return {
      allowed: true,
      reason: null,
      candidate,
      summary: s,
    };
  }

  return {
    version,
    startMs,
    configs,
    evaluate,
    summary,
    selectProductionCandidate,
  };
}
