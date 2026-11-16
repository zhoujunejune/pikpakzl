import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch
import json

SPEC = importlib.util.spec_from_file_location("prediction_readonly", Path(__file__).with_name("serve.py"))
mod = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(mod)

class PredictionIsolationTests(unittest.TestCase):
    def test_navigation_has_both_independent_routes(self):
        self.assertIn('href="/dashboard/"', mod.PAGE)
        self.assertIn('href="/prediction/"', mod.PAGE)
        self.assertIn('fetch("api/overview"', mod.PAGE)
        self.assertNotIn('/api/control', mod.PAGE)
        self.assertNotIn('onclick="act(', mod.PAGE)

    def test_separate_loopback_and_no_trading(self):
        self.assertEqual(mod.HOST, "127.0.0.1")
        self.assertNotIn("BINANCE_API_SECRET", Path(__file__).with_name("serve.py").read_text())
        self.assertEqual(len(mod.SOURCES), 3)
        self.assertTrue(all(u.startswith("https://") for u in mod.SOURCES.values()))

    def test_aggregated_readonly_keys(self):
        class Response:
            status = 200
            def __enter__(self): return self
            def __exit__(self, *args): return None
            def read(self, n): return json.dumps({
                "ok": True, "productionSignalSourceMode": "BASELINE",
                "activeSignalModels": [{"id": "BASELINE", "name": "Baseline"}],
                "settlementSource": "OFFICIAL", "summary": {"hit": 2},
                "records": [{"roundStartMs": 1, "direction": "UP"}],
                "userSecret": "must-not-propagate"
            }).encode()
        with patch.object(mod.urllib.request, "urlopen", return_value=Response()):
            data = mod.fetch_source("v2", mod.SOURCES["v2"])
        self.assertTrue(data["ok"])
        self.assertEqual(data["productionSignalSourceMode"], "BASELINE")
        self.assertNotIn("userSecret", data)
        self.assertEqual(len(data["records"]), 1)

    def test_timeout_fails_closed(self):
        with patch.object(mod.urllib.request, "urlopen", side_effect=TimeoutError("timeout")):
            data = mod.fetch_source("v2", mod.SOURCES["v2"])
        self.assertFalse(data["ok"])
        self.assertEqual(data["error"], "TimeoutError")

if __name__ == "__main__":
    unittest.main()
