#!/usr/bin/env python3
import argparse, json, math, os, pickle, sys, time, warnings
warnings.filterwarnings("ignore")

import numpy as np
import pandas as pd
from flaml import AutoML
from sklearn.metrics import accuracy_score, brier_score_loss

ENGINE_VERSION = "NO_BASE_SPECIALIST_AUTOML_V2_EXACT20_WEIGHTED"
PREDICTION_BOOK_MAX_AGE_MS = 5000
INNER_VALID_ROWS = 30
OUTER_HOLDOUT_ROWS = 30
EMBARGO_ROWS = 2
WINDOWS = (120, 180, 240, 360, 600)
ESTIMATORS = ("lgbm", "xgboost", "catboost", "extra_tree")

FEATURE_NAMES = [
    "regimeScore","currentScore","microScore","currentTrendScore",
    "normalizedMomentum15s","normalizedMomentum30s","normalizedMomentum60s",
    "normalizedMomentum180s","normalizedMomentum300s",
    "tradePressure5s","tradePressure15s","tradePressure60s",
    "ofiNormalized5s","ofiNormalized60s","rangePosition180",
    "distanceFromOpenScaled","absorptionRisk",
    "predictionMarketUpMidCentered","predictionMarketMissing",
    "predictionMarketSupportAbs","currentMidAgreement","trendMidAgreement",
    "ofiPressureInteraction","momentumAgreement60x300",
    "shortLongMomentumGap","pressureImbalance","observationDelayNorm",
]

def emit(payload):
    print("NO_BASE_SPECIALIST_RESULT=" + json.dumps(payload, separators=(",",":"), ensure_ascii=False), flush=True)

def finite_number(value):
    try: n=float(value)
    except (TypeError,ValueError): return None
    return n if math.isfinite(n) else None

def clip(v, lo=-3.0, hi=3.0):
    return max(lo,min(hi,float(v)))

def feature_row(facts, delay_ms=15000):
    if not isinstance(facts,dict): return None
    required={}
    for key in [
        "regimeScore","currentScore","microScore","currentTrendScore",
        "normalizedMomentum15s","normalizedMomentum30s","normalizedMomentum60s",
        "normalizedMomentum180s","normalizedMomentum300s",
        "tradePressure15s","tradePressure60s","ofiNormalized5s","rangePosition180",
    ]:
        v=finite_number(facts.get(key))
        if v is None: return None
        required[key]=clip(v)

    p5=finite_number(facts.get("tradePressure5s"))
    ofi60=finite_number(facts.get("ofiNormalized60s"))
    dist=finite_number(facts.get("distanceFromOpenBps"))
    up_mid=finite_number(facts.get("predictionMarketUpMid"))
    book_age=finite_number(facts.get("predictionMarketBookAgeMs"))
    valid=(
        facts.get("predictionMarketMappingReliable") is True and
        facts.get("predictionMarketRoundAligned") is True and
        book_age is not None and 0 <= book_age <= PREDICTION_BOOK_MAX_AGE_MS and
        up_mid is not None
    )
    mid=clip((up_mid-0.5)*2.0) if valid else 0.0
    missing=0.0 if valid else 1.0
    current=required["currentScore"]; trend=required["currentTrendScore"]
    m15=required["normalizedMomentum15s"]; m60=required["normalizedMomentum60s"]; m300=required["normalizedMomentum300s"]
    p15=required["tradePressure15s"]; p60=required["tradePressure60s"]; ofi5=required["ofiNormalized5s"]
    return {
        **required,
        "tradePressure5s": clip(p5 if p5 is not None else 0.0),
        "ofiNormalized60s": clip(ofi60 if ofi60 is not None else 0.0),
        "distanceFromOpenScaled": clip((dist if dist is not None else 0.0)/5.0),
        "absorptionRisk": 1.0 if facts.get("absorptionRisk") else 0.0,
        "predictionMarketUpMidCentered": mid,
        "predictionMarketMissing": missing,
        "predictionMarketSupportAbs": abs(mid),
        "currentMidAgreement": clip(current*mid),
        "trendMidAgreement": clip(trend*mid),
        "ofiPressureInteraction": clip(ofi5*p60),
        "momentumAgreement60x300": clip(m60*m300),
        "shortLongMomentumGap": clip(m15-m300),
        "pressureImbalance": clip(p15-p60),
        "observationDelayNorm": clip((float(delay_ms)-15000.0)/5000.0),
    }

def load_samples(history_path):
    with open(history_path,"r",encoding="utf-8") as f:
        rows=json.load(f)
    out=[]; exact20=0; bootstrap15=0
    for row in rows if isinstance(rows,list) else []:
        if row.get("actualSource")!="BINANCE_PREDICTION_OFFICIAL_RESOLUTION": continue
        if "STRICT_ROUND_ALIGNED_TOPIC" not in str(row.get("resolutionEvidence") or ""): continue
        actual=row.get("actual")
        if actual not in ("UP","DOWN"): continue
        # Specialist only learns rounds for which raw V3 never produced UP/DOWN.
        if row.get("prediction") in ("UP","DOWN"): continue
        round_ms=finite_number(row.get("roundStartMs"))
        if round_ms is None: continue

        facts=None; observed=None; source=None
        nb_at=finite_number(row.get("noBaseSpecialistObservedAt"))
        if nb_at is not None and isinstance(row.get("noBaseSpecialistFacts"),dict):
            delay=nb_at-round_ms
            if 18000 <= delay <= 22000:
                facts=row.get("noBaseSpecialistFacts"); observed=nb_at; source="20S_EXACT"; exact20+=1
        if facts is None:
            sh_at=finite_number(row.get("shadowObservedAt"))
            if sh_at is not None and isinstance(row.get("shadowFacts"),dict):
                delay=sh_at-round_ms
                if 8000 <= delay <= 20000:
                    facts=row.get("shadowFacts"); observed=sh_at; source="15S_BOOTSTRAP"; bootstrap15+=1
        if facts is None: continue
        x=feature_row(facts, observed-round_ms)
        if x is None: continue
        out.append({"roundStartMs":int(round_ms),"observedAt":int(observed),"source":source,"y":1 if actual=="UP" else 0,"x":x})
    out.sort(key=lambda z:z["roundStartMs"])
    return out, {"exact20s":exact20,"bootstrap15s":bootstrap15}

def frame(samples):
    return pd.DataFrame([s["x"] for s in samples],columns=FEATURE_NAMES), np.asarray([s["y"] for s in samples],dtype=int)

def source_aware_training_view(samples, target_exact_share=0.25, max_multiplier=12):
    rows=list(samples)
    exact=[s for s in rows if s.get("source")=="20S_EXACT"]
    bootstrap=[s for s in rows if s.get("source")!="20S_EXACT"]
    if not exact or not bootstrap:
        return rows, {"exactMultiplier":1,"fitExact":len(exact),"fitBootstrap":len(bootstrap),
                      "fitExactShare":float(len(exact)/max(1,len(rows)))}
    needed=int(math.ceil((target_exact_share*len(bootstrap))/((1.0-target_exact_share)*len(exact))))
    multiplier=max(1,min(int(max_multiplier),needed))
    expanded=list(bootstrap)
    for _ in range(multiplier):
        expanded.extend(exact)
    expanded.sort(key=lambda z:z["roundStartMs"])
    return expanded, {"exactMultiplier":multiplier,"fitExact":len(exact)*multiplier,
                      "fitBootstrap":len(bootstrap),
                      "fitExactShare":float((len(exact)*multiplier)/max(1,len(expanded)))}

def proba1(model,X):
    arr=np.asarray(model.predict_proba(X))
    if arr.ndim==1: return arr.astype(float)
    classes=list(getattr(model,"classes_",[0,1]))
    try: idx=classes.index(1)
    except ValueError: idx=1 if arr.shape[1]>1 else 0
    return arr[:,idx].astype(float)

def selective_metrics(y,p,confidence):
    y=np.asarray(y,dtype=int); p=np.asarray(p,dtype=float)
    mask=(p>=confidence)|(p<=1.0-confidence)
    n=int(mask.sum())
    if n==0:
        return {"decisions":0,"hits":0,"misses":0,"accuracy":None,"coverage":0.0,"brier":None,"maxErrorStreak":0}
    pred=(p[mask]>=0.5).astype(int); yy=y[mask]
    hits=int(np.sum(pred==yy))
    streak=0; max_streak=0
    for ok in (pred==yy):
        if ok: streak=0
        else:
            streak+=1; max_streak=max(max_streak,streak)
    return {
        "decisions":n,"hits":hits,"misses":n-hits,
        "accuracy":float(hits/n),"coverage":float(n/len(y)),
        "brier":float(brier_score_loss(yy,p[mask])),
        "maxErrorStreak":int(max_streak),
    }

def choose_confidence_gate(y,p):
    candidates=[]
    min_decisions=max(8,int(len(y)*0.20))
    for k in range(55,81):
        c=k/100.0
        m=selective_metrics(y,p,c)
        if m["decisions"]<min_decisions: continue
        candidates.append((c,m))
    safe=[z for z in candidates if z[1]["accuracy"] is not None and z[1]["accuracy"]>=0.72]
    if safe:
        safe.sort(key=lambda z:(z[1]["coverage"],z[1]["accuracy"],-z[1]["maxErrorStreak"]),reverse=True)
        return safe[0][0],safe[0][1],True
    if not candidates: return 0.75, selective_metrics(y,p,0.75), False
    candidates.sort(key=lambda z:((z[1]["accuracy"] or 0)*0.75+z[1]["coverage"]*0.25-z[1]["maxErrorStreak"]*0.005),reverse=True)
    return candidates[0][0],candidates[0][1],False

def search_metric(X_val,y_val,estimator,labels,X_train,y_train,weight_val=None,weight_train=None,config=None,groups_val=None,groups_train=None):
    p=proba1(estimator,X_val)
    c,m,safe=choose_confidence_gate(y_val,p)
    acc=m["accuracy"] if m["accuracy"] is not None else 0.0
    loss=0.72*(1.0-acc)+0.18*(1.0-m["coverage"])+0.10*(m["brier"] if m["brier"] is not None else 0.5)
    if not safe: loss+=0.08
    return loss, {"accuracy":acc,"coverage":m["coverage"],"confidence":c}

def run_automl(train,valid,budget,seed):
    fit_train,fit_mix=source_aware_training_view(train)
    Xtr,ytr=frame(fit_train); Xv,yv=frame(valid)
    automl=AutoML()
    automl.fit(
        X_train=Xtr,y_train=ytr,X_val=Xv,y_val=yv,task="classification",
        metric=search_metric,estimator_list=list(ESTIMATORS),time_budget=max(10,int(budget)),
        n_jobs=1,seed=int(seed),verbose=0,retrain_full=True,model_history=False,keep_search_state=False,
    )
    p=proba1(automl,Xv)
    conf,m,safe=choose_confidence_gate(yv,p)
    score=(m["accuracy"] or 0)*0.72+m["coverage"]*0.22-(m["maxErrorStreak"]*0.006)+(0.03 if safe else 0)
    return automl,conf,m,safe,float(score),fit_mix

def fit_final(samples,estimator_name,best_config,budget,seed):
    fit_samples,_=source_aware_training_view(samples)
    X,y=frame(fit_samples)
    automl=AutoML()
    kwargs=dict(X_train=X,y_train=y,task="classification",metric=search_metric,
                estimator_list=[estimator_name],time_budget=max(10,int(budget)),max_iter=1,
                n_jobs=1,seed=int(seed),verbose=0,retrain_full=True,model_history=False,keep_search_state=False)
    if isinstance(best_config,dict) and best_config:
        kwargs["starting_points"]={estimator_name:best_config}
    automl.fit(**kwargs)
    return automl

def train_command(args):
    samples,mix=load_samples(args.history)
    if len(samples)<args.min_samples:
        emit({"ok":True,"status":"INSUFFICIENT_SAMPLES","samples":len(samples),"sourceMix":mix,"engineVersion":ENGINE_VERSION})
        return
    last_round=samples[-1]["roundStartMs"]
    outer_n=min(OUTER_HOLDOUT_ROWS,max(20,int(len(samples)*0.15)))
    tuning=samples[:-outer_n]; outer=samples[-outer_n:]
    if len(tuning)<80:
        emit({"ok":True,"status":"INSUFFICIENT_TUNING_SAMPLES","samples":len(samples),"lastTrainRound":last_round,"sourceMix":mix,"engineVersion":ENGINE_VERSION})
        return
    windows=[w for w in WINDOWS if len(tuning)>=w] or [len(tuning)]
    per_budget=max(10,int(args.time_budget/max(1,len(windows))))
    searched=[]
    for window in windows:
        scope=tuning[-min(window,len(tuning)):]
        valid_n=min(INNER_VALID_ROWS,max(20,int(len(scope)*0.18)))
        valid_start=len(scope)-valid_n
        train_end=valid_start-EMBARGO_ROWS
        if train_end<60: continue
        try:
            automl,conf,inner,safe,score,fit_mix=run_automl(scope[:train_end],scope[valid_start:],per_budget,args.seed+window)
            searched.append({"window":window,"automl":automl,"confidence":conf,"inner":inner,"innerSafe":safe,"selectionScore":score,
                             "fitSourceWeighting":fit_mix,
                             "bestEstimator":str(automl.best_estimator),"bestConfig":dict(automl.best_config or {})})
        except Exception as exc:
            print(json.dumps({"event":"no_base_specialist_window_failed","window":window,"error":str(exc)}),file=sys.stderr,flush=True)
    if not searched:
        emit({"ok":False,"status":"SEARCH_FAILED","lastTrainRound":last_round,"sourceMix":mix,"engineVersion":ENGINE_VERSION}); return
    searched.sort(key=lambda z:z["selectionScore"],reverse=True); best=searched[0]
    Xo,yo=frame(outer); po=proba1(best["automl"],Xo)
    outer_m=selective_metrics(yo,po,best["confidence"])
    train_y=np.asarray([s["y"] for s in tuning],dtype=int)
    baseline=max(float(np.mean(yo==0)),float(np.mean(yo==1)))
    reasons=[]
    if not best["innerSafe"]: reasons.append("INNER_NO_72_PERCENT_SAFE_GATE")
    if (outer_m["accuracy"] or 0)<0.68: reasons.append("OUTER_SELECTIVE_ACCURACY_BELOW_68")
    if outer_m["decisions"]<8: reasons.append("OUTER_TOO_FEW_DECISIONS")
    if outer_m["coverage"]<0.08: reasons.append("OUTER_COVERAGE_BELOW_8_PERCENT")
    if outer_m["maxErrorStreak"]>4: reasons.append("OUTER_MAX_ERROR_STREAK_ABOVE_4")
    common={
        "ok":True,"engineVersion":ENGINE_VERSION,"lastTrainRound":int(last_round),"strictSamples":len(samples),
        "sourceMix":mix,"windowSize":int(best["window"]),"confidenceThreshold":round(float(best["confidence"]),4),
        "bestEstimator":best["bestEstimator"],"bestConfig":best["bestConfig"],"innerValidation":best["inner"],
        "fitSourceWeighting":best.get("fitSourceWeighting"),
        "outerHoldout":{**outer_m,"baselineAlwaysClassAccuracy":baseline,"samples":len(outer),
                        "startRound":outer[0]["roundStartMs"],"endRound":outer[-1]["roundStartMs"]},
        "searched":[{"window":x["window"],"bestEstimator":x["bestEstimator"],"confidenceThreshold":round(x["confidence"],4),
                     "innerValidation":x["inner"],"innerSafe":x["innerSafe"],"selectionScore":round(x["selectionScore"],6)} for x in searched],
        "trainerStack":["FLAML","LightGBM","XGBoost","CatBoost","ExtraTrees","PURGED_TIME_SPLIT","SELECTIVE_CONFIDENCE_GATE"],
    }
    if reasons:
        emit({**common,"status":"REJECTED_BEFORE_FORWARD","reasons":reasons}); return
    final_scope=samples[-min(best["window"],len(samples)):]
    try:
        model=fit_final(final_scope,best["bestEstimator"],best["bestConfig"],max(12,int(args.time_budget*0.25)),args.seed+991)
    except Exception:
        model=best["automl"]
    trained_at=int(time.time()*1000); version=f"no-base-specialist-{trained_at}"
    os.makedirs(args.out_dir,exist_ok=True); path=os.path.join(args.out_dir,version+".pkl")
    with open(path,"wb") as fh: pickle.dump(model,fh,protocol=pickle.HIGHEST_PROTOCOL)
    emit({**common,"status":"CANDIDATE_REGISTERED","modelVersion":version,"trainedAt":trained_at,
          "modelPath":path,"trainedSamples":len(final_scope)})

def predict_command(args):
    payload=json.load(sys.stdin); facts=payload.get("facts"); delay=payload.get("delayMs",20000)
    x=feature_row(facts,delay)
    if x is None:
        emit({"ok":False,"status":"INVALID_FEATURES","predictions":[]}); return
    X=pd.DataFrame([x],columns=FEATURE_NAMES); preds=[]
    for item in payload.get("models",[]):
        try:
            with open(item.get("modelPath"),"rb") as fh: model=pickle.load(fh)
            p=float(proba1(model,X)[0])
            preds.append({"modelVersion":item.get("modelVersion"),"probability":round(max(0.001,min(0.999,p)),6)})
        except Exception as exc:
            preds.append({"modelVersion":item.get("modelVersion"),"error":str(exc)})
    emit({"ok":True,"status":"PREDICTED","predictions":preds})

def main():
    parser=argparse.ArgumentParser(); sub=parser.add_subparsers(dest="command",required=True)
    tr=sub.add_parser("train"); tr.add_argument("--history",required=True); tr.add_argument("--out-dir",required=True)
    tr.add_argument("--min-samples",type=int,default=120); tr.add_argument("--time-budget",type=int,default=60); tr.add_argument("--seed",type=int,default=20261007)
    sub.add_parser("predict")
    args=parser.parse_args()
    if args.command=="train": train_command(args)
    else: predict_command(args)

if __name__=="__main__": main()
