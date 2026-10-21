import importlib.util
import pathlib
import unittest

path = pathlib.Path(__file__).with_name("deepseek_shadow_readonly_audit.py")
spec = importlib.util.spec_from_file_location("deepseek_shadow_readonly_audit", path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
ROUND = 1800000000000


def source(records):
    return {"officialSource": module.OFFICIAL, "records": records}


def state():
    return {"model": "DEEPSEEK_5M_V1", "configured": True,
            "providerModel": "deepseek-flash", "round": ROUND,
            "decisionWindowEndMs": ROUND + 270000,
            "maxCallsPerRound": 6,
            "learning": {"allOfficialSamples": 93, "predictions": 94,
                         "modelWeightsFineTuned": False}}


def resolved(offset, direction, actual, elapsed=85):
    r = ROUND + 300000 * offset
    return {"round": r, "signalAt": r + elapsed * 1000,
            "settledAt": r + 301000, "direction": direction,
            "actual": actual, "provider": "deepseek-flash"}


class ReadOnlyAuditTest(unittest.TestCase):
    def test_valid_resolved_aggregate_and_timing(self):
        rows = [resolved(0, "UP", "UP", 45),
                resolved(1, "DOWN", "UP", 85),
                resolved(2, "DOWN", "DOWN", 185)]
        got = module.assess(source(rows), state(), {"model": "DEEPSEEK_5M_V1"})
        self.assertEqual(got["causalSettled"]["n"], 3)
        self.assertEqual(got["causalSettled"]["hits"], 2)
        self.assertEqual(got["timingByLockSecond"][1]["n"], 1)
        self.assertEqual(got["timingByLockSecond"][3]["n"], 1)
        self.assertIsNone(got["tradeEconomics"]["netProfit"])
        self.assertEqual(got["learning"]["officialSamplesReported"], 93)
        self.assertEqual(got["auditMode"], "READ_ONLY_NO_ORDERS")

    def test_reject_duplicate_unsettled_and_lookahead(self):
        d = resolved(0, "UP", "UP")
        wrong = resolved(1, "UP", "DOWN")
        wrong["settledAt"] = wrong["round"] + 10
        rows = [d, d.copy(), wrong, resolved(2, "DOWN", None),
                resolved(3, "UP", "UP", 275), resolved(4, "UP", "UP", 90)]
        got = module.assess(source(rows), state(), {"model": "DEEPSEEK_5M_V1"})
        self.assertEqual(got["causalSettled"]["n"], 2)
        self.assertEqual(got["rejectedOrUnavailable"]["duplicateRound"], 1)
        self.assertEqual(got["rejectedOrUnavailable"]["unsettled"], 1)
        self.assertEqual(got["rejectedOrUnavailable"]["invalidOrNonCausalRecord"], 2)

    def test_reject_mismatched_model_or_unverified_official(self):
        with self.assertRaises(ValueError):
            module.assess(source([]), state(), {"model": "BASELINE"})
        with self.assertRaises(ValueError):
            module.assess({"officialSource": "SPOT_PRICE_PROXY", "records": []},
                          state(), {"model": "DEEPSEEK_5M_V1"})

    def test_small_samples_have_wide_uncertainty(self):
        got = module.assess(source([resolved(0, "UP", "UP")]), state(),
                            {"model": "DEEPSEEK_5M_V1"})
        self.assertTrue(got["causalSettled"]["insufficientSample"])
        self.assertLess(got["causalSettled"]["wilson95"][0], .25)

    def test_does_not_return_raw_history_or_credentials(self):
        row = resolved(0, "UP", "DOWN")
        row["apiKey"] = "DO_NOT_LEAK"
        got = module.assess(source([row]), state(), {"model": "DEEPSEEK_5M_V1"})
        self.assertNotIn("DO_NOT_LEAK", repr(got))


if __name__ == "__main__":
    unittest.main()
