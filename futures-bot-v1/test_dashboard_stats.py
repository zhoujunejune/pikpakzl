"""Verify the paper dashboard discloses historical fills for all configured contracts."""
import unittest
from unittest.mock import patch
import serve

class DashboardSymbolStatsTests(unittest.TestCase):
    def test_closed_eth_fills_remain_visible_when_btc_is_active(self):
        sample={
            "balance":199.8,
            "history":[
                {"trade":{"symbol":"ETHUSDT","side":"SELL"},"net":2.3,"at":100},
                {"trade":{"symbol":"ETHUSDT","side":"SELL"},"net":-2.5,"at":200},
            ],
            "trade":{"symbol":"BTCUSDT","side":"BUY","qty":0.003,"entry":80000,
                     "stop":79000,"tp":81800,"at":300,"paper":True},
            "last_exit":0,"halt":False
        }
        with patch.object(serve.bot,"load",return_value=sample), \
             patch.object(serve,"market_snapshot",return_value={"status":"market_data_received"}), \
             patch.object(serve.quotes,"current",return_value={"symbols":{}}), \
             patch.object(serve,"paper_position_view",return_value={"symbol":"BTCUSDT"}), \
             patch.object(serve,"read_control",return_value={"entry_enabled":True,"emergency_stop":False,"leverage":10}):
            data=serve.public_snapshot()
        self.assertEqual(data["closedTrades"],2)
        self.assertEqual(data["symbolStats"]["ETHUSDT"]["closed"],2)
        self.assertEqual(data["symbolStats"]["ETHUSDT"]["wins"],1)
        self.assertTrue(data["symbolStats"]["BTCUSDT"]["open"])
        self.assertEqual(data["symbolStats"]["BTCUSDC"]["closed"],0)
        self.assertEqual(data["lastTrades"][0]["symbol"],"ETHUSDT")
        self.assertEqual(data["lastTrades"][0]["side"],"SELL")
        self.assertFalse(data["onePositionAcrossAllSymbols"])
        self.assertTrue(data["onePositionPerSymbol"])
        self.assertEqual(data["cooldownRemainingSeconds"],0)
        self.assertEqual(len(data["positions"]),1)
        self.assertAlmostEqual(data["paperMarginByAsset"]["USDT"],24)
        self.assertEqual(data["paperMarginByAsset"]["USDC"],0)
        self.assertAlmostEqual(data["paperFreeMargin"],175.8)
        self.assertEqual(data["paperUSDCRealizedPnL"],0)
        self.assertEqual(data["futuresWallet"]["status"],"unavailable")

if __name__=="__main__":
    unittest.main()
