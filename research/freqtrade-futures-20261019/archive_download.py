#!/usr/bin/env python3
"""Download publisher-hosted Binance USD-M futures OHLCV ZIP files. No API access."""
from concurrent.futures import ThreadPoolExecutor,as_completed
from datetime import date,timedelta,datetime,timezone
import csv,io,json,pathlib,urllib.request,urllib.error,zipfile,sys
ROOT=pathlib.Path(__file__).resolve().parent
OUT=ROOT/"user_data"/"archive"
OUT.mkdir(parents=True,exist_ok=True)
SYMBOLS=("BTCUSDT","ETHUSDT","BTCUSDC")
BASE="https://data.binance.vision/data/futures/um/"
START=date(2026,8,1)
END=date(2026,10,16) # exclusive

def archives(symbol):
  yield symbol,"monthly","2026-08",f"{BASE}monthly/klines/{symbol}/5m/{symbol}-5m-2026-08.zip"
  yield symbol,"monthly","2026-09",f"{BASE}monthly/klines/{symbol}/5m/{symbol}-5m-2026-09.zip"
  d=date(2026,10,1)
  while d<END:
    s=d.isoformat()
    yield symbol,"daily",s,f"{BASE}daily/klines/{symbol}/5m/{symbol}-5m-{s}.zip"
    d+=timedelta(days=1)

def get(job):
 symbol,period,key,url=job
 req=urllib.request.Request(url,headers={"User-Agent":"ZL-Research-Public-Archives/1.0"})
 try:
  with urllib.request.urlopen(req,timeout=35) as resp:data=resp.read(8_000_000)
  with zipfile.ZipFile(io.BytesIO(data)) as z:
    files=[name for name in z.namelist() if name.endswith(".csv")]
    if len(files)!=1:raise ValueError("archive csv count != 1")
    rows=[]
    for row in csv.reader(io.TextIOWrapper(z.open(files[0]),encoding="utf-8-sig")):
      if len(row)<6:continue
      try:
        ts=int(row[0])
        if ts>10**14:ts//=1000 # normalize microseconds to milliseconds
        values=[float(v) for v in row[1:6]]
        if any(not (v==v and abs(v)<1e15) for v in values):continue
        rows.append([ts,*values])
      except ValueError:continue # optional CSV header
    if not rows:raise ValueError("No valid OHLCV records")
    return (symbol,period,key,rows,None)
 except Exception as err:
  return (symbol,period,key,[],type(err).__name__)

def main():
 jobs=[job for symbol in SYMBOLS for job in archives(symbol)]
 found={}
 with ThreadPoolExecutor(max_workers=8) as pool:
  for res in as_completed([pool.submit(get,job) for job in jobs]):
   sym,kind,key,rows,error=res.result()
   found.setdefault(sym,{})[key]={"rows":rows,"error":error}
   print("PUBLIC_ARCHIVE",sym,key,"bars",len(rows),"error_class",error or "none",flush=True)
 result={}
 for sym in SYMBOLS:
  group=found.get(sym,{})
  missing=[key for _,_,key,_ in archives(sym) if not group.get(key,{}).get("rows")]
  merged={}
  for p in group.values():
   for r in p["rows"]:merged[r[0]]=r
  bars=[merged[k] for k in sorted(merged) if int(START.strftime("%s"))*1000 <= k < int(END.strftime("%s"))*1000]
  # Accurate UTC comparison even on non-UTC runner.
  start_ms=int(datetime(2026,8,1,tzinfo=timezone.utc).timestamp()*1000)
  end_ms=int(datetime(2026,10,16,tzinfo=timezone.utc).timestamp()*1000)
  bars=[r for r in bars if start_ms<=r[0]<end_ms]
  path=OUT/f"{sym}_5m.json"
  path.write_text(json.dumps(bars,separators=(",",":")))
  expected=int((end_ms-start_ms)//300000)
  coverage=round(len(bars)/expected,5)
  result[sym]={"bars":len(bars),"expected":expected,"coverage":coverage,
               "missing_files":missing,"source":"data.binance.vision Binance USD-M futures kline ZIP",
               "source_verified":True}
  print("ARCHIVE_COVERAGE",sym,coverage,"MISSING_FILES",len(missing),flush=True)
 (ROOT/"results"/"archive_coverage.json").write_text(json.dumps(result,indent=2)+"\n")
 print("ARCHIVE_ALL_SYMBOLS_DATA_AVAILABLE",all(x["coverage"]>.99 and not x["missing_files"] for x in result.values()))

if __name__=="__main__":main()
