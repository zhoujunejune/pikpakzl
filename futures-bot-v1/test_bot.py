import unittest
from bot import ema, atr, signal, quantity_for, levels, pnl

class RiskTests(unittest.TestCase):
    def test_ema_flat(self):
        self.assertAlmostEqual(ema([100]*60, 20), 100)
    def test_levels(self):
        self.assertAlmostEqual(levels("BUY",100,2)[0],98)
        self.assertAlmostEqual(levels("BUY",100,2)[1],103.6)
        self.assertAlmostEqual(levels("SELL",100,2)[0],102)
        self.assertAlmostEqual(levels("SELL",100,2)[1],96.4)
    def test_quantity_limit(self):
        info={"filters":[
            {"filterType":"MARKET_LOT_SIZE","stepSize":"0.001","minQty":"0.001","maxQty":"100"},
            {"filterType":"MIN_NOTIONAL","notional":"5"},
            {"filterType":"PRICE_FILTER","tickSize":"0.01"}]}
        # 200 USDT, 10x, 15% margin -> max notional 300
        q=quantity_for(200, 100, 1, info)
        self.assertAlmostEqual(q,3)
    def test_quantity_min_notional(self):
        info={"filters":[{"filterType":"MARKET_LOT_SIZE","stepSize":"1","minQty":"1","maxQty":"100"},
                         {"filterType":"MIN_NOTIONAL","notional":"100"}]}
        self.assertEqual(quantity_for(200, 500, 5, info),0)
    def test_pnl_includes_fees(self):
        t={"side":"BUY","entry":100,"qty":1}
        self.assertAlmostEqual(pnl(t,101),1-(100+101)*.0005)
    def test_btcusdc_margin_wallet_and_quantity(self):
        from bot import SYMBOLS, API
        from symbol_config import margin_asset
        self.assertIn("BTCUSDC", SYMBOLS)
        self.assertEqual(margin_asset("BTCUSDC"),"USDC")
        self.assertEqual(margin_asset("BTCUSDT"),"USDT")
        api=API()
        def fake_call(method,path,params=None,signed=False):
            self.assertEqual(path,"/fapi/v3/balance")
            return [{"asset":"USDT","balance":"0"},{"asset":"USDC","balance":"200"}]
        api.call=fake_call
        self.assertEqual(api.balance("USDC"),200)
        self.assertEqual(api.balance("USDT"),0)
        rules={"filters":[
            {"filterType":"MARKET_LOT_SIZE","stepSize":"0.001","minQty":"0.001","maxQty":"50"},
            {"filterType":"MIN_NOTIONAL","notional":"50"}]}
        self.assertAlmostEqual(quantity_for(api.balance("USDC"),120000,480,rules),0.002)
        self.assertEqual(quantity_for(api.balance("USDT"),120000,480,rules),0.)
    def test_ban_response_is_not_retried(self):
        from bot import API
        class FakeResp:
            status_code=418
            headers={"Retry-After":"3600"}
            text="IP temporarily banned"
            ok=False
        class FakeSession:
            def __init__(self): self.count=0
            def request(self,*a,**kw):
                self.count+=1
                return FakeResp()
        client=API()
        client.session=FakeSession()
        with self.assertRaisesRegex(RuntimeError, "HTTP 418; Retry-After=3600"):
            client.call("GET","/fapi/v1/time")
        self.assertEqual(client.session.count,1)

    def test_no_signal_flat_market(self):
        c=[]
        for i in range(160):
            c.append([i, "100", "100.1", "99.9", "100", "1", i+1])
        self.assertIsNone(signal(c,c))

if __name__=="__main__":
    unittest.main()
