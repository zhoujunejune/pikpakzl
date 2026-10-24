import unittest
from recovery import reconstruct_owned_position, ManualReviewRequired

class ExchangeRecoveryTests(unittest.TestCase):
    def setUp(self):
        self.pos=[{"symbol":"BTCUSDT","positionAmt":"0.004","entryPrice":"80000.0","positionSide":"BOTH"}]
        self.stop={"algoId":1001,"clientAlgoId":"ZLS_ownid","symbol":"BTCUSDT",
                   "side":"SELL","orderType":"STOP_MARKET","positionSide":"BOTH",
                   "closePosition":True,"algoStatus":"NEW","triggerPrice":"78000"}
        self.tp={"algoId":1002,"clientAlgoId":"ZLT_ownid","symbol":"BTCUSDT",
                 "side":"SELL","orderType":"TAKE_PROFIT_MARKET","positionSide":"BOTH",
                 "closePosition":True,"algoStatus":"NEW","triggerPrice":"83500"}
    def test_flat_account_safe(self):
        self.assertIsNone(reconstruct_owned_position([],[]))
    def test_owned_protected_position_reconstructed(self):
        r=reconstruct_owned_position(self.pos,[self.stop,self.tp])
        self.assertTrue(r["recovered"])
        self.assertEqual(r["side"],"BUY")
        self.assertEqual(r["algo_ids"],[1001,1002])
    def test_unrecognized_position_fails_closed(self):
        with self.assertRaises(ManualReviewRequired):
            reconstruct_owned_position(self.pos,[])
    def test_missing_stop_fails_closed(self):
        with self.assertRaises(ManualReviewRequired):
            reconstruct_owned_position(self.pos,[self.tp])
    def test_stop_wrong_side_fails_closed(self):
        with self.assertRaises(ManualReviewRequired):
            reconstruct_owned_position(self.pos,[dict(self.stop,side="BUY"),self.tp])
    def test_orphan_protection_fails_closed(self):
        with self.assertRaises(ManualReviewRequired):
            reconstruct_owned_position([],[self.stop])
    def test_duplicate_positions_fails_closed(self):
        with self.assertRaises(ManualReviewRequired):
            reconstruct_owned_position(self.pos+self.pos,[self.stop,self.tp])
    def test_wrong_mode_fails_closed(self):
        with self.assertRaises(ManualReviewRequired):
            reconstruct_owned_position([dict(self.pos[0],positionSide="LONG")],[self.stop,self.tp])
    def test_extra_protection_fails_closed(self):
        with self.assertRaises(ManualReviewRequired):
            reconstruct_owned_position(self.pos,[self.stop,self.tp,dict(self.tp,algoId=1003)])
    def test_manual_other_symbol_fails_closed(self):
        with self.assertRaises(ManualReviewRequired):
            reconstruct_owned_position([dict(self.pos[0],symbol="DOGEUSDT")],[self.stop,self.tp])

if __name__=="__main__":
    unittest.main()
