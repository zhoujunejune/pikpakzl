import fs from 'node:fs';

const KEYS = ['GLOBAL', 'UP', 'DOWN'];
const fresh = () => ({
  mode: 'OPEN', until: 0, pendingRound: null, consecutiveHits: 0,
  lastProcessedRound: null, reason: null, rearmAfterRound: null,
});

// Strict-forward circuit: a 30-minute fuse cooldown, then at most one
// unsettled live trial. Two successive official HITs reopen the rescue lane;
// any trial MISS starts another 30-minute cooldown. Candidate shadow
// observations continue while blocked; no base or quality gates are bypassed.
export function createTimedEdgeRescueFuse({
  file, cooldownMs = 30 * 60 * 1000, now = () => Date.now(), log = () => {},
} = {}) {
  const scopes = Object.fromEntries(KEYS.map(k => [k, fresh()]));
  let rearmRevision = null;
  if (file) {
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (saved?.schemaVersion === 1) {
        rearmRevision = typeof saved.rearmRevision === 'string' ? saved.rearmRevision : null;
        for (const key of KEYS) {
          const x = saved.scopes?.[key];
          if (x && ['OPEN', 'COOLDOWN', 'HALF_OPEN', 'PROBATION_OPEN'].includes(x.mode)) {
            scopes[key] = {
              ...fresh(), ...x,
              until: Number(x.until) || 0,
              consecutiveHits: Math.max(0, Number(x.consecutiveHits) || 0),
              pendingRound: Number.isFinite(Number(x.pendingRound)) && x.pendingRound != null
                ? Number(x.pendingRound) : null,
              rearmAfterRound: Number.isFinite(Number(x.rearmAfterRound)) && x.rearmAfterRound != null
                ? Number(x.rearmAfterRound) : null,
            };
          }
        }
      }
    } catch (e) {
      if (e?.code !== 'ENOENT') log('edge_fuse_state_load_failed', { error: String(e?.message || e) });
    }
  }

  const persist = () => {
    if (!file) return;
    try {
      const temp = file + '.tmp-' + process.pid;
      fs.writeFileSync(temp, JSON.stringify({ schemaVersion: 1, scopes, rearmRevision }), 'utf8');
      fs.renameSync(temp, file);
    } catch (e) {
      log('edge_fuse_state_save_failed', { error: String(e?.message || e) });
    }
  };
  const emit = (scope, reason) => log('edge_rescue_timed_fuse_transition', {
    scope, mode: scopes[scope].mode, until: scopes[scope].until, reason,
  });
  const startCooldown = (key, at, reason) => {
    scopes[key] = {
      ...fresh(), mode: 'COOLDOWN', until: at + cooldownMs, reason,
      lastProcessedRound: scopes[key].lastProcessedRound,
    };
    emit(key, reason);
    persist();
  };
  const open = (key, reason) => {
    scopes[key] = { ...fresh(), lastProcessedRound: scopes[key].lastProcessedRound };
    emit(key, reason);
    persist();
  };
  // A versioned, one-time acknowledgement of the *currently tripped* fuse.
  // Existing historical outcomes remain available for audit but cannot
  // immediately retrip the same fuse. A NEW adverse settled candidate that
  // still breaches the original accuracy/miss-streak thresholds rearms it.
  // Reapplying the same revision (including on restart) does nothing.
  function rearmOnce(revision, latestRoundByScope = {}) {
    if (typeof revision !== 'string' || !revision.trim() || rearmRevision === revision) return false;
    for (const key of KEYS) {
      const rawRound = latestRoundByScope[key];
      const baseline = rawRound == null ? 0 : Number(rawRound);
      scopes[key] = {
        ...fresh(),
        reason: 'MANUAL_ONE_TIME_FUSE_CLEAR',
        rearmAfterRound: Number.isFinite(baseline) ? baseline : 0,
      };
      emit(key, 'MANUAL_ONE_TIME_FUSE_CLEAR');
    }
    rearmRevision = revision;
    persist();
    return true;
  }

  function rearmGuard(key, rawFused, latestEligible) {
    const x = scopes[key];
    if (x.rearmAfterRound == null) return rawFused;
    if (!rawFused) {
      // Old rolling accuracy has recovered: future violations use the
      // pre-existing circuit rules normally, with no temporary exception.
      x.rearmAfterRound = null;
      persist();
      return false;
    }
    const round = Number(latestEligible?.roundStartMs);
    if (Number.isFinite(round) && round > x.rearmAfterRound &&
        latestEligible?.miss === true) {
      x.rearmAfterRound = null;
      persist();
      return true;
    }
    return false;
  }

  const advance = (key, rawFused, at) => {
    const x = scopes[key];
    if (x.mode === 'OPEN' && rawFused) {
      startCooldown(key, at, 'ACCURACY_OR_MISS_STREAK');
    } else if (x.mode === 'COOLDOWN' && at >= x.until) {
      if (rawFused) {
        x.mode = 'HALF_OPEN';
        x.reason = 'COOLDOWN_EXPIRED_ONE_TRIAL';
        emit(key, x.reason);
        persist();
      } else {
        open(key, 'COOLDOWN_EXPIRED_FORWARD_RECOVERED');
      }
    } else if ((x.mode === 'HALF_OPEN' && x.pendingRound == null ||
                x.mode === 'PROBATION_OPEN') && !rawFused) {
      open(key, 'FORWARD_ACCURACY_RECOVERED');
    }
  };

  function check(direction, summary, at = now()) {
    if (direction !== 'UP' && direction !== 'DOWN') {
      return { allowed: false, reason: 'INVALID_DIRECTION' };
    }
    const globalFused = rearmGuard('GLOBAL', summary?.fuse?.globalFused === true, summary?.fuse?.latestEligible);
    const dirFused = rearmGuard(direction, summary?.[direction.toLowerCase()]?.fused === true, summary?.[direction.toLowerCase()]?.latestEligible);
    advance('GLOBAL', globalFused, at);
    advance(direction, dirFused, at);
    for (const key of ['GLOBAL', direction]) {
      const x = scopes[key];
      if (x.mode === 'COOLDOWN') {
        return { allowed: false, reason: key + '_COOLDOWN', remainingMs: Math.max(0, x.until - at) };
      }
      if (x.mode === 'HALF_OPEN' && x.pendingRound != null) {
        return { allowed: false, reason: key + '_TRIAL_AWAITING_OFFICIAL_SETTLEMENT' };
      }
    }
    const trial = ['GLOBAL', direction].some(k => scopes[k].mode === 'HALF_OPEN');
    return { allowed: true, reason: trial ? 'TIMED_HALF_OPEN_TRIAL' : null, trial };
  }

  function recordLock(direction, round) {
    if ((direction !== 'UP' && direction !== 'DOWN') || !Number.isFinite(Number(round))) return;
    let changed = false;
    for (const key of ['GLOBAL', direction]) {
      if (scopes[key].mode === 'HALF_OPEN' && scopes[key].pendingRound == null) {
        scopes[key].pendingRound = Number(round);
        changed = true;
      }
    }
    if (changed) {
      persist();
      log('edge_rescue_half_open_trial_locked', { direction, round: Number(round) });
    }
  }

  function onSettled(row) {
    const round = Number(row?.roundStartMs);
    if (!Number.isFinite(round) ||
        row?.actualSource !== 'BINANCE_PREDICTION_OFFICIAL_RESOLUTION' ||
        row?.productionSource !== 'SELECTIVE_V2_EDGE_RESCUE_PRIMARY' ||
        !['HIT', 'MISS'].includes(row?.productionResult)) return;
    const direction = row.productionPrediction;
    if (direction !== 'UP' && direction !== 'DOWN') return;
    const at = now();
    for (const key of ['GLOBAL', direction]) {
      const x = scopes[key];
      if (x.lastProcessedRound === round) continue;
      if (x.mode === 'HALF_OPEN' && x.pendingRound === round) {
        x.lastProcessedRound = round;
        if (row.productionResult === 'MISS') {
          startCooldown(key, at, 'HALF_OPEN_TRIAL_MISS');
        } else {
          x.pendingRound = null;
          x.consecutiveHits += 1;
          if (x.consecutiveHits >= 2) {
            x.mode = 'PROBATION_OPEN';
            x.reason = 'TWO_CONSECUTIVE_OFFICIAL_HITS';
          }
          emit(key, 'HALF_OPEN_TRIAL_HIT');
          persist();
        }
      } else if (x.mode === 'PROBATION_OPEN') {
        x.lastProcessedRound = round;
        if (row.productionResult === 'MISS') startCooldown(key, at, 'PROBATION_MISS');
        else persist();
      }
    }
  }

  function reconcile(rows) {
    // A deployment restart may occur after a trial settles. Consume only
    // the exact persisted pending round, never a different historical round.
    const pending = new Set(KEYS.map(k => scopes[k].pendingRound).filter(x => x != null));
    for (const row of rows) {
      if (pending.has(Number(row.roundStartMs))) onSettled(row);
    }
  }

  function status(at = now()) {
    return {
      cooldownMs,
      rearmRevision,
      scopes: Object.fromEntries(KEYS.map(key => [key, {
        ...scopes[key],
        remainingMs: scopes[key].mode === 'COOLDOWN'
          ? Math.max(0, scopes[key].until - at) : 0,
      }])),
    };
  }
  return { check, recordLock, onSettled, reconcile, rearmOnce, status };
}
