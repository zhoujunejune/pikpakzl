"""Multiple independent simulated positions without re-entry cooldown."""
import datetime as dt
import unittest
from unittest.mock import patch
from types import SimpleNamespace
import bot
from paper_portfolio import migrate_paper_state, positions_for_display, reserved_margin

CONTROL={"entry_enabled":True,"emergency_stop":False,"leverage":10,
         "risk_fraction":0.015,"max_margin_fraction":0.15}
PRICES={"BTCUSDT":100000.0,"ETHUSDT":3000.0,"BTCUSDC":100000.0}

class FakeAPI:
    def __init__(self):
        self.prices=dict(PRICES)
    def info(self):
        return {sym:{"symbol":sym,"status":"TRADING","contractType":"PERPETUAL",
             "marginAsset":"USDC" if sym.endswith("USDC") else "USDT",
             "filters":[{"filterType":"MARKET_LOT_SIZE","stepSize":"0.001","minQty":"0.001","maxQty":"100"},
                        {"filterType":"MIN_NOTIONAL","notional":"50"}]} for sym in bot.SYMBOLS}
    def mark(self,sym):
        return self.prices[sym]
    def candles(self,sym,interval,limit=160):
        return [sym]
    def positions(self):
        raise AssertionError("Paper mode must not query private exchange positions")

def state_with_legacy_btc():
    return {"balance":200.0,"day":dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%d"),
            "day_start":200.0,"history":[{"trade":{"symbol":"ETHUSDT","side":"SELL"},"net":2,"at":1}],
            "trade":{"symbol":"BTCUSDT","side":"BUY","qty":0.003,"entry":100000.,
                     "stop":99000.,"tp":102000.,"at":123456,"paper":True},
            "last_signal":"BTCUSDT-555","last_exit":9999999999.,"halt":False,"pending":None}

class MultiSymbolPaperTests(unittest.TestCase):
    def setUp(self):
        self.api=FakeAPI()
        self.candle_close=1111
        def build_signal(c5,c1):
            symbol=c5[0]
            return {"symbol":None,"side":"BUY","price":self.api.prices[symbol],
                    "distance":self.api.prices[symbol]*0.004,
                    "strength":0.1,"candle_close":self.candle_close}
        self.patchers=[
            patch.object(bot,"MODE","paper"),
            patch.object(bot,"signal",side_effect=build_signal),
            patch.object(bot,"save",lambda state:None),
            patch.object(bot,"read_control",return_value=dict(CONTROL)),
            patch.object(bot,"KILL_FILE",SimpleNamespace(exists=lambda:False))
        ]
        for p in self.patchers:p.start()
    def tearDown(self):
        for p in reversed(self.patchers):p.stop()

    def test_legacy_btc_kept_and_other_symbols_enter_while_it_is_open(self):
        s=state_with_legacy_btc()
        bot.tick(self.api,s)
        self.assertIsNone(s["trade"])
        self.assertEqual(set(s["paper_positions"]),set(bot.SYMBOLS))
        self.assertEqual(s["paper_positions"]["BTCUSDT"]["at"],123456)
        self.assertEqual(s["history"][0]["trade"]["symbol"],"ETHUSDT")
        self.assertEqual(s["balance"],200)
        self.assertEqual(s["last_signals"]["BTCUSDT"],"BTCUSDT-555")
        self.assertLess(reserved_margin(s["paper_positions"],10),200)
        self.assertGreater(s["paper_positions"]["ETHUSDT"]["qty"],0)
        self.assertGreater(s["paper_positions"]["BTCUSDC"]["qty"],0)

    def test_closing_pair_reenters_next_bar_without_30_minute_delay(self):
        s=state_with_legacy_btc()
        bot.tick(self.api,s)
        s["paper_positions"].pop("ETHUSDT")
        bot.tick(self.api,s)
        self.assertNotIn("ETHUSDT",s["paper_positions"])  # cannot replay same 5-minute signal
        self.candle_close+=1
        bot.tick(self.api,s)
        self.assertIn("ETHUSDT",s["paper_positions"])
        self.assertEqual(s["last_signals"]["ETHUSDT"],"ETHUSDT-1112")

    def test_all_three_can_open_from_empty_in_same_cycle(self):
        s={"balance":200.0,"day":None,"day_start":200.0,
           "history":[],"trade":None,"pending":None,"halt":False,"last_exit":9999999999.}
        bot.tick(self.api,s)
        self.assertEqual(set(s["paper_positions"]),set(bot.SYMBOLS))
        self.assertEqual(len(s["last_signals"]),3)

    def test_each_symbol_exit_settles_independently(self):
        s=state_with_legacy_btc()
        bot.tick(self.api,s)
        self.api.prices["ETHUSDT"]=2900.  # its BUY stop breached
        with patch.object(bot,"signal",return_value=None):
            bot.tick(self.api,s)
        self.assertNotIn("ETHUSDT",s["paper_positions"])
        self.assertIn("BTCUSDT",s["paper_positions"])
        self.assertIn("BTCUSDC",s["paper_positions"])
        self.assertEqual(s["history"][-1]["trade"]["symbol"],"ETHUSDT")
        self.assertEqual(s["history"][-1]["reason"],"STOP")

    def test_pausing_entries_still_reconciles_existing_stops(self):
        s=state_with_legacy_btc()
        bot.tick(self.api,s)
        self.api.prices["BTCUSDT"]=98000.0
        with patch.object(bot,"read_control",return_value={**CONTROL,"entry_enabled":False}):
            bot.tick(self.api,s)
        self.assertNotIn("BTCUSDT",s["paper_positions"])
        self.assertEqual(s["history"][-1]["reason"],"STOP")
        self.assertIn("ETHUSDT",s["paper_positions"])

    def test_migration_rejects_ambiguous_nonpaper_positions(self):
        s={"trade":{"symbol":"BTCUSDT","paper":False}}
        with self.assertRaises(ValueError):
            migrate_paper_state(s,lambda x:None)
        s={"paper_positions":{"BTCUSDT":{"symbol":"BTCUSDT","paper":True}},
           "trade":{"symbol":"BTCUSDC","paper":True},"last_signals":{}}
        with self.assertRaises(ValueError):
            positions_for_display(s)

if __name__=="__main__":
    unittest.main()
