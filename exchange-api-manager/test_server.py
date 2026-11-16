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
    def test_config_persists_across_restarts_and_other_bot_updates(self):
        # No in-memory cache: a new process reads credentials from disk.
        original=api.validate(self.record("futures"))
        original["updatedAt"]="2026-10-19T10:00:00+00:00"
        api.persist(original)
        p=api.validate(self.record("prediction"))
        p["apiKey"]="P"*32
        api.persist(p)
        self.assertTrue(api.runtime_ready(original))
        self.assertTrue(api.runtime_ready(p))
        self.assertEqual(api.safe_read("futures","binance"),original)
        # Saving an unrelated exchange cannot modify the existing keys.
        unrelated=self.record("futures","okx")
        unrelated["apiKey"]="O"*32
        api.persist(api.validate(unrelated))
        self.assertEqual(api.safe_read("futures","binance"),original)
        self.assertTrue(api.runtime_ready(original))

    def test_only_explicit_delete_removes_selected_config(self):
        f=api.validate(self.record("futures"))
        p=api.validate(self.record("prediction"))
        p["apiKey"]="P"*32
        api.persist(f)
        api.persist(p)
        self.assertTrue(api.safe_read("futures","binance"))
        self.assertTrue(api.delete_saved("futures","binance"))
        self.assertIsNone(api.safe_read("futures","binance"))
        self.assertFalse(api.runtime_ready(api.safe_read("futures","binance")))
        self.assertEqual(api.safe_read("prediction","binance"),p)
        self.assertTrue(api.runtime_ready(p))
        tombstone=(api.ROOT/"futures/binance.env").read_text()
        self.assertIn("BINANCE_API_KEY=\n",tombstone)
        self.assertIn("BINANCE_API_SECRET=\n",tombstone)
        self.assertFalse(api.delete_saved("futures","binance"))
        # Replacement after deliberate deletion restores correct isolated env.
        f["apiKey"]="N"*32
        api.persist(f)
        self.assertTrue(api.runtime_ready(f))

    def test_deletion_for_non_binance_never_erases_binance(self):
        f=api.validate(self.record("futures"))
        other=api.validate(self.record("futures","bybit"))
        api.persist(f)
        api.persist(other)
        self.assertTrue(api.delete_saved("futures","bybit"))
        self.assertTrue(api.runtime_ready(f))
        self.assertIsNone(api.safe_read("futures","bybit"))

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
    def test_unsaved_inputs_cannot_be_mistaken_for_configured_api(self):
        # Protect users against clicking 'test' on an unsaved password field.
        self.assertIn("if(!storedAPIConfigured||!storedRuntimeReady)",api.PAGE)
        self.assertIn("API_NOT_CONFIGURED",api.PAGE)
        self.assertIn("填写输入框不等于保存成功",api.PAGE)
        self.assertIn("你填写了尚未保存的 API",api.PAGE)
        self.assertIn("请先点击",api.PAGE)
        self.assertNotIn('API Key 已验证成功',api.PAGE)

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
