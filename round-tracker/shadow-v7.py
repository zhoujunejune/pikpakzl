#!/usr/bin/env python3
import argparse, json, math, os, pickle, tempfile, time, warnings
warnings.filterwarnings("ignore")

import numpy as np
from mapie.risk_control import BinaryClassificationController
from river import forest

ENGINE_VERSION="MAPIE_RIVER_ARF_SELECTIVE_V7"
MIN_OBSERVE_DELAY_MS=8000
MAX_OBSERVE_DELAY_MS=20000
PREDICTION_BOOK_MAX_AGE_MS=5000
CALIBRATION_ROWS=120
OUTER_ROWS=60
TARGET_PRECISION=0.65
MAX_ABSTENTION=0.75
CONFIDENCE_LEVEL=0.80
MIN_OUTER_COVERAGE=0.25
MIN_OUTER_DECISIONS=15

FEATURE_NAMES=[
"regimeScore","currentScore","microScore","currentTrendScore",
"normalizedMomentum15s","normalizedMomentum30s","normalizedMomentum60s",
"normalizedMomentum180s","normalizedMomentum300s","tradePressure15s","tradePressure60s",
"ofiNormalized5s","ofiNormalized60s","rangePosition180","absorptionRisk",
"predictionMarketUpMidCentered","predictionMarketMissing","currentMidAgreement",
"trendMidAgreement","ofiPressureInteraction","momentumAgreement60x300",
"shortLongMomentumGap","pressureImbalance"
]

CONFIGS=[
 {"name":"arf8_fast","n_models":8,"max_features":"sqrt","lambda_value":6,"grace_period":20,"delta":0.01,"seed":20261005},
 {"name":"arf12_balanced","n_models":12,"max_features":0.6,"lambda_value":6,"grace_period":30,"delta":0.005,"seed":20261017},
 {"name":"arf10_stable","n_models":10,"max_features":"sqrt","lambda_value":4,"grace_period":50,"delta":0.005,"seed":20261029},
]

def emit(x):
    print("SHADOW_V7_RESULT="+json.dumps(x,separators=(",",":"),ensure_ascii=False),flush=True)

def finite(v):
    try:n=float(v)
    except (TypeError,ValueError):return None
    return n if math.isfinite(n) else None

def clip(v,lo=-3.0,hi=3.0):
    return max(lo,min(hi,float(v)))

def feature_row(f):
    if not isinstance(f,dict): return None
    req={}
    for k in [
      "regimeScore","currentScore","microScore","currentTrendScore",
      "normalizedMomentum15s","normalizedMomentum30s","normalizedMomentum60s",
      "normalizedMomentum180s","normalizedMomentum300s",
      "tradePressure15s","tradePressure60s","ofiNormalized5s","rangePosition180"
    ]:
        v=finite(f.get(k))
        if v is None:return None
        req[k]=clip(v)
    ofi60=finite(f.get("ofiNormalized60s"))
    ofi60=0.0 if ofi60 is None else clip(ofi60)
    up=finite(f.get("predictionMarketUpMid"))
    age=finite(f.get("predictionMarketBookAgeMs"))
    pm=bool(
      f.get("predictionMarketMappingReliable") is True and
      f.get("predictionMarketRoundAligned") is True and
      age is not None and 0<=age<=PREDICTION_BOOK_MAX_AGE_MS and
      up is not None
    )
    mid=clip((up-.5)*2) if pm else 0.0
    missing=0.0 if pm else 1.0
    absorption=1.0 if f.get("absorptionRisk") else 0.0
    current=req["currentScore"];trend=req["currentTrendScore"]
    m15=req["normalizedMomentum15s"];m60=req["normalizedMomentum60s"];m300=req["normalizedMomentum300s"]
    p15=req["tradePressure15s"];p60=req["tradePressure60s"];ofi5=req["ofiNormalized5s"]
    return {
      **req,
      "ofiNormalized60s":ofi60,
      "absorptionRisk":absorption,
      "predictionMarketUpMidCentered":mid,
      "predictionMarketMissing":missing,
      "currentMidAgreement":clip(current*mid),
      "trendMidAgreement":clip(trend*mid),
      "ofiPressureInteraction":clip(ofi5*p60),
      "momentumAgreement60x300":clip(m60*m300),
      "shortLongMomentumGap":clip(m15-m300),
      "pressureImbalance":clip(p15-p60),
    }

def load_samples(path):
    with open(path,"r",encoding="utf-8") as f:rows=json.load(f)
    out=[]
    for r in rows if isinstance(rows,list) else []:
        rs=finite(r.get("roundStartMs"));oa=finite(r.get("shadowObservedAt"))
        if rs is None or oa is None:continue
        delay=oa-rs
        if delay<MIN_OBSERVE_DELAY_MS or delay>MAX_OBSERVE_DELAY_MS:continue
        if r.get("actualSource")!="BINANCE_PREDICTION_OFFICIAL_RESOLUTION":continue
        if "STRICT_ROUND_ALIGNED_TOPIC" not in str(r.get("resolutionEvidence") or ""):continue
        actual=r.get("actual")
        if actual not in ("UP","DOWN"):continue
        x=feature_row(r.get("shadowFacts"))
        if x is None:continue
        out.append({"roundStartMs":int(rs),"x":x,"y":1 if actual=="UP" else 0})
    out.sort(key=lambda z:z["roundStartMs"])
    return out

def make_model(c):
    return forest.ARFClassifier(
      n_models=c["n_models"],max_features=c["max_features"],
      lambda_value=c["lambda_value"],grace_period=c["grace_period"],
      delta=c["delta"],leaf_prediction="nba",seed=c["seed"]
    )

def prob(model,x):
    d=model.predict_proba_one(x) or {}
    return float(d.get(1,d.get(True,0.5))) if d else 0.5

def stream_probs(model,seq,learn=True):
    ps=[]
    for s in seq:
        p=max(.001,min(.999,prob(model,s["x"])))
        ps.append(p)
        if learn:model.learn_one(s["x"],s["y"])
    return np.asarray(ps,dtype=float)

def threshold_grid():
    lows=np.asarray([0.25,0.32,0.38,0.43,0.47],dtype=float)
    highs=np.asarray([0.53,0.57,0.62,0.68,0.75],dtype=float)
    return np.asarray([(l,h) for l in lows for h in highs if l<h],dtype=float)

def select_thresholds(calib_probs,y_calib):
    probs=np.asarray(calib_probs,dtype=float)
    y=np.asarray(y_calib,dtype=int)
    X=np.arange(len(probs),dtype=int)
    def selective_predict(indices,lower,upper):
        idx=np.asarray(indices,dtype=int)
        p=probs[idx]
        pred=np.full(p.shape,np.nan,dtype=float)
        pred=np.where(p<=float(lower),0,pred)
        pred=np.where(p>=float(upper),1,pred)
        return pred
    ctl=BinaryClassificationController(
      predict_function=selective_predict,
      risk=["negative_predictive_value","positive_predictive_value","abstention_rate"],
      target_level=[TARGET_PRECISION,TARGET_PRECISION,MAX_ABSTENTION],
      confidence_level=CONFIDENCE_LEVEL,
      best_predict_param_choice="abstention_rate",
      list_predict_params=threshold_grid(),
    )
    ctl.calibrate(X,y)
    if ctl.best_predict_param is None:
        return None
    lower,upper=ctl.best_predict_param
    return {
      "lower":float(lower),"upper":float(upper),
      "validParams":int(len(ctl.valid_predict_params)),
      "confidenceLevel":CONFIDENCE_LEVEL,
      "targetPrecision":TARGET_PRECISION,
      "maxAbstention":MAX_ABSTENTION,
    }

def decisions_from_probs(p,lower,upper):
    p=np.asarray(p,dtype=float)
    pred=np.full(p.shape,np.nan,dtype=float)
    pred=np.where(p<=lower,0,pred)
    pred=np.where(p>=upper,1,pred)
    return pred

def selective_metrics(y,p,lower,upper):
    y=np.asarray(y,dtype=int);p=np.asarray(p,dtype=float)
    pred=decisions_from_probs(p,lower,upper)
    decided=~np.isnan(pred)
    n=int(len(y));d=int(np.sum(decided))
    if d:
        yp=pred[decided].astype(int);yt=y[decided]
        hits=int(np.sum(yp==yt));acc=float(hits/d)
        upmask=yp==1;downmask=yp==0
        upn=int(np.sum(upmask));downn=int(np.sum(downmask))
        upp=float(np.mean(yt[upmask]==1)) if upn else None
        downp=float(np.mean(yt[downmask]==0)) if downn else None
        streak=mx=0
        for ok in (yp==yt):
            if ok:streak=0
            else:streak+=1;mx=max(mx,streak)
        recent=min(20,d)
        recent_acc=float(np.mean(yp[-recent:]==yt[-recent:])) if recent else None
    else:
        hits=0;acc=None;upn=downn=0;upp=downp=None;mx=0;recent_acc=None
    return {
      "rounds":n,"decisions":d,"waits":n-d,"coverage":float(d/n) if n else 0.0,
      "hits":hits,"misses":d-hits,"accuracy":acc,
      "upDecisions":upn,"downDecisions":downn,
      "upPrecision":upp,"downPrecision":downp,
      "maxErrorStreak":int(mx),"recent20DecisionAccuracy":recent_acc,
    }

def train_cmd(a):
    samples=load_samples(a.history)
    need=a.min_samples+CALIBRATION_ROWS+OUTER_ROWS
    if len(samples)<need:
        emit({"ok":True,"status":"INSUFFICIENT_SAMPLES","samples":len(samples),"required":need,"engineVersion":ENGINE_VERSION})
        return
    warm=samples[:-(CALIBRATION_ROWS+OUTER_ROWS)]
    calib=samples[-(CALIBRATION_ROWS+OUTER_ROWS):-OUTER_ROWS]
    outer=samples[-OUTER_ROWS:]
    results=[]
    for cfg in CONFIGS:
        try:
            model=make_model(cfg)
            for z in warm:model.learn_one(z["x"],z["y"])
            cp=stream_probs(model,calib,learn=True)
            thresholds=select_thresholds(cp,[z["y"] for z in calib])
            if not thresholds:
                results.append({"config":cfg,"status":"NO_VALID_RISK_THRESHOLDS"})
                continue
            cm=selective_metrics([z["y"] for z in calib],cp,thresholds["lower"],thresholds["upper"])
            op=stream_probs(model,outer,learn=True)
            om=selective_metrics([z["y"] for z in outer],op,thresholds["lower"],thresholds["upper"])
            reasons=[]
            if om["decisions"]<MIN_OUTER_DECISIONS:reasons.append("OUTER_TOO_FEW_DECISIONS")
            if om["coverage"]<MIN_OUTER_COVERAGE:reasons.append("OUTER_COVERAGE_BELOW_25")
            if om["accuracy"] is None or om["accuracy"]<TARGET_PRECISION:reasons.append("OUTER_SELECTIVE_ACCURACY_BELOW_65")
            if om["upDecisions"]<3:reasons.append("OUTER_TOO_FEW_UP_DECISIONS")
            if om["downDecisions"]<3:reasons.append("OUTER_TOO_FEW_DOWN_DECISIONS")
            score=(om["accuracy"] or 0)*0.75+om["coverage"]*0.25
            results.append({
              "config":cfg,"status":"PASS" if not reasons else "REJECT",
              "thresholds":thresholds,"calibration":cm,"outerHoldout":om,
              "reasons":reasons,"score":score,"model":model
            })
        except Exception as exc:
            results.append({"config":cfg,"status":"ERROR","error":str(exc)})
    passed=[r for r in results if r.get("status")=="PASS"]
    public=[{k:v for k,v in r.items() if k!="model"} for r in results]
    if not passed:
        emit({"ok":True,"status":"REJECTED_BEFORE_FORWARD","engineVersion":ENGINE_VERSION,"lastTrainRound":samples[-1]["roundStartMs"],"tested":public})
        return
    passed.sort(key=lambda r:r["score"],reverse=True)
    best=passed[0]
    tv=int(time.time()*1000);ver=f"shadow-v7-mapie-arf-{tv}"
    os.makedirs(a.out_dir,exist_ok=True);path=os.path.join(a.out_dir,ver+".pkl")
    artifact={
      "model":best["model"],"lower":best["thresholds"]["lower"],"upper":best["thresholds"]["upper"],
      "config":best["config"],"engineVersion":ENGINE_VERSION
    }
    with open(path,"wb") as f:pickle.dump(artifact,f,pickle.HIGHEST_PROTOCOL)
    emit({
      "ok":True,"status":"CANDIDATE_REGISTERED","engineVersion":ENGINE_VERSION,
      "modelVersion":ver,"trainedAt":tv,"lastTrainRound":samples[-1]["roundStartMs"],
      "trainedSamples":len(samples),"modelPath":path,
      "selectedConfig":best["config"],"thresholds":best["thresholds"],
      "calibration":best["calibration"],"outerHoldout":best["outerHoldout"],
      "tested":public,
      "library":"MAPIE.BinaryClassificationController+river.ARFClassifier",
    })

def predict_cmd():
    payload=json.load(sys.stdin)
    x=feature_row(payload.get("facts"));path=payload.get("modelPath")
    if x is None or not path:
        emit({"ok":False,"status":"INVALID_FEATURES"});return
    with open(path,"rb") as f:a=pickle.load(f)
    p=max(.001,min(.999,prob(a["model"],x)))
    lower=float(a["lower"]);upper=float(a["upper"])
    direction="DOWN" if p<=lower else "UP" if p>=upper else "WAIT"
    emit({
      "ok":True,"status":"PREDICTED","probability":round(p,6),"direction":direction,
      "lowerThreshold":lower,"upperThreshold":upper,
      "warnings":int(a["model"].n_warnings_detected()),"drifts":int(a["model"].n_drifts_detected())
    })

def learn_cmd():
    payload=json.load(sys.stdin)
    x=feature_row(payload.get("facts"));actual=payload.get("actual");path=payload.get("modelPath")
    y=1 if actual=="UP" else 0 if actual=="DOWN" else None
    if x is None or y is None or not path:
        emit({"ok":False,"status":"INVALID_LEARN_SAMPLE"});return
    with open(path,"rb") as f:a=pickle.load(f)
    a["model"].learn_one(x,y)
    fd,tmp=tempfile.mkstemp(prefix=".v7-",dir=os.path.dirname(path));os.close(fd)
    with open(tmp,"wb") as f:pickle.dump(a,f,pickle.HIGHEST_PROTOCOL)
    os.replace(tmp,path)
    emit({"ok":True,"status":"LEARNED","warnings":int(a["model"].n_warnings_detected()),"drifts":int(a["model"].n_drifts_detected())})

def main():
    ap=argparse.ArgumentParser();sp=ap.add_subparsers(dest="cmd",required=True)
    t=sp.add_parser("train");t.add_argument("--history",required=True);t.add_argument("--out-dir",required=True);t.add_argument("--min-samples",type=int,default=300)
    sp.add_parser("predict");sp.add_parser("learn")
    a=ap.parse_args()
    if a.cmd=="train":train_cmd(a)
    elif a.cmd=="predict":predict_cmd()
    else:learn_cmd()

if __name__=="__main__":main()
