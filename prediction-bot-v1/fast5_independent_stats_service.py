#!/usr/bin/env python3
"""FAST5-only round journal and Binance-official settlement association.
Read-only producer: accesses localhost GET endpoints, never trades.
SQLite is append/upsert on exact roundStartMs and survives process restarts.
"""
import os,json,sqlite3,threading,time,urllib.request,logging
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
from urllib.parse import urlparse
MODEL='FAST5_SPOT_MOMENTUM_V1'
VERSION='FAST5_REGIME_FLIP_GT5BPS_15M_V5'
ROUND_MS=300000
DB=os.environ.get('FAST5_STATS_DB','/var/lib/zl-prediction/fast5-stats/rounds.sqlite3')
PORT=int(os.environ.get('FAST5_STATS_PORT','13047'))
def ms():return int(time.time()*1000)
def get(url):
 with urllib.request.urlopen(url,timeout=5) as r:
  if r.status!=200:raise RuntimeError('HTTP_'+str(r.status))
  return json.loads(r.read(5000000))
def connect():
 db=sqlite3.connect(DB,timeout=4,check_same_thread=False)
 db.row_factory=sqlite3.Row
 db.execute('PRAGMA busy_timeout=4000')
 db.execute('PRAGMA journal_mode=WAL')
 db.execute("""CREATE TABLE IF NOT EXISTS rounds (
 round INTEGER PRIMARY KEY, model TEXT NOT NULL, version TEXT NOT NULL,
 decision TEXT NOT NULL CHECK (decision IN ('UP','DOWN','WAIT')),
 locked_at INTEGER, market_at INTEGER, source TEXT, prewarm_only INTEGER,
 decision_reason TEXT, first_seen_at INTEGER NOT NULL,
 official_result TEXT CHECK (official_result IN ('UP','DOWN') OR official_result IS NULL),
 settled_at INTEGER, official_topic TEXT, official_digest TEXT, matched_at INTEGER,
 CHECK ((decision='WAIT' AND locked_at IS NULL) OR
   (decision IN ('UP','DOWN') AND locked_at IS NOT NULL))
 )""")
 db.commit();return db
def isint(x):return type(x) is int
def official(r):
 if not isinstance(r,dict):return None
 rnd=r.get('roundStartMs');actual=r.get('productionActual')
 audit=r.get('officialSettlementAudit')
 if not(isint(rnd) and rnd>0 and rnd%ROUND_MS==0 and
  actual in ('UP','DOWN') and isint(r.get('settledAt')) and
  isinstance(audit,dict) and audit.get('sourceEndpoint')=='/sapi/v1/w3w/wallet/prediction/market/detail' and
  audit.get('topicStartDate')==rnd and
  isint(audit.get('topicEndDate')) and audit['topicEndDate']==rnd+ROUND_MS and
  isinstance(audit.get('detailPayloadSha256'),str) and
  len(audit['detailPayloadSha256'])==64):
  return None
 try:
  p1=float(audit['variantStartPrice']);p2=float(audit['variantEndPrice'])
 except (KeyError,TypeError,ValueError):return None
 if p1==p2 or (('UP' if p2>p1 else 'DOWN')!=actual):return None
 return (rnd,actual,r['settledAt'],str(audit.get('marketTopicId','')),
     audit['detailPayloadSha256'])
class Journal:
 def __init__(self,db):
  self.db=db;self.started_at=ms();self.lock=threading.RLock()
  self.seen_rounds=set();self.last_signal_error=None
  self.last_official_error=None;self.last_poll_at=None
 def snapshot(self):
  x=get('http://127.0.0.1:13046/api/status')
  now=ms();round_=now//ROUND_MS*ROUND_MS;elapsed=now-round_
  if x.get('ok') is not True or x.get('model')!=MODEL or x.get('strategyVersion')!=VERSION:
   raise RuntimeError('FAST5_MODEL_NOT_V4')
  if x.get('round')!=round_:
   # Between raw source round transitions; do not label WAIT.
   return
  if elapsed<5000:self.seen_rounds.add(round_)
  row=x.get('latest')
  if (isinstance(row,dict) and row.get('round')==round_ and row.get('model')==MODEL and
    row.get('strategyVersion')==VERSION and row.get('status')=='LOCKED' and
    row.get('direction') in ('UP','DOWN') and isint(row.get('lockedAt')) and
    round_+100<=row['lockedAt']<round_+5000):
   with self.lock:
    self.db.execute("""INSERT OR IGNORE INTO rounds
    (round,model,version,decision,locked_at,market_at,source,prewarm_only,decision_reason,first_seen_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)""",(round_,MODEL,VERSION,row['direction'],row['lockedAt'],
    row.get('marketAt') if isint(row.get('marketAt')) else None,
    row.get('source'),int(row.get('prewarmOnly') is True),
    row.get('signalReason'),now))
    self.db.commit()
   self.seen_rounds.discard(round_)
  elif elapsed>=5000 and round_ in self.seen_rounds:
   # Only mark WAIT when observed current round in its decision window and
   # FAST5 itself says unlocked. Never infer WAIT from old official rows.
   if x.get('locked') is False and row is None and x.get('latestError')=='OPEN_5S_DEADLINE_MISSED':
    with self.lock:
     self.db.execute("""INSERT OR IGNORE INTO rounds
      (round,model,version,decision,locked_at,first_seen_at,decision_reason)
      VALUES (?,?,?,?,?,?,?)""",
      (round_,MODEL,VERSION,'WAIT',None,now,'OPEN_5S_DEADLINE_MISSED'))
     self.db.commit()
    self.seen_rounds.discard(round_)
  self.seen_rounds={r for r in self.seen_rounds if r>=round_-ROUND_MS}
 def settle(self):
  result=get('http://127.0.0.1:13001/api/round-stats')
  if result.get('ok') is not True or not isinstance(result.get('records'),list):
   raise RuntimeError('OFFICIAL_RECORDS_UNAVAILABLE')
  matches=0
  with self.lock:
   for item in result['records']:
    v=official(item)
    if v is None:continue
    round_,actual,settled_at,topic,digest=v
    existing=self.db.execute('SELECT official_result,official_digest FROM rounds WHERE round=?',(round_,)).fetchone()
    if existing is None:continue
    if existing['official_result'] is not None and (
     existing['official_result']!=actual or existing['official_digest']!=digest):
     self.last_official_error='OFFICIAL_SETTLEMENT_CONFLICT_'+str(round_);continue
    self.db.execute("""UPDATE rounds SET official_result=?,settled_at=?,official_topic=?,
       official_digest=?,matched_at=? WHERE round=? AND official_result IS NULL""",
       (actual,settled_at,topic,digest,ms(),round_))
    matches+=1
   self.db.commit()
 def data(self):
  with self.lock:
   rows=self.db.execute("""SELECT round,version,decision,locked_at,market_at,source,
     prewarm_only,decision_reason,official_result,settled_at,official_topic
     FROM rounds ORDER BY round DESC LIMIT 200""").fetchall()
   sum_=self.db.execute("""SELECT COUNT(*) AS total,
     SUM(CASE WHEN decision IN ('UP','DOWN') THEN 1 ELSE 0 END) AS signals,
     SUM(CASE WHEN decision='WAIT' THEN 1 ELSE 0 END) AS waits,
     SUM(CASE WHEN decision IN ('UP','DOWN') AND official_result IS NOT NULL THEN 1 ELSE 0 END) AS settled,
     SUM(CASE WHEN decision IN ('UP','DOWN') AND official_result=decision THEN 1 ELSE 0 END) AS wins,
     SUM(CASE WHEN decision IN ('UP','DOWN') AND official_result IS NOT NULL AND official_result!=decision THEN 1 ELSE 0 END) AS losses,
     SUM(CASE WHEN decision IN ('UP','DOWN') AND official_result IS NULL THEN 1 ELSE 0 END) AS pending
     FROM rounds""").fetchone()
  a={k:int(sum_[k] or 0) for k in sum_.keys()}
  a['accuracyPct']=round(100*a['wins']/a['settled'],2) if a['settled'] else None
  a['coveragePct']=round(100*a['signals']/a['total'],2) if a['total'] else None
  return {'ok':True,'model':MODEL,'strategyVersion':VERSION,'schema':'FAST5_INDEPENDENT_OFFICIAL_ROUND_LEDGER_V1',
   'createdAt':self.started_at,'generatedAt':ms(),'persisted':True,
   'scope':'FORWARD_ONLY_FROM_VERIFIED_FAST5_SIGNALS',
   'officialSource':'BINANCE_PREDICTION_DETAIL_AUDIT','summary':a,
   'rows':[{k:r[k] for k in r.keys()} for r in rows],
   'health':{'lastPollAt':self.last_poll_at,
    'signalError':self.last_signal_error,'officialError':self.last_official_error}}
class Handler(BaseHTTPRequestHandler):
 journal=None
 def do_GET(self):
  if urlparse(self.path).path not in ('/api/round-stats','/healthz'):
   self.send_error(404);return
  try:
   out=self.journal.data() if urlparse(self.path).path=='/api/round-stats' else {'ok':True,'service':'fast5-independent-stats'}
   raw=json.dumps(out,separators=(',',':'),ensure_ascii=False).encode('utf8')
   self.send_response(200);self.send_header('Content-Type','application/json; charset=utf-8')
   self.send_header('Cache-Control','no-store');self.send_header('Content-Length',str(len(raw)))
   self.end_headers();self.wfile.write(raw)
  except Exception:
   self.send_error(503)
 def log_message(self,fmt,*args):pass
def main():
 os.makedirs(os.path.dirname(DB),exist_ok=True)
 journal=Journal(connect());Handler.journal=journal
 def loop():
  last_official=0
  while True:
   try:journal.snapshot();journal.last_signal_error=None
   except Exception as e:journal.last_signal_error=str(e)[:160]
   now=time.monotonic()
   if now-last_official>=12:
    try:journal.settle();journal.last_official_error=None
    except Exception as e:journal.last_official_error=str(e)[:160]
    last_official=now
   journal.last_poll_at=ms()
   time.sleep(.25)
 threading.Thread(target=loop,name='fast5-stats',daemon=True).start()
 server=ThreadingHTTPServer(('127.0.0.1',PORT),Handler)
 print('FAST5_STATS_LEDGER_RUNNING',PORT,DB,flush=True)
 server.serve_forever()
if __name__=='__main__':main()
