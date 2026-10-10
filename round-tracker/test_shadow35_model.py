"""Causal policy tests; synthetic outcomes never count as market validation."""
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("shadow35_model", ROOT / "shadow35-model.py")
model = importlib.util.module_from_spec(spec)
spec.loader.exec_module(model)
START = 1780000000000 // model.ROUND_MS * model.ROUND_MS


def snapshot(start, checkpoint=15000, sign=1):
    features = {name: sign * (i + 1) / 20 for i, name in enumerate(model.RAW_FEATURE_NAMES)}
    features.update(predictionMarketUpMid=0.7 if sign > 0 else 0.3,
                    absorptionRisk=0, spreadBps=0.1, vol5sRms60=0.2, vol5sRms300=0.3)
    observed = start + (34000 if checkpoint == 35000 else checkpoint + 100)
    return {"type": "snapshot", "schemaVersion": 1, "valid": True,
            "roundStartMs": start, "checkpointMs": checkpoint, "observedAt": observed,
            "factsCalculatedAt": observed - 50, "features": features}


def settlement(start, actual="UP"):
    return {"type": "settlement", "roundStartMs": start, "actual": actual,
            "actualSource": model.OFFICIAL_SOURCE,
            "resolutionEvidence": "OFFICIAL_" + actual + ":STRICT_ROUND_ALIGNED_TOPIC",
            "settledAt": start + model.ROUND_MS + 10,
            "recordedAt": start + model.ROUND_MS + 20}


def round_row(i, actual="UP", count=2):
    start = START + i * model.ROUND_MS
    return {"roundStartMs": start, "actual": actual, "y": int(actual == "UP") if actual else None,
            "settledAt": start + model.ROUND_MS + 10 if actual else None,
            "snapshots": [{"checkpointMs": cp, "observedAt": start + cp,
                           "x": [cp / 1000] + [1.0] * len(model.RAW_FEATURE_NAMES)}
                          for cp in model.CHECKPOINTS_MS[:count]]}


class CausalModelTests(unittest.TestCase):
    def test_source_freshness_and_actual_deadline(self):
        good = snapshot(START, 35000)
        self.assertIsNone(model.snapshot_vector(good)[1])
        self.assertEqual(model.snapshot_vector(good)[0][0], 34.0)
        for change in ({"observedAt": START + 35001},
                       {"factsCalculatedAt": good["observedAt"] + 1},
                       {"factsCalculatedAt": good["observedAt"] - 1001},
                       {"schemaVersion": 2}, {"valid": False}):
            self.assertIsNone(model.snapshot_vector({**good, **change})[0])
        self.assertIsNone(model.finite(True))
        self.assertIsNone(model.finite("0.8"))
        self.assertIsNone(model.finite(float("nan")))

    def test_journal_official_visibility_conflicts_and_calendar_denominator(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "events.jsonl"
            cutoff = START + 5 * model.ROUND_MS
            future = settlement(START + 2 * model.ROUND_MS)
            future["recordedAt"] = cutoff + 1
            events = [snapshot(START), settlement(START), snapshot(START + 2 * model.ROUND_MS), future,
                      snapshot(START + 3 * model.ROUND_MS), settlement(START + 3 * model.ROUND_MS),
                      settlement(START + 3 * model.ROUND_MS, "DOWN")]
            path.write_text("\n".join(json.dumps(e) for e in events) + "\n")
            rounds, diagnostics = model.read_events(str(path), cutoff)
            self.assertEqual(len(rounds), 4)
            self.assertEqual([r["actual"] for r in rounds], ["UP", None, None, None])
            self.assertEqual(diagnostics["futureLabelsRejected"], 1)
            self.assertEqual(diagnostics["unknownLabelRounds"], 3)
            self.assertEqual(diagnostics["conflictingOfficialLabels"], 1)

    def test_delayed_labels_are_purged_between_every_time_fold(self):
        rounds = [round_row(i, "UP" if i % 2 else "DOWN", 5) for i in range(340)]
        rounds[100]["settledAt"] = rounds[170]["roundStartMs"]
        folds = model.chronological_split(rounds)
        for earlier, later in (("fit", "probabilityCalibration"), ("train", "calibration"),
                               ("calibration", "holdout")):
            boundary = folds[later][0]["roundStartMs"]
            for row in folds[earlier]:
                self.assertLess(row["roundStartMs"] + model.ROUND_MS, boundary)
                self.assertLess(row["settledAt"], boundary)
            self.assertTrue(set(r["roundStartMs"] for r in folds[earlier]).isdisjoint(
                r["roundStartMs"] for r in folds[later]))
        rows, labels, weights = model.flatten([round_row(1, count=5), round_row(2, count=1)])
        self.assertEqual(len(rows), 6)
        self.assertAlmostEqual(sum(weights[:5]), 1.0)
        self.assertEqual(weights[-1], 1.0)

    def test_first_eligible_policy_never_chooses_hindsight_checkpoint(self):
        rounds = [round_row(0, "DOWN"), round_row(1, "UP"), round_row(2, None)]
        probabilities = {rounds[0]["roundStartMs"]: [0.9, 0.01],
                         rounds[1]["roundStartMs"]: [0.55, 0.95],
                         rounds[2]["roundStartMs"]: [0.99, 0.99]}
        report = model.replay(rounds, probabilities, 0.8)
        self.assertEqual((report["rounds"], report["decisions"], report["hits"]), (3, 2, 1))
        self.assertEqual(report["checkpointDecisions"], {"15000": 1, "20000": 1})
        self.assertAlmostEqual(report["coverage"], 2 / 3)
        self.assertEqual(report["unknownLabelRounds"], 1)

    def test_accuracy_alone_does_not_select_sparse_threshold(self):
        rounds = [round_row(i, "UP" if i == 0 else "DOWN", 1) for i in range(20)]
        probabilities = {r["roundStartMs"]: [0.99 if i == 0 else 0.7] for i, r in enumerate(rounds)}
        selected = model.select_threshold(rounds, probabilities)
        self.assertEqual(selected["status"], "UNMET")
        self.assertEqual(selected["threshold"], 0.8)
        report = model.replay(rounds, probabilities, 0.8)
        qualified = model.qualification(selected, report, 0.8, 0.5)
        self.assertEqual(qualified["status"], "UNMET")
        self.assertFalse(qualified["longTermValidated"])

    def test_python_feature_contract_matches_collector(self):
        source = (ROOT / "shadow35-client.mjs").read_text()
        keys = source.split("const FEATURE_KEYS = [", 1)[1].split("];", 1)[0]
        import re
        self.assertEqual(tuple(re.findall(r"'([^']+)'", keys)), model.RAW_FEATURE_NAMES)


class ArtifactProtocolTests(unittest.TestCase):
    def invoke(self, action, payload):
        completed = subprocess.run([sys.executable, str(ROOT / "shadow35-model.py"), action],
                                   input=json.dumps(payload), text=True, capture_output=True, timeout=60)
        self.assertEqual(completed.returncode, 0, completed.stderr)
        line = next(s for s in completed.stdout.splitlines() if s.startswith("SHADOW35_RESULT="))
        return json.loads(line.split("=", 1)[1])

    def test_real_train_predict_freeze_recovery_and_integrity_protocol(self):
        with tempfile.TemporaryDirectory() as directory:
            events_path = Path(directory) / "events.jsonl"
            events = []
            for i in range(340):
                start, sign = START + i * model.ROUND_MS, 1 if i % 2 else -1
                events.extend(snapshot(start, cp, sign) for cp in model.CHECKPOINTS_MS)
                events.append(settlement(start, "UP" if sign > 0 else "DOWN"))
            events_path.write_text("\n".join(json.dumps(e) for e in events) + "\n")
            as_of = START + 341 * model.ROUND_MS
            request = {"eventsFile": str(events_path), "modelDir": str(Path(directory) / "models"),
                       "asOf": as_of, "minRounds": 300}
            trained = self.invoke("train", request)
            self.assertEqual(trained["status"], "CANDIDATE_REGISTERED")
            self.assertEqual(trained["productionEffect"], "NONE_SHADOW_ONLY")
            self.assertFalse(trained["longTermValidated"])
            self.assertEqual(trained["qualification"], "UNMET")  # too few independent market days
            self.assertIn("INSUFFICIENT_HOLDOUT_DAILY_BLOCKS", trained["qualificationDetails"]["reasons"])
            frozen = self.invoke("train", {**request, "asOf": as_of + model.ROUND_MS})
            self.assertEqual(frozen["status"], "FROZEN_CANDIDATE_EXISTS")
            self.assertEqual(frozen["modelVersion"], trained["modelVersion"])
            self.assertEqual(frozen["modelSha256"], trained["modelSha256"])
            prediction_request = {"modelPath": trained["modelPath"], "snapshot": snapshot(as_of + model.ROUND_MS)}
            predicted = self.invoke("predict", prediction_request)
            self.assertTrue(predicted["ok"])
            self.assertGreaterEqual(predicted["probability"], 0)
            self.assertLessEqual(predicted["probability"], 1)
            self.assertEqual(predicted["modelVersion"], trained["modelVersion"])
            old = self.invoke("predict", {**prediction_request, "snapshot": snapshot(START)})
            self.assertEqual(old["status"], "SNAPSHOT_PREDATES_TRAINED_MODEL")
            missing = self.invoke("predict", {"modelPath": trained["modelPath"], "features": {}})
            self.assertEqual(missing["status"], "INVALID_SNAPSHOT")
            with open(trained["modelPath"], "ab") as stream:
                stream.write(b"tampered")
            invalid = self.invoke("predict", prediction_request)
            self.assertEqual(invalid["status"], "MODEL_ARTIFACT_INTEGRITY_MISMATCH")


if __name__ == "__main__":
    unittest.main()
