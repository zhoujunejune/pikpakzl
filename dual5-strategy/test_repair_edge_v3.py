#!/usr/bin/env python3
import importlib.util,shutil,subprocess,unittest
from pathlib import Path

spec=importlib.util.spec_from_file_location("repair",Path(__file__).with_name("repair_edge_v3.py"))
repair=importlib.util.module_from_spec(spec)
spec.loader.exec_module(repair)

BROKEN=r"""const MIN_EDGE=0.02;
const conservativeNet=shares-upAmount-downAmount-f1-f2-0.025;
async function attemptPair(round,topic,pair,q1,q2,analysis,wallet){
  if(!config.armed||config.blocked||config.lastOrderRound===round)return;
  const up=await place(wallet,topic,q1,fundingSource);
}
async function tick(){
   if(!estimate.ok){state.health='INVALID_PAIR_QUOTES';return}
     // DUAL5_ARB_EDGE_GATE_V2_20261028: never buy two sides without sufficient conservative paired edge.\n   const requiredEdge=Math.max(MIN_EDGE,0.01*(config.amounts.UP+config.amounts.DOWN));\n   state.lastOpportunity.requiredNetEdgeUSDT=Number(requiredEdge.toFixed(4));\n   state.lastOpportunity.strategyMode='ARBITRAGE';\n   state.lastOpportunity.status=(estimate.feasible&&estimate.conservativeNet>=requiredEdge)?'POSITIVE_EDGE':'EDGE_BELOW_REQUIRED';\n   if(!config.armed){state.health='OPPORTUNITY_OBSERVED_TRADING_OFF';return}\n   if(!estimate.feasible||estimate.conservativeNet<requiredEdge){state.health='ARBITRAGE_EDGE_TOO_LOW_NO_ORDER';return;}
   state.health='LIVE_PAIR_SUBMISSION';await attemptPair(round,topic,pair,q1,q2,estimate,wallet);
}
"""

class SafetyRepairTests(unittest.TestCase):
 def test_repairs_to_real_lines(self):
  src=repair.repair(BROKEN)
  self.assertEqual(repair.repair(src),src)
  self.assertNotIn(r"\n   const requiredEdge",src)
  self.assertIn("\n   const requiredEdge",src)
  self.assertIn("const minimumEdgeAtSubmit=",src)
  self.assertIn("ARBITRAGE_EDGE_TOO_LOW_NO_ORDER",src)
  self.assertLess(src.index("minimumEdgeAtSubmit"),src.index("const up=await place"))
  if shutil.which("node"):
   x=subprocess.run(["node","--check","--input-type=module"],input=src,text=True,capture_output=True)
   self.assertEqual(x.returncode,0,x.stderr)
 def test_negative_edge_will_not_allow_buy(self):
  src=repair.repair(BROKEN)
  start=src.index("   const requiredEdge=")
  stop=src.index("   if(!estimate.feasible||estimate.conservativeNet<requiredEdge){",start)
  stop=src.index("\n",stop)
  snippet=src[start:stop]
  # Execute exact live conditional block; do not rely only on a regex or JS syntax check.
  if shutil.which("node"):
   runner = """const MIN_EDGE=0.02;
   function simulate(net,feasible,armed=true){
     const config={amounts:{UP:1,DOWN:1},armed};
     const state={lastOpportunity:{},health:''};
     const estimate={ok:true,conservativeNet:net,feasible};
     """+snippet+"""
     return 'ALLOW';
   }
   for(const [net,feasible,expect] of [[-0.3465,false,undefined],[0.019,false,undefined],[0.02,true,'ALLOW'],[0.04,true,'ALLOW']]){
    if(simulate(net,feasible)!==expect)process.exit(4)
   }
   """
   x=subprocess.run(["node","--input-type=module","-e",runner],text=True,capture_output=True)
   self.assertEqual(x.returncode,0,x.stderr)
 def test_other_baselines_refused(self):
  with self.assertRaises(ValueError):
   repair.repair(BROKEN.replace(r"\n   const requiredEdge","\n   const requiredEdge"))
  with self.assertRaises(ValueError):
   repair.repair(BROKEN.replace("const conservativeNet=shares-upAmount-downAmount-f1-f2-0.025;",""))
  with self.assertRaises(ValueError):
   repair.repair(BROKEN.replace("if(!config.armed||config.blocked||config.lastOrderRound===round)return;",""))

if __name__=="__main__":
 unittest.main()
