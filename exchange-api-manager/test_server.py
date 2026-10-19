"""Security and separation regression for the shared API credential manager."""
import importlib.util, json, os, pathlib, tempfile, unittest
from unittest.mock import patch

SPEC=importlib.util.spec_from_file_location("exchange_api",pathlib.Path(__file__).with_name("server.py"))
api=importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(api)

class Secrets(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory()
        self.prev=api.ROOT
        api.ROOT=pathlib.Path(self.tmp.name)
    def tearDown(self):
        api.ROOT=self.prev
        self.tmp.cleanup()
    def record(self,bot,exchange="binance"):
        return dict(bot=bot,exchange=exchange,apiKey="K"*32,apiSecret="S"*32,passphrase="",walletAddress="",walletId="")
    def test_independent_binance_env(self):
        f=api.validate(self.record("futures"))
        p=api.validate(self.record("prediction"))
        api.persist(f);api.persist(p)
        fv=(api.ROOT/"futures/binance.env").read_text()
        pv=(api.ROOT/"prediction/binance.env").read_text()
        self.assertIn("BINANCE_API_KEY=",fv)
        self.assertNotIn("BINANCE_PREDICTION_API_KEY=",fv)
        self.assertIn("BINANCE_PREDICTION_API_KEY=",pv)
        self.assertNotIn("\nBINANCE_API_KEY=",pv)
        self.assertNotEqual(api.path_for("futures","binance"),api.path_for("prediction","binance"))
        self.assertEqual((api.ROOT/"futures/binance.env").stat().st_mode & 0o777,0o600)
        self.assertEqual((api.ROOT/"prediction").stat().st_mode & 0o777,0o700)
    def test_future_exchange_stored_but_no_binance_env(self):
        r=self.record("futures","okx")
        r["passphrase"]="pass"
        api.persist(api.validate(r))
        self.assertTrue(api.safe_read("futures","okx"))
        self.assertFalse((api.ROOT/"futures/binance.env").exists())
        self.assertNotIn("okx",api.AUTHORIZED["futures"])
    def test_control_chars_and_invalid_bots(self):
        rec=self.record("futures");rec["apiSecret"]="abc\nsecret"
        with self.assertRaises(ValueError):api.validate(rec)
        rec=self.record("other")
        with self.assertRaises(ValueError):api.validate(rec)
    def test_page_never_discloses_saved_secret(self):
        record=self.record("futures")
        api.persist(api.validate(record))
        handler=object.__new__(api.Handler)
        self.assertNotIn(record["apiSecret"],api.PAGE)
        self.assertNotIn("apiSecret",json.dumps({
            "configured":bool(api.safe_read("futures","binance")),
            "updatedAt":api.safe_read("futures","binance").get("updatedAt")
        }))
    def test_login_and_origin_required(self):
        handler=object.__new__(api.Handler)
        class FakeHeaders(dict):
            def get(self,name,default=None):return super().get(name,default)
        handler.headers=FakeHeaders({"Host":"prediction.47-237-188-69.sslip.io",
          "X-ZL-Verified-Login":"1","Origin":"https://untrusted.example",
          "X-ZL-API-Manager":"1","Content-Type":"application/json","Sec-Fetch-Site":"same-origin"})
        handler.client_address=("127.0.0.1",1000)
        self.assertTrue(handler.checked())
        self.assertFalse(handler.post_security())
        handler.headers["Origin"]="https://prediction.47-237-188-69.sslip.io"
        self.assertTrue(handler.post_security())
        handler.headers.pop("X-ZL-Verified-Login")
        self.assertFalse(handler.checked())

if __name__=="__main__":unittest.main()
