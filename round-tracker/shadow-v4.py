#!/usr/bin/env python3
import argparse, json, math, os, pickle, tempfile, time, warnings
warnings.filterwarnings("ignore")
import numpy as np
from river import forest
from sklearn.metrics import accuracy_score, brier_score_loss

ENGINE_VERSION="RIVER_ARF_PREQUENTIAL_V4"
MIN_OBSERVE_DELAY_MS=8000
MAX_OBSERVE_DELAY_MS=20000
PREDICTION_BOOK_MAX_AGE_MS=5000

FEATURE_NAMES=[
"regimeScore","currentScore","microScore","currentTrendScore",
"normalizedMomentum15s","normalizedMomentum30s","normalizedMomentum60s",
"normalizedMomentum180s","normalizedMomentum300s","tradePressure15s","tradePressure60s",
"ofiNormalized5s","ofiNormalized60s","rangePosition180","absorptionRisk",
"predictionMarketUpMidCentered","predictionMarketMissing","currentMidAgreement",
"trendMidAgreement","ofiPressureInteraction","momentumAgreement60x300",
"shortLongMomentumGap","pressureImbalance"
]

def emit(x): print("SHADOW_V4_RESULT="+json.dumps(x,separators=(",",":")),flush=True)
def finite(v):
    try:n=float(v)
    except:return None
    return n if math.isfinite(n) else None
def clip(v,lo=-3,hi=3): return max(lo,min(hi,float(v)))
def feature_row(f):
    if not isinstance(f,dict): return None
    req={}
    for k in ["regimeScore","currentScore","microScore","currentTrendScore","normalizedMomentum15s","normalizedMomentum30s","normalizedMomentum60s","normalizedMomentum180s","normalizedMomentum300s","tradePressure15s","tradePressure60s","ofiNormalized5s","rangePosition180"]:
        v=finite(f.get(k))
        if v is None:return None
        req[k]=clip(v)
    ofi60=finite(f.get("ofiNormalized60s")); ofi60=0 if ofi60 is None else clip(ofi60)
    up=finite(f.get("predictionMarketUpMid")); age=finite(f.get("predictionMarketBookAgeMs"))
    pm=bool(f.get("predictionMarketMappingReliable") is True and f.get("predictionMarketRoundAligned") is True and age is not None and 0<=age<=PREDICTION_BOOK_MAX_AGE_MS and up is not None)
    mid=clip((up-.5)*2) if pm else 0.0
    miss=0.0 if pm else 1.0
    absorption=1.0 if f.get("absorptionRisk") else 0.0
    current=req["currentScore"]; trend=req["currentTrendScore"]; m15=req["normalizedMomentum15s"]; m60=req["normalizedMomentum60s"]; m300=req["normalizedMomentum300s"]; p15=req["tradePressure15s"]; p60=req["tradePressure60s"]; ofi5=req["ofiNormalized5s"]
    return {**req,"ofiNormalized60s":ofi60,"absorptionRisk":absorption,"predictionMarketUpMidCentered":mid,"predictionMarketMissing":miss,"currentMidAgreement":clip(current*mid),"trendMidAgreement":clip(trend*mid),"ofiPressureInteraction":clip(ofi5*p60),"momentumAgreement60x300":clip(m60*m300),"shortLongMomentumGap":clip(m15-m300),"pressureImbalance":clip(p15-p60)}

def load_samples(path):
    with open(path,"r",encoding="utf-8") as f: rows=json.load(f)
    out=[]
    for r in rows if isinstance(rows,list) else []:
        rs=finite(r.get("roundStartMs")); oa=finite(r.get("shadowObservedAt"))
        if rs is None or oa is None or not(MIN_OBSERVE_DELAY_MS<=oa-rs<=MAX_OBSERVE_DELAY_MS): continue
        if r.get("actualSource")!="BINANCE_PREDICTION_OFFICIAL_RESOLUTION": continue
        if "STRICT_ROUND_ALIGNED_TOPIC" not in str(r.get("resolutionEvidence") or ""): continue
        y=r.get("actual")
        if y not in ("UP","DOWN"): continue
        x=feature_row(r.get("shadowFacts"))
        if x is None: continue
        out.append({"roundStartMs":int(rs),"x":x,"y":1 if y=="UP" else 0})
    out.sort(key=lambda z:z["roundStartMs"]); return out

CONFIGS=[
 {"name":"arf8_fast","n_models":8,"max_features":"sqrt","lambda_value":6,"grace_period":20,"delta":0.01,"seed":20261005},
 {"name":"arf12_balanced","n_models":12,"max_features":0.6,"lambda_value":6,"grace_period":30,"delta":0.005,"seed":20261017},
 {"name":"arf10_stable","n_models":10,"max_features":"sqrt","lambda_value":4,"grace_period":50,"delta":0.005,"seed":20261029},
]
def make_model(c):
    return forest.ARFClassifier(n_models=c["n_models"],max_features=c["max_features"],lambda_value=c["lambda_value"],grace_period=c["grace_period"],delta=c["delta"],leaf_prediction="nba",seed=c["seed"])

def prob(model,x):
    d=model.predict_proba_one(x) or {}
    return float(d.get(1,d.get(True,0.5))) if d else 0.5

def eval_stream(model, seq, learn=True):
    ys=[]; ps=[]; baseps=[]; up=0; n=0; streak=mx=0
    for s in seq:
        p=max(.001,min(.999,prob(model,s["x"])))
        bp=(up+2)/(n+4)
        ys.append(s["y"]); ps.append(p); baseps.append(bp)
        pred=1 if p>=.5 else 0
        if pred==s["y"]: streak=0
        else: streak+=1; mx=max(mx,streak)
        if learn:model.learn_one(s["x"],s["y"])
        up+=s["y"]; n+=1
    y=np.asarray(ys); p=np.asarray(ps); b=np.asarray(baseps)
    pred=(p>=.5).astype(int)
    return {"accuracy":float(accuracy_score(y,pred)),"brier":float(brier_score_loss(y,p)),"baselineAccuracy":float(accuracy_score(y,(b>=.5).astype(int))),"baselineBrier":float(brier_score_loss(y,b)),"hits":int(np.sum(pred==y)),"misses":int(np.sum(pred!=y)),"maxErrorStreak":int(mx),"samples":len(seq),"recent20Accuracy":float(np.mean(pred[-20:]==y[-20:])) if len(y) else None}

def train_cmd(a):
    s=load_samples(a.history)
    if len(s)<a.min_samples+120: emit({"ok":True,"status":"INSUFFICIENT_SAMPLES","samples":len(s),"engineVersion":ENGINE_VERSION}); return
    warm=s[:-120]; select=s[-120:-60]; outer=s[-60:]
    scored=[]
    for c in CONFIGS:
        m=make_model(c)
        for z in warm:m.learn_one(z["x"],z["y"])
        sel=eval_stream(m,select,learn=True)
        score=.75*sel["accuracy"]-.20*sel["brier"]-.05*min(1,sel["maxErrorStreak"]/6)
        scored.append((score,c,sel))
    scored.sort(key=lambda z:z[0],reverse=True)
    _,cfg,sel=scored[0]
    m=make_model(cfg)
    for z in warm:m.learn_one(z["x"],z["y"])
    eval_stream(m,select,learn=True)
    out=eval_stream(m,outer,learn=True)
    reasons=[]
    if out["accuracy"]<0.62: reasons.append("OUTER_ACCURACY_BELOW_62")
    if out["accuracy"]<out["baselineAccuracy"]+0.04: reasons.append("OUTER_NOT_ABOVE_BASELINE_4PP")
    if out["brier"]>out["baselineBrier"]: reasons.append("OUTER_BRIER_WORSE_THAN_BASELINE")
    if out["recent20Accuracy"]<0.60: reasons.append("OUTER_RECENT20_BELOW_60")
    common={"ok":True,"engineVersion":ENGINE_VERSION,"lastTrainRound":s[-1]["roundStartMs"],"selectedConfig":cfg,"selection":sel,"outerHoldout":out,"testedConfigs":[{"config":c,"selection":mtr} for _,c,mtr in scored]}
    if reasons: emit({**common,"status":"REJECTED_BEFORE_FORWARD","reasons":reasons}); return
    final=make_model(cfg)
    for z in s: final.learn_one(z["x"],z["y"])
    tv=int(time.time()*1000); ver=f"shadow-v4-arf-{tv}"; os.makedirs(a.out_dir,exist_ok=True); path=os.path.join(a.out_dir,ver+".pkl")
    with open(path,"wb") as f:pickle.dump(final,f,pickle.HIGHEST_PROTOCOL)
    emit({**common,"status":"CANDIDATE_REGISTERED","modelVersion":ver,"trainedAt":tv,"trainedSamples":len(s),"modelPath":path})

def predict_cmd():
    p=json.load(sys.stdin); x=feature_row(p.get("facts"))
    if x is None: emit({"ok":False,"status":"INVALID_FEATURES"}); return
    with open(p["modelPath"],"rb") as f:m=pickle.load(f)
    emit({"ok":True,"status":"PREDICTED","probability":round(max(.001,min(.999,prob(m,x))),6),"warnings":int(m.n_warnings_detected()),"drifts":int(m.n_drifts_detected())})

def learn_cmd():
    p=json.load(sys.stdin); x=feature_row(p.get("facts")); y=1 if p.get("actual")=="UP" else 0 if p.get("actual")=="DOWN" else None
    if x is None or y is None: emit({"ok":False,"status":"INVALID_LEARN_SAMPLE"}); return
    path=p["modelPath"]
    with open(path,"rb") as f:m=pickle.load(f)
    m.learn_one(x,y)
    fd,tmp=tempfile.mkstemp(prefix=".v4-",dir=os.path.dirname(path)); os.close(fd)
    with open(tmp,"wb") as f:pickle.dump(m,f,pickle.HIGHEST_PROTOCOL)
    os.replace(tmp,path)
    emit({"ok":True,"status":"LEARNED","warnings":int(m.n_warnings_detected()),"drifts":int(m.n_drifts_detected())})

def main():
    ap=argparse.ArgumentParser(); sp=ap.add_subparsers(dest="cmd",required=True)
    t=sp.add_parser("train"); t.add_argument("--history",required=True); t.add_argument("--out-dir",required=True); t.add_argument("--min-samples",type=int,default=300)
    sp.add_parser("predict"); sp.add_parser("learn")
    a=ap.parse_args()
    if a.cmd=="train":train_cmd(a)
    elif a.cmd=="predict":predict_cmd()
    else:learn_cmd()
if __name__=="__main__":main()
