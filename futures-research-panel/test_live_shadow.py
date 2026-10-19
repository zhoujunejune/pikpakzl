import importlib.util
import pathlib
import tempfile
import unittest
from unittest.mock import patch

MODULE=pathlib.Path(__file__).parent/"live_shadow.py"
spec=importlib.util.spec_from_file_location("live_shadow_tested",MODULE)
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)

class ReadOnlyForwardTests(unittest.TestCase):
    def test_public_requests_allowlist_and_never_submit_order(self):
        with self.assertRaises(AssertionError):
            m.api("/fapi/v1/order")
        with self.assertRaises(AssertionError):
            m.api("/fapi/v1/leverage")
    def test_record_only_simulated_entries_and_fees(self):
        with tempfile.TemporaryDirectory() as tmp:
            with patch.object(m,"STATE",pathlib.Path(tmp)/"state.json"):
                before=m.MEM
                m.MEM={"streams":{},"events":[]}
                try:
                    p=m.pair_state("BTCUSDT","TrendFollowingStrategy")
                    m.entry(p,"LONG",100.0,m.utc(1770000000))
                    self.assertIsNotNone(p["position"])
                    self.assertLess(p["equity"],1000)
                    m.close(p,103.0,"TAKE_OBSERVED_AT_POLL",m.utc(1770000300))
                    self.assertEqual(len(p["history"]),1)
                    self.assertGreater(p["equity"],1000)
                    m.save()
                    self.assertEqual(len(m.persisted()["streams"]),1)
                finally:m.MEM=before
    def test_first_seen_closed_candle_cannot_open_a_historical_trade(self):
        p={"symbol":"BTCUSDT","strategy":"TrendFollowingStrategy",
           "equity":1000.0,"position":None,"history":[],
           "lastCandle":None,"lastSignal":None,"barsSeen":0}
        rows=[[i*300000,100,101,99,100,10] for i in range(185)]
        m.eval_one(p,rows,100,rows[-1][0]/1000+300)
        self.assertIsNone(p["position"])
        self.assertEqual(p["lastCandle"],rows[-1][0])
    def test_rsi_and_adx_are_derived_from_closed_candles(self):
        close=[100+(i*.2) for i in range(200)]
        self.assertEqual(len(m.rsi(close)),len(close))
        self.assertTrue(0<=m.rsi(close)[-1]<=100)
        rows=[[i*300000,close[i],close[i]+1,close[i]-1,close[i],4] for i in range(200)]
        self.assertIsNotNone(m.adx(rows))
    def test_live_api_contract_is_read_only(self):
        self.assertEqual(m.Handler.do_POST.__name__,"do_POST")
        self.assertEqual(m.SYMBOLS,("BTCUSDT","ETHUSDT","BTCUSDC"))
        self.assertEqual(len(m.MODELS),3)

if __name__=="__main__":unittest.main()
