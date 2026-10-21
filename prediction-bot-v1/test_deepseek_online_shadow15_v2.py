import unittest
import tempfile
import sys
from pathlib import Path
from deepseek_online_shadow15_v2 import Shadow,feature_vector,FEATURES,ROUND_MS,OFFICIAL,MODEL
R=1792545000000

def fake_feed(now):
 r=(now//ROUND_MS)*ROUND_MS
 def rows(step,total):
  return [{"startMs":r-step*i,"open":100+(i%4)*.01,
     "high":100.3+(i%4)*.01,"low":99.7+(i%3)*.01,
     "close":100+(i%5)*.025,"volume":50+(i%11)*2,
     "closed":True} for i in range(total,0,-1)]
 return {"ok":True,"readOnly":True,"symbol":"BTCUSDT",
  "latest":{"eventMs":now-900,"roundStartMs":r,"lastPrice":100.1,
     "roundOpenPrice":100.,"marketFeedConnected":True},
  "candles":{"1m":rows(60000,80),"5m":rows(300000,65)}}

class Clock:
 def __init__(self,value):self.value=value
 def __call__(self):return self.value

class OnlineShadow15Tests(unittest.TestCase):
 def test_capture_only_inside_15_seconds_and_train_only_on_official(self):
  c=Clock(R+7999)
  with tempfile.TemporaryDirectory() as tmp:
   s=Shadow(file=Path(tmp)/"shadow15.json",clock=c)
   self.assertFalse(s.observe(fake_feed(c())))
   c.value=R+9100
   self.assertTrue(s.observe(fake_feed(c())))
   self.assertFalse(s.observe(fake_feed(c())))
   sample=s.state["samples"][0]
   self.assertEqual(sample["signalLatencyMs"],9100)
   self.assertEqual(sample["trainedBefore"],0)
   self.assertEqual(len(sample["features"]),14)
   self.assertAlmostEqual(sample["probUp"],.5)
   self.assertEqual(s.status()["settledTrained"],0)
   c.value=R+ROUND_MS+1000
   self.assertEqual(s.settle({"ok":True,"settlementSource":OFFICIAL,
    "records":[{"roundStartMs":R,"productionActual":"UP",
     "productionSettledAt":c(),"officialSettlementAudit":{"verified":True}}]}),1)
   self.assertEqual(s.status()["settledTrained"],1)
   self.assertNotEqual(s.state["weights"],[0.]*14)
   self.assertEqual(s.state["samples"][0]["probUp"],.5)
   self.assertEqual(s.state["samples"][0]["trainedBefore"],0)
   self.assertEqual(s.state["trainedWeightVersions"][0]["version"],1)
   self.assertEqual(s.settle({"ok":True,"settlementSource":OFFICIAL,"records":[]}),0)
   reopened=Shadow(file=Path(tmp)/"shadow15.json",clock=c)
   self.assertEqual(reopened.status()["currentWeightVersion"],1)
   self.assertEqual(reopened.status()["model"],MODEL)
   self.assertFalse(reopened.status()["orders"])
 def test_no_sampling_after_exact_deadline_and_no_stale_price(self):
  c=Clock(R+15000)
  with tempfile.TemporaryDirectory() as tmp:
   s=Shadow(file=Path(tmp)/"v2.json",clock=c)
   self.assertFalse(s.observe(fake_feed(c())))
   c.value=R+11000
   m=fake_feed(c())
   m["latest"]["eventMs"]=c()-3000
   with self.assertRaisesRegex(ValueError,"STALE_MARKET"):
    s.observe(m)
   self.assertEqual(s.status()["observations"],0)
   x=fake_feed(c())
   x["latest"]["roundStartMs"]=R-300000
   with self.assertRaisesRegex(ValueError,"WRONG_ROUND"):
    feature_vector(x,c())
 def test_future_or_fake_settlement_never_updates_weights(self):
  c=Clock(R+310000)
  with tempfile.TemporaryDirectory() as tmp:
   s=Shadow(file=Path(tmp)/"v2.json",clock=c)
   c.value=R+9000
   self.assertTrue(s.observe(fake_feed(c())))
   c.value=R+ROUND_MS+12000
   ok={"roundStartMs":R,"productionActual":"DOWN",
       "officialSettlementAudit":{"verified":True}}
   with self.assertRaisesRegex(ValueError,"UNVERIFIED_OFFICIAL_SOURCE"):
    s.settle({"ok":True,"settlementSource":"PROXY_PRICE","records":[ok]})
   self.assertEqual(s.settle({"ok":True,"settlementSource":OFFICIAL,
    "records":[{**ok,"productionSettledAt":R+ROUND_MS+18000}]}),0)
   self.assertEqual(s.settle({"ok":True,"settlementSource":OFFICIAL,
    "records":[{**ok,"productionSettledAt":R+ROUND_MS-1}]}),0)
   self.assertEqual(s.status()["settledTrained"],0)
 def test_no_mixed_v1_state_and_no_pnl_claims(self):
  c=Clock(R+11000)
  with tempfile.TemporaryDirectory() as tmp:
   p=Path(tmp)/"v2.json"
   p.write_text('{"schema":1,"features":[],"weights":[],"trained":90}')
   s=Shadow(file=p,clock=c)
   self.assertEqual(s.status()["settledTrained"],0)
   self.assertEqual(s.status()["captureWindowMs"],[8000,15000])
   self.assertEqual(s.status()["readyForEvaluation"],False)
   self.assertEqual(s.status()["all"]["n"],0)
   self.assertEqual(s.status()["recent50"]["wilson95"],None)
   self.assertTrue(s.observe(fake_feed(c())))
   self.assertEqual(s.status()["unsettled"],1)
 def test_closed_candle_timestamp_must_be_fresh(self):
  c=Clock(R+9000)
  m=fake_feed(c())
  for k in ("1m","5m"):
   for candle in m["candles"][k]:candle["startMs"]-=3600000
  with self.assertRaisesRegex(ValueError,"STALE_CLOSED_CANDLES"):
   feature_vector(m,c())
if __name__=="__main__":unittest.main()
