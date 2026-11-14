import pathlib
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0,str(pathlib.Path(__file__).resolve().parent))
import auto_train as t

def artificial(count,interval):
    bars=[]
    for i in range(count):
        price=100+0.007*i+2.3*__import__("math").sin(i/13)+0.8*__import__("math").cos(i/7)
        start=1790000000000+i*interval
        bars.append([start,price,price+0.75,price-0.8,
                     price+0.15*__import__("math").sin(i/3),200+i%11])
    return bars

class AutomaticLearningTests(unittest.TestCase):
    def test_all_nine_combinations_have_bounded_candidates(self):
        self.assertEqual(len(t.candidates("TrendFollowingStrategy")),5)
        self.assertEqual(len(t.candidates("FSampleStrategy")),9)
        self.assertEqual(len(t.candidates("FAdxSmaStrategy")),81)
        self.assertNotIn("can_short",str(t.candidates("TrendFollowingStrategy")))
    def test_insufficient_candles_not_promoted(self):
        for model in t.BASELINES:
            result=t.study(artificial(200,300000),model)
            self.assertFalse(result["eligible"])
            self.assertEqual(result["status"],"INSUFFICIENT_CANDLES")
    def test_any_gap_blocks_retraining(self):
        candles=artificial(401,3600000)
        candles[200][0]+=1
        result=t.study(candles,"FSampleStrategy")
        self.assertEqual(result["status"],"DATA_GAP")
        self.assertFalse(result["eligible"])
    def test_forward_walk_data_has_non_overlapping_splits(self):
        bars=artificial(580,3600000)
        for model in ("FSampleStrategy","FAdxSmaStrategy"):
            r=t.study(bars,model)
            self.assertIn(r["status"],("VALIDATED_KEEP_BASELINE","ELIGIBLE"))
            self.assertEqual(r["trainCandles"]+r["holdoutCandles"],len(bars))
            self.assertEqual(r["candidateCount"],len(t.candidates(model)))
            self.assertEqual(r["method"],"chronological_70pct_train_30pct_holdout")
            self.assertTrue(r["notOfficialFreqtrade"])
    def test_five_minute_window_is_simulated_not_live(self):
        bars=artificial(3010,300000)
        r=t.study(bars,"TrendFollowingStrategy")
        self.assertTrue(r["notOfficialFreqtrade"])
        self.assertEqual(r["baselineParams"],{"ema":20})
        self.assertEqual(r["candidateCount"],5)
    def test_future_prices_never_affect_past_closed_candle_signal(self):
        bars=artificial(501,3600000)
        f=t.features(bars,"FSampleStrategy")
        sig=t.condition(f,"FSampleStrategy",t.BASELINES["FSampleStrategy"],250)
        bars[-1][4]*=1.9
        next_f=t.features(bars,"FSampleStrategy")
        self.assertEqual(sig,t.condition(next_f,"FSampleStrategy",t.BASELINES["FSampleStrategy"],250))
    def test_pure_training_has_no_exchange_order_transport(self):
        src=pathlib.Path(t.__file__).read_text()
        self.assertNotIn("/fapi/v1/order",src)
        self.assertNotIn("BINANCE_API_SECRET",src)
        self.assertNotIn("urllib.request",src)

if __name__=="__main__":
    unittest.main()
