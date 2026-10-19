"""Offline safety regression tests: no network access and no real orders."""
import pathlib
import tempfile
import unittest
from unittest.mock import patch,MagicMock

import live_control
import live_engine

class LiveSwitchTests(unittest.TestCase):
    def setUp(self):
        self.dir=tempfile.TemporaryDirectory()
        self.path=pathlib.Path(self.dir.name)/"live-control.json"
        self.p=patch.object(live_control,"PATH",self.path)
        self.p.start()
    def tearDown(self):
        self.p.stop();self.dir.cleanup()
    def test_off_by_default_and_disarm_on_restart(self):
        self.assertFalse(live_control.read()["enabled"])
        live_control.save_enabled(True)
        self.assertTrue(live_control.read()["enabled"])
        live_control.disarm_at_startup()
        self.assertFalse(live_control.read()["enabled"])
    def test_corrupt_control_fails_closed(self):
        self.path.write_text("{broken")
        with self.assertRaises(Exception):live_control.read()
    def test_hedge_mode_uses_explicit_side(self):
        self.assertEqual(live_engine.position_side("BUY",True),"LONG")
        self.assertEqual(live_engine.position_side("SELL",True),"SHORT")
        self.assertEqual(live_engine.position_side("BUY",False),"BOTH")

class LiveExecutionSafetyTests(unittest.TestCase):
    def test_unarmed_live_tick_never_contacts_order_exchange(self):
        state=live_engine.blank()
        api=MagicMock()
        controls={"entry_enabled":True,"emergency_stop":False,
            "leverage":10,"risk_fraction":.015,"max_margin_fraction":.15}
        with patch.object(live_engine,"read_control",return_value=controls), \
             patch.object(live_engine.live_control,"read",return_value={"enabled":False}), \
             patch.object(live_engine.bot.KILL_FILE,"exists",return_value=False):
            live_engine.tick(api,state,True)
        api.call.assert_not_called()
        api.positions.assert_not_called()
    def test_hedge_order_includes_long_and_exchange_stop_tp(self):
        state=live_engine.blank()
        s={"symbol":"BTCUSDT","side":"BUY","price":100.0,
            "distance":1.5,"candle_close":10,"strength":1}
        p={"symbol":"BTCUSDT","positionSide":"LONG","positionAmt":"1",
           "entryPrice":"100"}
        class Fake:
            def __init__(self):
                self.orders=[]
                self.placed=False
                self.n=0
            def positions(self):
                return [p] if self.placed else []
            def call(self,method,path,params=None,signed=False):
                if path=="/fapi/v1/order":
                    self.placed=True
                    self.orders.append(("entry",params))
                    return {"orderId":100,"status":"FILLED"}
                if path=="/fapi/v1/algoOrder":
                    self.n+=1
                    self.orders.append(("algo",params))
                    return {"algoId":self.n}
                return {}
        fake=Fake()
        with patch.object(live_engine,"persist",return_value=None):
            live_engine.enter(fake,state,s,1.0,
                {"filters":[{"filterType":"PRICE_FILTER","tickSize":"0.01"}]},True,10)
        self.assertIsNone(state["pending"])
        self.assertEqual(len(state["live_positions"]["BTCUSDT"]["algo_ids"]),2)
        self.assertEqual(fake.orders[0][1]["positionSide"],"LONG")
        self.assertEqual([x[1]["type"] for x in fake.orders[1:]],
                         ["STOP_MARKET","TAKE_PROFIT_MARKET"])
        self.assertTrue(all(x[1]["positionSide"]=="LONG" and
                            x[1]["closePosition"]=="true" for x in fake.orders[1:]))
    def test_reject_foreign_positions_before_market_order(self):
        state=live_engine.blank()
        s={"symbol":"BTCUSDT","side":"BUY","distance":1.5}
        class Fake:
            def positions(self):
                return [{"symbol":"ETHUSDT","positionSide":"SHORT",
                         "positionAmt":"-1"}]
            def call(self,method,path,params=None,signed=False):
                if path=="/fapi/v1/order":raise AssertionError("MUST NOT SUBMIT")
                return {}
        with self.assertRaises(RuntimeError):
            live_engine.enter(Fake(),state,s,1,{},True,10)
        self.assertIsNone(state["pending"])

if __name__=="__main__":unittest.main()
