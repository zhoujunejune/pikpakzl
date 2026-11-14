import pathlib
import tempfile
import unittest
from unittest.mock import patch
import controls

class DashboardControlTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory()
        self.patch=patch.object(controls,"CONTROL_FILE",pathlib.Path(self.tmp.name)/"controls.json")
        self.patch.start()
    def tearDown(self):
        self.patch.stop();self.tmp.cleanup()
    def test_pause_resume(self):
        self.assertTrue(controls.read_control()["entry_enabled"])
        controls.change("pause")
        self.assertFalse(controls.read_control()["entry_enabled"])
        controls.change("resume")
        self.assertTrue(controls.read_control()["entry_enabled"])
    def test_emergency_stop_latches(self):
        c=controls.change("emergency_stop")
        self.assertTrue(c["emergency_stop"])
        with self.assertRaises(ValueError):controls.change("resume")
    def test_params_bounds(self):
        c=controls.change("set_params",{"leverage":20,"risk_fraction":.01,"max_margin_fraction":.1})
        self.assertEqual(c["leverage"],20)
        with self.assertRaises(ValueError):controls.change("set_params",{"leverage":99,"risk_fraction":.01,"max_margin_fraction":.1})
    def test_cannot_switch_to_live(self):
        with self.assertRaises(ValueError):
            controls.change("set_params",{"leverage":10,"risk_fraction":.01,"max_margin_fraction":.1,"MODE":"live"})
    def test_corrupt_config_fail_closed(self):
        controls.CONTROL_FILE.write_text("{invalid")
        with self.assertRaises(Exception):controls.read_control()

if __name__=="__main__":
    unittest.main()
