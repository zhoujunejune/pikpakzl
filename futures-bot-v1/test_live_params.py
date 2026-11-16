"""Real-futures parameter editor tests; no Binance requests and no live orders."""
import io
import json
import os
import pathlib
import tempfile
import unittest
from unittest.mock import patch,Mock

import controls
import live_engine
from live_dashboard import PAGE
import serve

class LiveSizingSettingsTests(unittest.TestCase):
    def test_file_persistence_and_same_limits_as_order_sizing(self):
        with tempfile.TemporaryDirectory() as td,patch.object(controls,"CONTROL_FILE",pathlib.Path(td)/"settings.json"):
            original=controls.read_control()
            self.assertEqual(original["leverage"],10)
            change={"leverage":5,"risk_fraction":0.01,"max_margin_fraction":0.10}
            updated=controls.change("set_params",change)
            self.assertEqual(updated["max_margin_fraction"],0.10)
            self.assertEqual(controls.read_control()["leverage"],5)
            self.assertTrue(controls.read_control()["entry_enabled"])
            with self.assertRaises(ValueError):
                controls.change("set_params",{"leverage":100,"risk_fraction":.01,"max_margin_fraction":.1})
            self.assertEqual(controls.read_control()["leverage"],5)
    def test_live_status_returns_persisted_risk_and_margin_parameters(self):
        state=live_engine.blank()
        settings={"entry_enabled":True,"emergency_stop":False,"leverage":5,
                  "risk_fraction":0.0075,"max_margin_fraction":0.1}
        worker={"running":True,"error":None,"wallet":None,"preflight":None}
        with patch.object(live_engine,"load",return_value=state), \
             patch.object(live_engine.live_control,"read",return_value={"enabled":False}), \
             patch.object(live_engine,"read_control",return_value=settings):
            got=live_engine.snapshot(worker,{"symbols":{}})
        self.assertEqual(got["mode"],"live")
        self.assertFalse(got["liveTradingEnabled"])
        self.assertEqual(got["control"],settings)
    def test_set_params_route_never_arms_or_submits_order(self):
        payload={"action":"set_params","payload":{"leverage":5,"risk_fraction":.01,"max_margin_fraction":.12}}
        data=json.dumps(payload).encode()
        handler=object.__new__(serve.Handler)
        handler.path="/api/control"
        handler.headers={
            "Origin":"https://47-237-188-69.sslip.io",
            "Host":"47-237-188-69.sslip.io",
            "X-ZL-Control":"v1",
            "Content-Type":"application/json",
            "Sec-Fetch-Site":"same-origin",
            "Content-Length":str(len(data))}
        handler.rfile=io.BytesIO(data)
        responses=[]
        handler.send_json=lambda body,status=200:responses.append((status,body))
        settings={"leverage":5,"risk_fraction":.01,"max_margin_fraction":.12}
        with patch.dict(os.environ,{"PUBLIC_ORIGIN":"https://47-237-188-69.sslip.io"}), \
             patch.object(serve.bot,"MODE","live"), \
             patch.object(serve,"change",return_value=settings) as change, \
             patch.object(serve.live_control,"save_enabled") as live_switch, \
             patch.object(serve.bot.API,"call") as exchange_call:
            handler.do_POST()
        change.assert_called_once_with("set_params",payload["payload"])
        live_switch.assert_not_called()
        exchange_call.assert_not_called()
        self.assertEqual(responses,[(200,{"ok":True,"control":settings})])
    def test_live_panel_labels_and_save_request_present(self):
        self.assertIn('id="lev"',PAGE)
        self.assertIn('id="marginPct"',PAGE)
        self.assertIn('id="riskPct"',PAGE)
        self.assertIn('id="saveParams"',PAGE)
        self.assertIn('action:"set_params"',PAGE)
        self.assertIn('max_margin_fraction',PAGE)

if __name__=="__main__":
    unittest.main()
