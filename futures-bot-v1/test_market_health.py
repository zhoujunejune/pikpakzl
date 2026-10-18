import unittest
from unittest.mock import patch
import market_health

class MarketFreshnessTests(unittest.TestCase):
    def setUp(self):
        self.a=patch.object(market_health,"_LAST",None)
        self.b=patch.object(market_health,"_LAST_ERROR",None)
        self.a.start(); self.b.start()
    def tearDown(self):
        self.a.stop();self.b.stop()
    def test_worker_alone_not_proof_of_market_feed(self):
        data=market_health.snapshot(True,now=1000)
        self.assertEqual(data["status"],"waiting_first_market_data")
        self.assertIsNone(data["lastSuccessAt"])
    def test_fresh_5m_candle(self):
        result=market_health.record("/fapi/v1/klines",
                  {"symbol":"BTCUSDT","interval":"5m"},
                  [[900000,0,0,0,"100"]],now=1000)
        self.assertTrue(result)
        s=market_health.snapshot(True,now=1030)
        self.assertEqual(s["status"],"market_data_received")
        self.assertEqual(s["lastSuccessAgeSeconds"],30)
        self.assertEqual(s["symbol"],"BTCUSDT")
    def test_stale_input_not_counted_as_success(self):
        self.assertFalse(market_health.record("/fapi/v1/klines",
                          {"symbol":"BTCUSDT","interval":"5m"},
                          [[1000,0,0,0,"100"]],now=1000))
        self.assertEqual(market_health.snapshot(True,now=1000)["status"],"waiting_first_market_data")
    def test_success_becomes_stale_without_refresh(self):
        market_health.record("/fapi/v1/premiumIndex",{"symbol":"ETHUSDT"},
                             {"markPrice":"100","time":1000000},now=1000)
        self.assertEqual(market_health.snapshot(True,now=1200)["status"],"market_data_stale")
    def test_failed_request_displayed(self):
        market_health.record_error(429,now=1000)
        s=market_health.snapshot(True,now=1030)
        self.assertEqual(s["status"],"request_failed")
        self.assertEqual(s["lastRequestError"],"429")
    def test_worker_not_running(self):
        self.assertEqual(market_health.snapshot(False,now=1000)["status"],"engine_stopped")
if __name__=="__main__":
    unittest.main()
