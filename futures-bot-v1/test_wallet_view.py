"""Wallet balances remain distinctly real and never inferred from paper funds."""
import datetime as dt
import unittest
from wallet_view import parse_futures_wallet,public_wallet

class WalletDisplayTests(unittest.TestCase):
    def test_usdc_and_usdt_wallet_available_amounts_are_distinct(self):
        snap=parse_futures_wallet([
            {"asset":"USDT","balance":"12.34567891","availableBalance":"8.12345678"},
            {"asset":"USDC","balance":"35.56789012","availableBalance":"20.33330000"},
        ],now="2026-10-19T08:00:00+00:00")
        self.assertEqual(snap["assets"]["USDC"]["walletBalance"],35.56789012)
        self.assertEqual(snap["assets"]["USDC"]["availableBalance"],20.3333)
        self.assertEqual(snap["assets"]["USDT"]["walletBalance"],12.34567891)

    def test_missing_usdc_does_not_fake_zero(self):
        snap=parse_futures_wallet([{"asset":"USDT","balance":"15"}])
        self.assertNotIn("USDC",snap["assets"])
        self.assertIsNone(snap["assets"]["USDT"]["availableBalance"])

    def test_old_balances_marked_stale(self):
        snap=parse_futures_wallet([{"asset":"USDC","balance":"4","availableBalance":"3"}],
                 now="2026-10-19T07:00:00+00:00")
        visible=public_wallet(snap,now=dt.datetime(2026,10,19,8,0,tzinfo=dt.timezone.utc))
        self.assertEqual(visible["status"],"stale")
        self.assertEqual(visible["assets"]["USDC"]["walletBalance"],4)
        self.assertEqual(public_wallet(None)["status"],"unavailable")

    def test_transient_failure_not_claimed_fresh(self):
        snap=parse_futures_wallet([{"asset":"USDC","balance":"9"}])
        snap["status"]="exchange_restricted"
        self.assertEqual(public_wallet(snap)["status"],"exchange_restricted")

if __name__=="__main__":
    unittest.main()
