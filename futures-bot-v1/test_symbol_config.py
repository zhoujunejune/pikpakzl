import unittest
from symbol_config import ALLOWED_SYMBOLS, DEFAULT_SYMBOLS, margin_asset

class SymbolConfigTests(unittest.TestCase):
    def test_three_supported_contracts(self):
        self.assertEqual(set(DEFAULT_SYMBOLS.split(",")),set(ALLOWED_SYMBOLS))
        self.assertEqual(margin_asset("BTCUSDC"),"USDC")
        self.assertEqual(margin_asset("BTCUSDT"),"USDT")
        self.assertEqual(margin_asset("ETHUSDT"),"USDT")
        with self.assertRaises(ValueError):
            margin_asset("BTCUSD_PERP")

if __name__=="__main__":
    unittest.main()
