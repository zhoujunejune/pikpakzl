import unittest,sqlite3,tempfile,os
from unittest.mock import patch
import fast5_independent_stats_service as m
R=1792980600000
def signal(now, locked=False, direction='UP'):
 v={'ok':True,'model':m.MODEL,'strategyVersion':m.VERSION,'round':R,
   'locked':locked,'latestError':'OPEN_5S_DEADLINE_MISSED' if not locked and now-R>=5000 else None,
   'latest':None}
 if locked:
  v['latest']={'model':m.MODEL,'strategyVersion':m.VERSION,'round':R,
    'status':'LOCKED','direction':direction,'lockedAt':R+2500,
    'marketAt':R+2300,'source':'BINANCE_SPOT_WEBSOCKET_V3_COLLECTOR',
    'prewarmOnly':False,'signalReason':'CURRENT_OPEN_PRICE_DELTA'}
 return v
def official(round_=R,direction='UP'):
 return {'roundStartMs':round_,'productionPrediction':'DOWN',
   'productionModel':'SELECTIVE_V2_30S_CURRENT_ROUND_V2',
   'productionActual':direction,'settledAt':round_+300500,
   'officialSettlementAudit':{'sourceEndpoint':'/sapi/v1/w3w/wallet/prediction/market/detail',
    'topicStartDate':round_,'topicEndDate':round_+300000,
    'detailPayloadSha256':'a'*64,
    'variantStartPrice':'80000','variantEndPrice':'80002' if direction=='UP' else '79999',
    'marketTopicId':'123'}}
class Stats(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory()
  self.addCleanup(self.tmp.cleanup)
  m.DB=os.path.join(self.tmp.name,'rounds.sqlite3')
  self.j=m.Journal(m.connect())
  self.addCleanup(self.j.db.close)
 def test_signal_to_official_different_old_model_is_matched_by_round(self):
  with patch.object(m,'ms',return_value=R+3000),patch.object(m,'get',return_value=signal(R+3000,True)):
   self.j.snapshot()
  self.assertEqual(self.j.data()['summary']['signals'],1)
  with patch.object(m,'get',return_value={'ok':True,'records':[official()]}):
   self.j.settle()
  a=self.j.data()['summary']
  self.assertEqual((a['wins'],a['losses'],a['settled']),(1,0,1))
  self.assertEqual(a['accuracyPct'],100)
  # A second snapshot cannot double count the same round.
  with patch.object(m,'ms',return_value=R+4900),patch.object(m,'get',return_value=signal(R+4900,True)):
   self.j.snapshot()
  self.assertEqual(self.j.data()['summary']['signals'],1)
 def test_no_past_official_model_inference(self):
  with patch.object(m,'get',return_value={'ok':True,'records':[official()]}):
   self.j.settle()
  self.assertEqual(self.j.data()['summary']['total'],0)
 def test_wait_is_recorded_once_after_5_seconds_and_not_in_winrate(self):
  with patch.object(m,'ms',return_value=R+500),patch.object(m,'get',return_value=signal(R+500)):
   self.j.snapshot()
  with patch.object(m,'ms',return_value=R+5200),patch.object(m,'get',return_value=signal(R+5200)):
   self.j.snapshot()
  a=self.j.data()['summary']
  self.assertEqual((a['total'],a['waits'],a['signals']),(1,1,0))
  with patch.object(m,'get',return_value={'ok':True,'records':[official()]}):
   self.j.settle()
  a=self.j.data()['summary']
  self.assertEqual(a['settled'],0)
 def test_v6_filtered_large_regime_wait_is_saved_once_and_excluded_from_winrate(self):
  with patch.object(m,'ms',return_value=R+300):
   with patch.object(m,'get',return_value=signal(R+300)):
    self.j.snapshot()
  blocked=signal(R+5300)
  blocked['latestError']='REGIME_GT5_BPS_WAIT'
  with patch.object(m,'ms',return_value=R+5300):
   with patch.object(m,'get',return_value=blocked):
    self.j.snapshot();self.j.snapshot()
  result=self.j.data()
  self.assertEqual(result['summary']['waits'],1)
  self.assertEqual(result['summary']['signals'],0)
  self.assertEqual(result['summary']['settled'],0)
  self.assertEqual(result['rows'][0]['decision_reason'],'REGIME_GT5_BPS_WAIT')
 def test_unobserved_round_not_falsely_labeled_wait(self):
  with patch.object(m,'ms',return_value=R+160000),patch.object(m,'get',return_value=signal(R+160000)):
   self.j.snapshot()
  self.assertEqual(self.j.data()['summary']['total'],0)
 def test_reject_wrong_timestamp_or_unverified_outcome(self):
  v=official();v['officialSettlementAudit']['topicStartDate']=R+300000
  self.assertIsNone(m.official(v))
  v=official();v['officialSettlementAudit']['variantEndPrice']='79990'
  self.assertIsNone(m.official(v))
 def test_restart_retains_exact_round_records(self):
  with patch.object(m,'ms',return_value=R+3000),patch.object(m,'get',return_value=signal(R+3000,True)):
   self.j.snapshot()
  db=m.connect()
  self.assertEqual(db.execute('SELECT COUNT(*) FROM rounds').fetchone()[0],1)
  db.close()
if __name__=='__main__':unittest.main()
