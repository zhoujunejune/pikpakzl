#!/usr/bin/env python3
import argparse
import json
import math
import os
import pickle
import sys
import time
import warnings

warnings.filterwarnings("ignore")

import numpy as np
import pandas as pd
from flaml import AutoML
from river.drift import ADWIN
from sklearn.metrics import accuracy_score, brier_score_loss

ENGINE_VERSION = "FLAML_QLIB_ROLLING_RIVER_V3"
MIN_OBSERVE_DELAY_MS = 8000
MAX_OBSERVE_DELAY_MS = 20000
PREDICTION_BOOK_MAX_AGE_MS = 5000
EMBARGO_ROWS = 2
INNER_VALID_ROWS = 40
OUTER_HOLDOUT_ROWS = 40
WINDOWS = (300, 450, 600, 900)
ESTIMATORS = ("lgbm", "xgboost", "catboost", "extra_tree")

FEATURE_NAMES = [
    "regimeScore",
    "currentScore",
    "microScore",
    "currentTrendScore",
    "normalizedMomentum15s",
    "normalizedMomentum30s",
    "normalizedMomentum60s",
    "normalizedMomentum180s",
    "normalizedMomentum300s",
    "tradePressure15s",
    "tradePressure60s",
    "ofiNormalized5s",
    "ofiNormalized60s",
    "rangePosition180",
    "absorptionRisk",
    "predictionMarketUpMidCentered",
    "predictionMarketMissing",
    "currentMidAgreement",
    "trendMidAgreement",
    "ofiPressureInteraction",
    "momentumAgreement60x300",
    "shortLongMomentumGap",
    "pressureImbalance",
]


def emit(payload):
    print("SHADOW_V3_RESULT=" + json.dumps(payload, separators=(",", ":"), ensure_ascii=False), flush=True)


def finite_number(value):
    try:
        n = float(value)
    except (TypeError, ValueError):
        return None
    return n if math.isfinite(n) else None


def clip(value, lo=-3.0, hi=3.0):
    return max(lo, min(hi, float(value)))


def feature_row(facts):
    if not isinstance(facts, dict):
        return None

    required = {}
    for key in [
        "regimeScore", "currentScore", "microScore", "currentTrendScore",
        "normalizedMomentum15s", "normalizedMomentum30s", "normalizedMomentum60s",
        "normalizedMomentum180s", "normalizedMomentum300s",
        "tradePressure15s", "tradePressure60s", "ofiNormalized5s", "rangePosition180",
    ]:
        value = finite_number(facts.get(key))
        if value is None:
            return None
        required[key] = clip(value)

    ofi60 = finite_number(facts.get("ofiNormalized60s"))
    if ofi60 is None:
        ofi60 = 0.0

    up_mid = finite_number(facts.get("predictionMarketUpMid"))
    book_age = finite_number(facts.get("predictionMarketBookAgeMs"))
    prediction_valid = (
        facts.get("predictionMarketMappingReliable") is True
        and facts.get("predictionMarketRoundAligned") is True
        and book_age is not None
        and 0 <= book_age <= PREDICTION_BOOK_MAX_AGE_MS
        and up_mid is not None
    )
    mid = clip((up_mid - 0.5) * 2.0) if prediction_valid else 0.0
    missing = 0.0 if prediction_valid else 1.0
    absorption = 1.0 if facts.get("absorptionRisk") else 0.0

    current = required["currentScore"]
    trend = required["currentTrendScore"]
    m15 = required["normalizedMomentum15s"]
    m60 = required["normalizedMomentum60s"]
    m300 = required["normalizedMomentum300s"]
    p15 = required["tradePressure15s"]
    p60 = required["tradePressure60s"]
    ofi5 = required["ofiNormalized5s"]

    return {
        **required,
        "ofiNormalized60s": clip(ofi60),
        "absorptionRisk": absorption,
        "predictionMarketUpMidCentered": mid,
        "predictionMarketMissing": missing,
        "currentMidAgreement": clip(current * mid),
        "trendMidAgreement": clip(trend * mid),
        "ofiPressureInteraction": clip(ofi5 * p60),
        "momentumAgreement60x300": clip(m60 * m300),
        "shortLongMomentumGap": clip(m15 - m300),
        "pressureImbalance": clip(p15 - p60),
    }


def load_samples(history_path):
    with open(history_path, "r", encoding="utf-8") as f:
        rows = json.load(f)
    samples = []
    for row in rows if isinstance(rows, list) else []:
        round_ms = finite_number(row.get("roundStartMs"))
        observed_at = finite_number(row.get("shadowObservedAt"))
        if round_ms is None or observed_at is None:
            continue
        delay = observed_at - round_ms
        if delay < MIN_OBSERVE_DELAY_MS or delay > MAX_OBSERVE_DELAY_MS:
            continue
        if row.get("actualSource") != "BINANCE_PREDICTION_OFFICIAL_RESOLUTION":
            continue
        if "STRICT_ROUND_ALIGNED_TOPIC" not in str(row.get("resolutionEvidence") or ""):
            continue
        actual = row.get("actual")
        if actual not in ("UP", "DOWN"):
            continue
        x = feature_row(row.get("shadowFacts"))
        if x is None:
            continue
        samples.append({
            "roundStartMs": int(round_ms),
            "observedAt": int(observed_at),
            "y": 1 if actual == "UP" else 0,
            "x": x,
        })
    samples.sort(key=lambda z: z["roundStartMs"])
    return samples


def proba1(model, frame):
    probs = model.predict_proba(frame)
    arr = np.asarray(probs)
    if arr.ndim == 1:
        return arr.astype(float)
    classes = list(getattr(model, "classes_", [0, 1]))
    try:
        idx = classes.index(1)
    except ValueError:
        idx = 1 if arr.shape[1] > 1 else 0
    return arr[:, idx].astype(float)


def max_error_streak(y_true, p, threshold):
    streak = 0
    max_streak = 0
    for y, prob in zip(y_true, p):
        pred = 1 if prob >= threshold else 0
        if pred == int(y):
            streak = 0
        else:
            streak += 1
            max_streak = max(max_streak, streak)
    return max_streak


def optimize_threshold(y_true, p):
    best = None
    for k in range(44, 57):
        t = k / 100.0
        pred = (p >= t).astype(int)
        acc = float(accuracy_score(y_true, pred))
        streak = max_error_streak(y_true, p, t)
        score = acc - abs(t - 0.5) * 0.02 - streak * 0.002
        if best is None or score > best["score"]:
            best = {"threshold": t, "score": score, "accuracy": acc, "maxErrorStreak": streak}
    return best


def metrics(y_true, p, threshold):
    pred = (p >= threshold).astype(int)
    return {
        "accuracy": float(accuracy_score(y_true, pred)),
        "brier": float(brier_score_loss(y_true, p)),
        "hits": int(np.sum(pred == np.asarray(y_true))),
        "misses": int(np.sum(pred != np.asarray(y_true))),
        "maxErrorStreak": int(max_error_streak(y_true, p, threshold)),
    }


def search_metric(X_val, y_val, estimator, labels, X_train, y_train,
                  weight_val=None, weight_train=None, config=None,
                  groups_val=None, groups_train=None):
    p = np.asarray(estimator.predict_proba(X_val))
    if p.ndim == 2:
        p = p[:, 1]
    p = np.clip(p.astype(float), 1e-6, 1 - 1e-6)
    pred = (p >= 0.5).astype(int)
    acc = float(accuracy_score(y_val, pred))
    brier = float(brier_score_loss(y_val, p))
    streak = max_error_streak(y_val, p, 0.5)
    loss = 0.72 * (1.0 - acc) + 0.23 * brier + 0.05 * min(1.0, streak / 8.0)
    return loss, {"accuracy": acc, "brier": brier, "max_error_streak": streak}


def frame(samples):
    return pd.DataFrame([s["x"] for s in samples], columns=FEATURE_NAMES), np.asarray([s["y"] for s in samples], dtype=int)


def run_automl(train, valid, budget, seed):
    X_train, y_train = frame(train)
    X_val, y_val = frame(valid)
    automl = AutoML()
    automl.fit(
        X_train=X_train,
        y_train=y_train,
        X_val=X_val,
        y_val=y_val,
        task="classification",
        metric=search_metric,
        estimator_list=list(ESTIMATORS),
        time_budget=max(10, int(budget)),
        n_jobs=1,
        seed=int(seed),
        verbose=0,
        retrain_full=True,
        model_history=False,
        keep_search_state=False,
    )
    p = proba1(automl, X_val)
    threshold_info = optimize_threshold(y_val, p)
    m = metrics(y_val, p, threshold_info["threshold"])
    selection_score = (
        0.70 * m["accuracy"]
        - 0.22 * m["brier"]
        - 0.008 * m["maxErrorStreak"]
    )
    return automl, threshold_info["threshold"], m, float(selection_score)


def fit_final(samples, estimator_name, best_config, budget, seed):
    X, y = frame(samples)
    automl = AutoML()
    kwargs = dict(
        X_train=X,
        y_train=y,
        task="classification",
        metric=search_metric,
        estimator_list=[estimator_name],
        time_budget=max(10, int(budget)),
        max_iter=1,
        n_jobs=1,
        seed=int(seed),
        verbose=0,
        retrain_full=True,
        model_history=False,
        keep_search_state=False,
    )
    if isinstance(best_config, dict) and best_config:
        kwargs["starting_points"] = {estimator_name: best_config}
    automl.fit(**kwargs)
    return automl


def train_command(args):
    samples = load_samples(args.history)
    if len(samples) < args.min_samples:
        emit({"ok": True, "status": "INSUFFICIENT_SAMPLES", "samples": len(samples), "engineVersion": ENGINE_VERSION})
        return

    last_round = samples[-1]["roundStartMs"]
    outer_n = OUTER_HOLDOUT_ROWS
    tuning = samples[:-outer_n]
    outer = samples[-outer_n:]
    if len(tuning) < 220:
        emit({"ok": True, "status": "INSUFFICIENT_TUNING_SAMPLES", "samples": len(samples), "lastTrainRound": last_round, "engineVersion": ENGINE_VERSION})
        return

    candidate_windows = [w for w in WINDOWS if len(tuning) >= min(w, len(tuning))]
    if not candidate_windows:
        candidate_windows = [len(tuning)]

    per_budget = max(12, int(args.time_budget / max(1, len(candidate_windows))))
    searched = []
    for window in candidate_windows:
        scope = tuning[-min(window, len(tuning)):]
        valid_start = len(scope) - INNER_VALID_ROWS
        train_end = valid_start - EMBARGO_ROWS
        if train_end < 180:
            continue
        train = scope[:train_end]
        valid = scope[valid_start:]
        try:
            automl, threshold, inner, score = run_automl(train, valid, per_budget, args.seed + int(window))
            searched.append({
                "window": int(window),
                "automl": automl,
                "threshold": float(threshold),
                "inner": inner,
                "selectionScore": score,
                "bestEstimator": str(automl.best_estimator),
                "bestConfig": dict(automl.best_config or {}),
            })
        except Exception as exc:
            print(json.dumps({"event": "shadow_v3_window_search_failed", "window": window, "error": str(exc)}), file=sys.stderr, flush=True)

    if not searched:
        emit({"ok": False, "status": "SEARCH_FAILED", "lastTrainRound": last_round, "engineVersion": ENGINE_VERSION})
        return

    searched.sort(key=lambda z: z["selectionScore"], reverse=True)
    best = searched[0]

    X_outer, y_outer = frame(outer)
    p_outer = proba1(best["automl"], X_outer)
    outer_metrics = metrics(y_outer, p_outer, best["threshold"])

    train_scope = tuning[-min(best["window"], len(tuning)):]
    train_y = np.asarray([s["y"] for s in train_scope], dtype=int)
    prevalence = float((np.sum(train_y) + 2.0) / (len(train_y) + 4.0))
    baseline_label = 1 if prevalence >= 0.5 else 0
    baseline_acc = float(np.mean(y_outer == baseline_label))
    baseline_brier = float(brier_score_loss(y_outer, np.full(len(y_outer), prevalence)))

    reasons = []
    if outer_metrics["accuracy"] < baseline_acc + 0.03:
        reasons.append("OUTER_ACCURACY_NOT_ABOVE_BASELINE_3PP")
    if outer_metrics["accuracy"] < 0.56:
        reasons.append("OUTER_ACCURACY_BELOW_56")
    if outer_metrics["brier"] > baseline_brier:
        reasons.append("OUTER_BRIER_WORSE_THAN_BASELINE")
    if outer_metrics["maxErrorStreak"] > 5:
        reasons.append("OUTER_MAX_ERROR_STREAK_ABOVE_5")
    if best["inner"]["accuracy"] < 0.54:
        reasons.append("INNER_ACCURACY_BELOW_54")

    common = {
        "ok": True,
        "engineVersion": ENGINE_VERSION,
        "lastTrainRound": int(last_round),
        "strictSamples": len(samples),
        "windowSize": int(best["window"]),
        "threshold": round(float(best["threshold"]), 4),
        "bestEstimator": best["bestEstimator"],
        "bestConfig": best["bestConfig"],
        "innerValidation": best["inner"],
        "outerHoldout": {
            **outer_metrics,
            "baselineAccuracy": baseline_acc,
            "baselineBrier": baseline_brier,
            "samples": len(outer),
            "startRound": outer[0]["roundStartMs"],
            "endRound": outer[-1]["roundStartMs"],
        },
        "searched": [
            {
                "window": x["window"],
                "bestEstimator": x["bestEstimator"],
                "threshold": round(x["threshold"], 4),
                "innerValidation": x["inner"],
                "selectionScore": round(x["selectionScore"], 6),
            }
            for x in searched
        ],
        "trainerStack": ["FLAML", "LightGBM", "XGBoost", "CatBoost", "ExtraTrees", "QLIB_STYLE_ROLLING_PURGE", "River_ADWIN"],
    }

    if reasons:
        emit({**common, "status": "REJECTED_BEFORE_FORWARD", "reasons": reasons})
        return

    final_scope = samples[-min(best["window"], len(samples)):]
    try:
        final_model = fit_final(
            final_scope,
            best["bestEstimator"],
            best["bestConfig"],
            max(15, int(args.time_budget * 0.25)),
            args.seed + 991,
        )
    except Exception:
        final_model = best["automl"]

    trained_at = int(time.time() * 1000)
    model_version = f"shadow-v3-automl-{trained_at}"
    os.makedirs(args.out_dir, exist_ok=True)
    model_path = os.path.join(args.out_dir, model_version + ".pkl")
    with open(model_path, "wb") as f:
        pickle.dump(final_model, f, protocol=pickle.HIGHEST_PROTOCOL)

    emit({
        **common,
        "status": "CANDIDATE_REGISTERED",
        "modelVersion": model_version,
        "trainedAt": trained_at,
        "modelPath": model_path,
        "trainedSamples": len(final_scope),
    })


def predict_command(args):
    payload = json.load(sys.stdin)
    facts = payload.get("facts")
    x = feature_row(facts)
    if x is None:
        emit({"ok": False, "status": "INVALID_FEATURES", "predictions": []})
        return
    X = pd.DataFrame([x], columns=FEATURE_NAMES)
    predictions = []
    for item in payload.get("models", []):
        path = item.get("modelPath")
        version = item.get("modelVersion")
        try:
            with open(path, "rb") as f:
                model = pickle.load(f)
            p = float(proba1(model, X)[0])
            predictions.append({"modelVersion": version, "probability": round(max(0.001, min(0.999, p)), 6)})
        except Exception as exc:
            predictions.append({"modelVersion": version, "error": str(exc)})
    emit({"ok": True, "status": "PREDICTED", "predictions": predictions})


def drift_command(args):
    payload = json.load(sys.stdin)
    values = [float(x) for x in payload.get("errors", []) if x in (0, 1, 0.0, 1.0)]
    detector = ADWIN(delta=float(args.delta))
    detected_at = None
    for idx, value in enumerate(values):
        detector.update(value)
        if detector.drift_detected:
            detected_at = idx + 1
    emit({
        "ok": True,
        "status": "DRIFT_EVALUATED",
        "samples": len(values),
        "driftDetected": detected_at is not None,
        "detectedAt": detected_at,
        "width": float(detector.width),
        "estimation": float(detector.estimation),
        "variance": float(detector.variance),
        "library": "river.ADWIN",
    })


def main():
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)

    train = sub.add_parser("train")
    train.add_argument("--history", required=True)
    train.add_argument("--out-dir", required=True)
    train.add_argument("--min-samples", type=int, default=300)
    train.add_argument("--time-budget", type=int, default=75)
    train.add_argument("--seed", type=int, default=20261005)

    sub.add_parser("predict")

    drift = sub.add_parser("drift")
    drift.add_argument("--delta", type=float, default=0.002)

    args = parser.parse_args()
    if args.command == "train":
        train_command(args)
    elif args.command == "predict":
        predict_command(args)
    elif args.command == "drift":
        drift_command(args)


if __name__ == "__main__":
    main()
