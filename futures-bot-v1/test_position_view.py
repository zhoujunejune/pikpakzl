import unittest
from position_view import view

TRADE={"symbol":"BTCUSDT","side":"BUY","qty":0.01,"entry":100000,
       "stop":99500,"tp":100900,"at":100000,"paper":True}
def quote(price=None,stale=False):
    return {"symbols":{"BTCUSDT":{"price":price,"stale":stale,"ageSeconds":10}}}

class PositionViewTests(unittest.TestCase):
    def test_flat_state_is_no_position(self):
        self.assertIsNone(view(None,quote(100200)))
    def test_buy_unrealized_net_includes_both_fees(self):
        d=view(TRADE,quote(100200))
        self.assertEqual(d["entryPrice"],100000)
        self.assertEqual(d["stopPrice"],99500)
        self.assertEqual(d["takeProfitPrice"],100900)
        self.assertAlmostEqual(d["estimatedGrossPnl"],2)
        self.assertAlmostEqual(d["estimatedNetPnl"],2-(100000+100200)*.01*.0005)
    def test_btcusdc_position(self):
        trade={**TRADE,"symbol":"BTCUSDC"}
        q={"symbols":{"BTCUSDC":{"price":100200,"stale":False,"ageSeconds":3}}}
        result=view(trade,q)
        self.assertEqual(result["marginAsset"],"USDC")
        self.assertIsNotNone(result["estimatedNetPnl"])
    def test_sell_unrealized(self):
        p={**TRADE,"side":"SELL","stop":100500,"tp":99100}
        d=view(p,quote(99800))
        self.assertGreater(d["estimatedNetPnl"],0)
    def test_stale_price_shows_no_pnl(self):
        d=view(TRADE,quote(100200,True))
        self.assertIsNone(d["markPrice"])
        self.assertIsNone(d["estimatedNetPnl"])
        self.assertTrue(d["markPriceStale"])
    def test_missing_quote_not_fake_profit(self):
        d=view(TRADE,{"symbols":{}})
        self.assertIsNone(d["estimatedNetPnl"])
    def test_corrupt_side_and_prices_fail_closed(self):
        self.assertIsNone(view({**TRADE,"side":"WAIT"},quote(100200)))
        self.assertIsNone(view({**TRADE,"stop":105000},quote(100200)))

if __name__=="__main__":
    unittest.main()
