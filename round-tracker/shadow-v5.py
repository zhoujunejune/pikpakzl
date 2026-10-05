#!/usr/bin/env python3
import argparse, json, math, os, pickle, sys, time, warnings
warnings.filterwarnings("ignore")
import numpy as np
from aeon.transformations.collection.convolution_based import MiniRocket
from sklearn.linear_model import LogisticRegression
from sklearn.preprocessing import StandardScaler
from sklearn.metrics import accuracy_score, brier_score_loss

ENGINE_VERSION="AEON_MINIROCKET_SEQUENCE_V5"
MIN_OBSERVE_DELAY_MS=8000
MAX_OBSERVE_DELAY_MS=20000
PREDICTION_BOOK_MAX_AGE_MS=5000
CONTEXTS=(12,24,36)
N_KERNELS=2048

FEATURE_NAMES=[
"regimeScore","currentScore","microScore","currentTrendScore",
"normalizedMomentum15s","normalizedMomentum30s","normalizedMomentum60s",
"normalizedMomentum180s","normalizedMomentum300s","tradePressure15s","tradePressure60s",
"ofiNormalized5s","ofiNormalized60s","rangePosition180","absorptionRisk",
"predictionMarketUpMidCentered","predictionMarketMissing","currentMidAgreement",
"trendMidAgreement","ofiPressureInteraction","momentumAgreement60x300",
"shortLongMomentumGap","pressureImbalance"
]

def emit(x): print("SHADOW_V5_RESULT="+json.dumps(x,separators=(",",":")),flush=True)
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

def load_rows(path, require_label=False):
    with open(path,"r",encoding="utf-8") as f: rows=json.load(f)
    out=[]
    for r in rows if isinstance(rows,list) else []:
        rs=finite(r.get("roundStartMs")); oa=finite(r.get("shadowObservedAt"))
        if rs is None or oa is None or not(MIN_OBSERVE_DELAY_MS<=oa-rs<=MAX_OBSERVE_DELAY_MS): continue
        x=feature_row(r.get("shadowFacts"))
        if x is None: continue
        y=None
        strict_label=(
            r.get("actualSource")=="BINANCE_PREDICTION_OFFICIAL_RESOLUTION"
            and "STRICT_ROUND_ALIGNED_TOPIC" in str(r.get("resolutionEvidence") or "")
            and r.get("actual") in ("UP","DOWN")
        )
        if strict_label:
            y=1 if r.get("actual")=="UP" else 0
        if require_label and y is None:
            continue
        out.append({"roundStartMs":int(rs),"x":x,"y":y})
    out.sort(key=lambda z:z["roundStartMs"]); return out

def contiguous(seq):
    return all(seq[i]["roundStartMs"]-seq[i-1]["roundStartMs"]==300000 for i in range(1,len(seq)))

def build_examples(rows,context):
    X=[]; y=[]; rounds=[]
    for i in range(context-1,len(rows)):
        seq=rows[i-context+1:i+1]
        if not contiguous(seq): continue
        if rows[i].get("y") is None: continue
        arr=np.asarray([[step["x"][f] for step in seq] for f in FEATURE_NAMES],dtype=np.float32)
        X.append(arr); y.append(rows[i]["y"]); rounds.append(rows[i]["roundStartMs"])
    if not X:return np.empty((0,len(FEATURE_NAMES),context),dtype=np.float32),np.asarray([],dtype=int),[]
    return np.stack(X),np.asarray(y,dtype=int),rounds

def recent_sequence(rows,context,round_ms):
    eligible=[r for r in rows if r["roundStartMs"]<=round_ms]
    if len(eligible)<context:return None
    seq=eligible[-context:]
    if seq[-1]["roundStartMs"]!=round_ms or not contiguous(seq):return None
    return np.asarray([[step["x"][f] for step in seq] for f in FEATURE_NAMES],dtype=np.float32)[None,:,:]

def metrics(y,p,t):
    pred=(p>=t).astype(int); streak=mx=0
    for ok in pred==y:
        if ok:streak=0
        else:streak+=1;mx=max(mx,streak)
    return {"accuracy":float(accuracy_score(y,pred)),"brier":float(brier_score_loss(y,p)),"hits":int(np.sum(pred==y)),"misses":int(np.sum(pred!=y)),"maxErrorStreak":int(mx),"recent20Accuracy":float(np.mean(pred[-20:]==y[-20:])) if len(y) else None,"samples":int(len(y))}

def optimize_threshold(y,p):
    best=(0.5,-1)
    for k in range(45,56):
        t=k/100; pred=(p>=t).astype(int); acc=float(np.mean(pred==y))
        score=acc-.01*abs(t-.5)
        if score>best[1]:best=(t,score)
    return best[0]

def fit_pipe(X,y,C,seed):
    tr=MiniRocket(n_kernels=N_KERNELS,n_jobs=1,random_state=seed)
    Z=np.asarray(tr.fit_transform(X),dtype=np.float32)
    sc=StandardScaler(with_mean=False)
    Zs=sc.fit_transform(Z)
    clf=LogisticRegression(C=C,max_iter=1000,class_weight="balanced",solver="liblinear",random_state=seed)
    clf.fit(Zs,y)
    return tr,sc,clf

def predict_pipe(pipe,X):
    tr,sc,clf=pipe["transformer"],pipe["scaler"],pipe["classifier"]
    Z=np.asarray(tr.transform(X),dtype=np.float32)
    return clf.predict_proba(sc.transform(Z))[:,1]

def train_cmd(a):
    rows=load_rows(a.history,False)
    strict_labels=sum(1 for r in rows if r.get("y") is not None)
    if strict_labels<a.min_samples:
        emit({"ok":True,"status":"INSUFFICIENT_SAMPLES","samples":strict_labels,"featureRows":len(rows),"engineVersion":ENGINE_VERSION});return
    selections=[]
    for context in CONTEXTS:
        X,y,rounds=build_examples(rows,context)
        if len(y)<300:continue
        outer_n=60; valid_n=60
        outer_start=len(y)-outer_n
        valid_start=outer_start-context-valid_n
        train_end=valid_start-context
        if train_end<180:continue
        Xtr,ytr=X[:train_end],y[:train_end]
        Xv,yv=X[valid_start:valid_start+valid_n],y[valid_start:valid_start+valid_n]
        seed=20261005+context
        transformer=MiniRocket(n_kernels=N_KERNELS,n_jobs=1,random_state=seed)
        Ztr=np.asarray(transformer.fit_transform(Xtr),dtype=np.float32)
        Zv=np.asarray(transformer.transform(Xv),dtype=np.float32)
        scaler=StandardScaler(with_mean=False); ZtrS=scaler.fit_transform(Ztr); ZvS=scaler.transform(Zv)
        for C in (0.1,0.3,1.0,3.0):
            clf=LogisticRegression(C=C,max_iter=1000,class_weight="balanced",solver="liblinear",random_state=seed)
            clf.fit(ZtrS,ytr); p=clf.predict_proba(ZvS)[:,1]; t=optimize_threshold(yv,p); m=metrics(yv,p,t)
            score=.78*m["accuracy"]-.18*m["brier"]-.04*min(1,m["maxErrorStreak"]/6)
            selections.append({"context":context,"C":C,"threshold":t,"validation":m,"score":score})
    if not selections:
        emit({"ok":False,"status":"SEARCH_FAILED","engineVersion":ENGINE_VERSION});return
    selections.sort(key=lambda z:z["score"],reverse=True); best=selections[0]
    context=best["context"]; C=best["C"]; threshold=best["threshold"]
    X,y,rounds=build_examples(rows,context); outer_n=60
    train_end=len(y)-outer_n-context
    Xtrain,ytrain=X[:train_end],y[:train_end]; Xout,yout=X[-outer_n:],y[-outer_n:]
    pipe={}
    tr,sc,clf=fit_pipe(Xtrain,ytrain,C,20261111+context); pipe={"transformer":tr,"scaler":sc,"classifier":clf}
    p=predict_pipe(pipe,Xout); out=metrics(yout,p,threshold)
    prevalence=float((np.sum(ytrain)+2)/(len(ytrain)+4)); bp=np.full(len(yout),prevalence); bl=(bp>=.5).astype(int)
    out["baselineAccuracy"]=float(np.mean(bl==yout)); out["baselineBrier"]=float(brier_score_loss(yout,bp))
    reasons=[]
    if out["accuracy"]<.62:reasons.append("OUTER_ACCURACY_BELOW_62")
    if out["accuracy"]<out["baselineAccuracy"]+.04:reasons.append("OUTER_NOT_ABOVE_BASELINE_4PP")
    if out["brier"]>out["baselineBrier"]:reasons.append("OUTER_BRIER_WORSE_THAN_BASELINE")
    if out["recent20Accuracy"]<.60:reasons.append("OUTER_RECENT20_BELOW_60")
    if out["maxErrorStreak"]>4:reasons.append("OUTER_MAX_ERROR_STREAK_ABOVE_4")
    common={"ok":True,"engineVersion":ENGINE_VERSION,"lastTrainRound":rows[-1]["roundStartMs"],"contextRounds":context,"C":C,"threshold":threshold,"validation":best["validation"],"outerHoldout":out,"searched":[{"context":x["context"],"C":x["C"],"threshold":x["threshold"],"validation":x["validation"],"score":x["score"]} for x in selections[:8]],"library":"aeon.MiniRocket"}
    if reasons:
        emit({**common,"status":"REJECTED_BEFORE_FORWARD","reasons":reasons});return
    Xall,yall,_=build_examples(rows,context)
    tr,sc,clf=fit_pipe(Xall,yall,C,20261201+context)
    tv=int(time.time()*1000);ver=f"shadow-v5-minirocket-{tv}";os.makedirs(a.out_dir,exist_ok=True);path=os.path.join(a.out_dir,ver+".pkl")
    with open(path,"wb") as f:pickle.dump({"transformer":tr,"scaler":sc,"classifier":clf,"context":context,"threshold":threshold},f,pickle.HIGHEST_PROTOCOL)
    emit({**common,"status":"CANDIDATE_REGISTERED","modelVersion":ver,"trainedAt":tv,"trainedSamples":len(yall),"modelPath":path})

def predict_cmd(a):
    payload=json.load(sys.stdin);path=payload.get("modelPath");round_ms=int(payload.get("roundStartMs"))
    with open(path,"rb") as f:pipe=pickle.load(f)
    rows=load_rows(a.history,False); X=recent_sequence(rows,int(pipe["context"]),round_ms)
    if X is None:emit({"ok":False,"status":"SEQUENCE_NOT_READY"});return
    p=float(predict_pipe(pipe,X)[0])
    emit({"ok":True,"status":"PREDICTED","probability":round(max(.001,min(.999,p)),6),"threshold":float(pipe["threshold"]),"contextRounds":int(pipe["context"])})

def main():
    ap=argparse.ArgumentParser();sp=ap.add_subparsers(dest="cmd",required=True)
    t=sp.add_parser("train");t.add_argument("--history",required=True);t.add_argument("--out-dir",required=True);t.add_argument("--min-samples",type=int,default=300)
    p=sp.add_parser("predict");p.add_argument("--history",required=True)
    a=ap.parse_args()
    if a.cmd=="train":train_cmd(a)
    else:predict_cmd(a)
if __name__=="__main__":main()
