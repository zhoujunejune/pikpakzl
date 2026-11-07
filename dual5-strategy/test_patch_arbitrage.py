import importlib.util
from pathlib import Path
import unittest

p=Path(__file__).with_name('patch_arbitrage.py')
spec=importlib.util.spec_from_file_location('dual_patch',p)
m=importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
SRC="""const MIN_EDGE=0.08; // $0.08 minimum remaining after conservative fee and execution reserve
const ENTRY_WINDOW_MS=15000,CONFIRM_WINDOW_MS=12000;
const cadence=elapsed<15000?700:(elapsed<60000?3000:19000);
   if(!estimate.ok){state.health='INVALID_PAIR_QUOTES';return}
   if(!config.armed){state.health='OPPORTUNITY_OBSERVED_TRADING_OFF';return}
"""

class PatchTests(unittest.TestCase):
    def test_only_dual_edge_gating(self):
        updated=m.patch(SRC)
        self.assertIn('DUAL5_ARB_EDGE_GATE_V2_20261028',updated)
        self.assertIn("estimate.conservativeNet<requiredEdge",updated)
        self.assertIn("ENTRY_WINDOW_MS=ROUND_MS-DEADLINE_BUFFER_MS",updated)
        self.assertIn('0.01*(config.amounts.UP+config.amounts.DOWN)',updated)
        self.assertEqual(m.patch(updated),updated)
    def test_unknown_baseline_refused(self):
        with self.assertRaises(ValueError):
            m.patch(SRC.replace('const MIN_EDGE=0.08;', 'const MIN_EDGE=0.07;'))
    def test_duplicate_anchor_refused(self):
        with self.assertRaises(ValueError):
            m.patch(SRC+SRC)

if __name__=='__main__':
    unittest.main()
