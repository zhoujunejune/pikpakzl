import unittest
import tempfile
from pathlib import Path
from deepseek_online_shadow import Shadow,feature_vector,FEATURES,ROUND_MS,OFFICIAL
R=1792545000000
def fake_feed(now):
    r=(now//ROUND_MS)*ROUND_MS
    def rows(step,total):
        return [{"startMs":r-step*i,"open":100+(i%4)*.01,
                 "high":100.3+(i%4)*.01,"low":99.7+(i%3)*.01,
                 "close":100+(i%5)*.025,"volume":50+(i%11)*2,
                 "closed":True} for i in range(total,0,-1)]
    return {"ok":True,"readOnly":True,"symbol":"BTCUSDT",
            "latest":{"eventMs":now-100,"roundStartMs":r,
                      "lastPrice":100.1,"roundOpenPrice":100.,
                      "marketFeedConnected":True},
            "candles":{"1m":rows(60000,80),"5m":rows(300000,60)}}
class Clock:
    def __init__(self,value):self.value=value
    def __call__(self):return self.value
class ShadowTests(unittest.TestCase):
    def test_training_prequential_and_dedup(self):
        clock=Clock(R+31000)
        with tempfile.TemporaryDirectory() as tmp:
            path=Path(tmp)/"model.json"
            shadow=Shadow(file=path,clock=clock)
            m=fake_feed(clock())
            rnd,x=feature_vector(m,clock())
            self.assertEqual(rnd,R)
            self.assertEqual(len(x),len(FEATURES))
            self.assertTrue(shadow.observe(m))
            self.assertFalse(shadow.observe(m))
            self.assertEqual(shadow.status()["settledTrained"],0)
            self.assertEqual(shadow.status()["observations"],1)
            self.assertEqual(shadow.settle({"ok":True,"settlementSource":OFFICIAL,
                                          "records":[{"roundStartMs":R,"productionActual":"UP"}]}),0)
            clock.value=R+ROUND_MS+2000
            result={"ok":True,"settlementSource":OFFICIAL,
              "records":[{"roundStartMs":R,"productionActual":"UP",
                          "productionSettledAt":clock(),"officialSettlementAudit":{"verified":True}}]}
            self.assertEqual(shadow.settle(result),1)
            self.assertEqual(shadow.settle(result),0)
            stats=shadow.status()
            self.assertEqual(stats["settledTrained"],1)
            self.assertEqual(stats["all"]["accuracy"],1.0)
            self.assertEqual(stats["all"]["n"],1)
            self.assertTrue(any(x!=0 for x in shadow.state["weights"]))
            reboot=Shadow(file=path,clock=clock)
            self.assertEqual(reboot.status()["settledTrained"],1)
            self.assertEqual(reboot.settle(result),0)
    def test_stale_no_lookahead(self):
        now=R+31000
        m=fake_feed(now)
        m["latest"]["eventMs"]=now-20000
        with self.assertRaisesRegex(ValueError,"STALE_MARKET"):
            feature_vector(m,now)
        m=fake_feed(now)
        m["candles"]["1m"]=[{**x,"closed":False} for x in m["candles"]["1m"]]
        with self.assertRaisesRegex(ValueError,"CLOSED_CANDLES_INSUFFICIENT"):
            feature_vector(m,now)
    def test_unverified_settlement_rejected(self):
        now=R+ROUND_MS+1000
        clock=Clock(now)
        with tempfile.TemporaryDirectory() as tmp:
            s=Shadow(file=Path(tmp)/"model.json",clock=clock)
            with self.assertRaisesRegex(ValueError,"UNVERIFIED_OFFICIAL_SOURCE"):
                s.settle({"ok":True,"settlementSource":"LAST_PRICE_PROXY","records":[]})
if __name__=="__main__":unittest.main()
