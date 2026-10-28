"""Regression coverage for the *remote* production Guardian risk-worker patch.
No credentials, network, Binance orders, or production writes are used.
"""
import ast
import pathlib
import subprocess
import sys
import tempfile
import unittest

STAGE = pathlib.Path(__file__).with_name("aliyun_guardian_risk_stage.py")

def patch_source():
    tree = ast.parse(STAGE.read_text(encoding="utf-8"))
    shell = next(node.value.value for node in tree.body
                 if isinstance(node, ast.Assign)
                 and any(isinstance(t, ast.Name) and t.id == "SCRIPT"
                         for t in node.targets))
    begin = "python3 - \"$BASE/risk-worker.mjs\" \"$STAGE/risk-worker.mjs\" <<'PY'\n"
    return shell.split(begin, 1)[1].split("\nPY\n", 1)[0]

def fixture():
    return """import fs from 'node:fs';
const workerBusy = false;
function evaluateRisk(targets,quote) {return {ok:true}}
function quoteTooCloseToExpiry(quote) {return false}
function tick() {
  if (workerBusy) return;
  if(!TAKE_PROFIT_ENABLED&&!STOP_LOSS_ENABLED&&!hasDual5Positions())return;
  health.positionsSeen = Array.isArray(positionsResult.positions) ? positionsResult.positions.length : null;
  const a = evaluateRisk(targets, quoteResult.quote);
  const b = evaluateRisk(targets, quoteResult.quote);
  const targetAmount = evaluation.reason === 'STOP_LOSS' ? targets.slTarget : targets.tpTarget;
  const targetAmount = evaluation.reason === 'STOP_LOSS' ? targets.slTarget : targets.tpTarget;
  log('risk_tick_exception', { error: e?.message || String(e) });
}
const result = { scope: SCOPE, };
"""

def apply(src):
    with tempfile.TemporaryDirectory(prefix="guardian-risk-guard-") as tmp:
        current = pathlib.Path(tmp, "worker.mjs")
        output = pathlib.Path(tmp, "patched.mjs")
        current.write_text(src, encoding="utf-8")
        result = subprocess.run(
            [sys.executable, "-", str(current), str(output)],
            input=patch_source(), text=True, capture_output=True, timeout=10)
        return result, output.read_text() if output.exists() else ""

class ProductionGuardPatchTests(unittest.TestCase):
    def test_split_guards_preserve_dual_exits_and_busy_protection(self):
        p, changed = apply(fixture())
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertIn("if (workerBusy) return;", changed)
        self.assertIn("!STOP_LOSS_ENABLED&&!GUARDIAN_RISK_ENABLED&&!hasDual5Positions()", changed)
        self.assertEqual(changed.count("evaluatePositionRisk(position,targets,quoteResult.quote)"), 2)
        self.assertEqual(changed.count("evaluation.dynamic ? evaluation.targetAmount"), 2)
        self.assertIn("guardianRiskHeartbeat(false)", changed)

    def test_unknown_guard_aborts_before_any_output_file(self):
        p, changed = apply(fixture().replace(
            "if(!TAKE_PROFIT_ENABLED&&!STOP_LOSS_ENABLED&&!hasDual5Positions())return;",
            "if(UNKNOWN_RISK_CONDITION)return;"))
        self.assertNotEqual(p.returncode, 0)
        self.assertIn("UNRECOGNIZED_LIVE_TICK_GUARD", p.stderr)
        self.assertEqual(changed, "")

    def test_missing_busy_guard_is_not_silently_accepted(self):
        p, changed = apply(fixture().replace("if (workerBusy) return;", ""))
        self.assertNotEqual(p.returncode, 0)
        self.assertIn("UNRECOGNIZED_LIVE_WORKER_BUSY_GUARD", p.stderr)
        self.assertEqual(changed, "")

    def test_already_wired_file_is_not_double_patched(self):
        p, changed = apply(fixture() + "\n// guardianRiskQuote\n")
        self.assertNotEqual(p.returncode, 0)
        self.assertIn("GUARDIAN_RISK_ALREADY_WIRED_ABORT", p.stderr)
        self.assertEqual(changed, "")

if __name__ == "__main__":
    unittest.main()
