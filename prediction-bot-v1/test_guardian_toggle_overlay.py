import pathlib,subprocess,sys,unittest
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parent))
from guardian_toggle_overlay import overlay,FILES
ROOT=pathlib.Path(__file__).resolve().parents[1]
BASE='16350d9faa9046224702f82a5c8f34f6cc1d9f68'
def baseline(p):
    return subprocess.check_output(['git','show',BASE+':railway-diagnostic/'+p],
      cwd=ROOT).decode('utf8')
class OverlayTests(unittest.TestCase):
    def test_overlay_preserves_unrelated_live_changes(self):
        for p in FILES:
            old=baseline(p)
            new=(ROOT/'railway-diagnostic'/p).read_text()
            live=old+'\n// ALIBABA_LIVE_ONLY_NO_REPLACE\n'
            if p=='risk-runner.mjs':
                live=live.replace("const GUARDIAN_DYNAMIC_EXIT_ENABLED=/^(1|true)$/i.test(String(process.env.GUARDIAN_DYNAMIC_EXIT_ENABLED||'false'));\n",'')
                live=live.replace(" || GUARDIAN_DYNAMIC_EXIT_ENABLED","")
                live=live.replace("    guardianDynamicExitEnabled: GUARDIAN_DYNAMIC_EXIT_ENABLED,\n","")
                live=live.replace("    guardianDynamicExitEnabled:GUARDIAN_DYNAMIC_EXIT_ENABLED,\n","")
                live=live.replace("import fs from 'node:fs';",
                  "import fs from 'node:fs';\n// live risk-sandbox optimization")
            if p=='control-shell.mjs':
                live=live.replace("function pinOK(pin) {","function pinOK(pin, req) {\n  // live authentication guard")
                live=live.replace("const CONTROL_PIN_SHA256 =", "// live additional status hook\nconst CONTROL_PIN_SHA256 =")
            if p=='risk-config-storage.mjs':
                live=live.replace("export const RISK_CONFIG_FILE = '/tmp/risk-control.json';",
                 "export const RISK_CONFIG_FILE = process.env.RISK_CONTROL_FILE || '/tmp/risk-control.json';")
            patched=overlay(old,new,live,p)
            self.assertIn('// ALIBABA_LIVE_ONLY_NO_REPLACE',patched,p)
            self.assertIn('guardianDynamicEnabled',patched,p)
            if p=='risk-runner.mjs':
                self.assertIn('GUARDIAN_ENV_ENABLED',patched)
                self.assertIn('live risk-sandbox optimization',patched)
            if p=='control-shell.mjs':
                self.assertIn('live authentication guard',patched)
                self.assertIn('/api/guardian-dynamic-risk',patched)
    def test_unrecognized_anchor_aborts_without_a_partial_file(self):
        p='risk-config-storage.mjs'
        old=baseline(p)
        new=(ROOT/'railway-diagnostic'/p).read_text()
        tampered=old.replace("stopLossPercent: sl,","stopLossPercent: somethingElse,")
        with self.assertRaises(ValueError):
            overlay(old,new,tampered,p)
if __name__=='__main__':unittest.main()
