"""Conservative walk-forward parameter learning for 9 *paper-only* futures streams.

This module is pure: no network, no exchange keys, no trading, no filesystem.
Train chronological first 70%, validate held-out last 30%. No future candle
or same-bar close is used to decide an entry. A candidate is promoted to
forward paper signals only when its held-out evidence clears the gates.
"""
import math

BASELINES={
 "TrendFollowingStrategy":{"ema":20},
 "FSampleStrategy":{"rsi_low":30,"rsi_high":70},
 "FAdxSmaStrategy":{"short":12,"long":48,"adx":30},
}
MIN_BARS={"TrendFollowingStrategy":3000,"FSampleStrategy":400,"FAdxSmaStrategy":400}
COST_FEE=0.0005
COST_SLIP=0.0003
STOP=0.02
TAKE=0.03

def candidates(model):
    if model=="TrendFollowingStrategy":
        return [{"ema":x} for x in (12,16,20,24,30)]
    if model=="FSampleStrategy":
        return [{"rsi_low":lo,"rsi_high":hi}
                for lo in (25,30,35) for hi in (65,70,75)]
    if model=="FAdxSmaStrategy":
        return [{"short":s,"long":l,"adx":adx}
                for s in (9,12,15) for l in (36,48,60) for adx in (25,30,35)]
    raise ValueError("unknown model")

def ema(values,n):
    out=[];v=values[0];k=2/(n+1)
    for x in values:
        v=v+k*(x-v)
        out.append(v)
    return out

def sma(values,n):
    out=[];running=0.0
    for i,v in enumerate(values):
        running+=v
        if i>=n:running-=values[i-n]
        out.append(running/n if i+1>=n else None)
    return out

def rsi(values,n=14):
    result=[None]*len(values)
    if len(values)<n+1:return result
    gains=[max(values[i]-values[i-1],0.0) for i in range(1,len(values))]
    losses=[max(values[i-1]-values[i],0.0) for i in range(1,len(values))]
    gain=sum(gains[:n])/n;loss=sum(losses[:n])/n
    def value(g,l):
        if l==0:return 50.0 if g==0 else 100.0
        return 100.0-100.0/(1.0+g/l)
    result[n]=value(gain,loss)
    for i in range(n+1,len(values)):
        gain=(gain*(n-1)+gains[i-1])/n
        loss=(loss*(n-1)+losses[i-1])/n
        result[i]=value(gain,loss)
    return result

def adx(rows,n=14):
    out=[None]*len(rows)
    if len(rows)<n*3:return out
    tr=[];plus=[];minus=[]
    for i in range(1,len(rows)):
        a,b=rows[i-1],rows[i]
        high,low,prev_close=b[2],b[3],a[4]
        up=high-a[2];down=a[3]-low
        plus.append(up if up>down and up>0 else 0)
        minus.append(down if down>up and down>0 else 0)
        tr.append(max(high-low,abs(high-prev_close),abs(low-prev_close)))
    atr=sum(tr[:n]);sp=sum(plus[:n]);sm=sum(minus[:n])
    dx=[]
    for i in range(n-1,len(tr)):
        if i>=n:
            atr=atr-atr/n+tr[i];sp=sp-sp/n+plus[i];sm=sm-sm/n+minus[i]
        p=100*sp/atr if atr>0 else 0
        m=100*sm/atr if atr>0 else 0
        dx.append(100*abs(p-m)/(p+m) if p+m>0 else 0)
    value=sum(dx[:n])/n
    at=n*2-1
    if at<len(out):out[at]=value
    for i in range(n,len(dx)):
        value=(value*(n-1)+dx[i])/n
        at=n+i
        if at<len(out):out[at]=value
    return out

def features(rows,model):
    close=[float(row[4]) for row in rows]
    volume=[float(row[5]) for row in rows]
    result={"close":close,"volume":volume,"n":len(rows)}
    if model=="TrendFollowingStrategy":
        result["ema"]={n:ema(close,n) for n in (12,16,20,24,30)}
    elif model=="FSampleStrategy":
        result["rsi"]=rsi(close)
        e1=ema(close,9);e2=ema(e1,9);e3=ema(e2,9)
        result["tema"]=[3*x-3*y+z for x,y,z in zip(e1,e2,e3)]
        typ=[(row[2]+row[3]+row[4])/3 for row in rows]
        result["bbmid"]=sma(typ,20)
    elif model=="FAdxSmaStrategy":
        result["sma"]={n:sma(close,n) for n in (9,12,15,36,48,60)}
        result["adx"]=adx(rows)
    else:raise ValueError("unknown model")
    return result

def condition(f,model,params,i):
    """Signal from CLOSED candle i, executed at NEXT candle i+1 open."""
    if i<180:return (None,None)
    c=f["close"];vol=f["volume"]
    if model=="TrendFollowingStrategy":
        e=f["ema"][params["ema"]]
        delta=vol[i] if c[i]>c[i-1] else -vol[i] if c[i]<c[i-1] else 0
        enter="LONG" if c[i]>e[i] and c[i-1]<=e[i-1] and delta>0 else None
        exit_="LONG" if c[i]<e[i] and c[i-1]>=e[i-1] and delta>0 else None
        return enter,exit_
    if model=="FSampleStrategy":
        rr=f["rsi"];tema=f["tema"];mid=f["bbmid"][i]
        if rr[i] is None or rr[i-1] is None or mid is None:return (None,None)
        lo=(rr[i-1]<=params["rsi_low"]<rr[i] and tema[i]<=mid and
            tema[i]>tema[i-1] and vol[i]>0)
        hi=(rr[i-1]<=params["rsi_high"]<rr[i] and tema[i]>mid and
            tema[i]<tema[i-1] and vol[i]>0)
        return ("LONG" if lo else "SHORT" if hi else None,
                "SHORT" if lo else "LONG" if hi else None)
    a=f["adx"][i];s=f["sma"][params["short"]];l=f["sma"][params["long"]]
    if a is None or any(x is None for x in (s[i],l[i],s[i-1],l[i-1])):
        return (None,None)
    up=s[i-1]<=l[i-1] and s[i]>l[i]
    down=s[i-1]>=l[i-1] and s[i]<l[i]
    return ("LONG" if up and a>params["adx"] else "SHORT" if down and a>params["adx"] else None,
            "BOTH" if a<params["adx"] else None)

def replay(rows,f,model,params,start,end):
    """Synthetic 1x OHLC replay; gap-through stop uses adverse OPEN; both
    stop & target in a candle => conservative STOP. No funding or liquidation.
    This is research scoring, NOT actual exchange execution."""
    equity=1000.0;peak=1000.0;dd=0;pos=None;results=[]
    warmup=max(181,start)
    for i in range(warmup,min(len(rows),end)):
        curr=rows[i]
        op,hi,lo=float(curr[1]),float(curr[2]),float(curr[3])
        if not (op>0 and hi>=op and lo<=op):continue
        signal,ex=condition(f,model,params,i-1)
        exited=False
        if pos:
            direction=1 if pos["side"]=="LONG" else -1
            if ex in (pos["side"],"BOTH"):
                exit_raw=op;reason="signal"
            else:
                stop=pos["stop"];target=pos["take"]
                bad=lo<=stop if direction==1 else hi>=stop
                good=hi>=target if direction==1 else lo<=target
                if bad:
                    exit_raw=min(op,stop) if direction==1 else max(op,stop)
                    reason="stop"
                elif good:
                    exit_raw=target;reason="target"
                else:exit_raw=None
            if exit_raw is not None:
                filled=exit_raw*(1-direction*COST_SLIP)
                delta=(filled-pos["entry"])*pos["qty"]*direction-abs(filled*pos["qty"])*COST_FEE
                equity+=delta
                results.append(delta-pos["entryFee"])
                pos=None;exited=True
        if not pos and not exited and signal and equity>105:
            direction=1 if signal=="LONG" else -1
            price=op*(1+direction*COST_SLIP)
            nominal=min(100,equity*0.1)
            entry_fee=nominal*COST_FEE
            equity-=entry_fee
            pos={"side":signal,"entry":price,"qty":nominal/price,
                 "entryFee":entry_fee,
                 "stop":price*(1-direction*STOP),
                 "take":price*(1+direction*TAKE)}
        peak=max(peak,equity)
        dd=max(dd,100*(peak-equity)/peak)
    # No forced 'window-end' sale: open positions are not falsely settled.
    won=[x for x in results if x>0]
    gross_gain=sum(x for x in results if x>0)
    gross_loss=-sum(x for x in results if x<0)
    return {"trades":len(results),"wins":len(won),
            "netPct":round(100*(equity/1000-1),5),
            "winratePct":round(100*len(won)/len(results),2) if results else None,
            "maxDrawdownPct":round(dd,4),
            "profitFactor":round(gross_gain/gross_loss,3) if gross_loss else None,
            "openAtEnd":pos is not None,
            "approximate":True}

def study(rows,model,prior=None):
    n=len(rows)
    interval=300_000 if model=="TrendFollowingStrategy" else 3_600_000
    if n<MIN_BARS[model]:
        return {"status":"INSUFFICIENT_CANDLES","candleCount":n,
                "requiredCandles":MIN_BARS[model],"eligible":False}
    stamps=[int(x[0]) for x in rows]
    # Full chronologically contiguous closed-bar sequence only.
    if any(stamps[i]-stamps[i-1]!=interval for i in range(1,n)):
        return {"status":"DATA_GAP","candleCount":n,"eligible":False}
    f=features(rows,model)
    boundary=max(300,int(n*.7))
    base=BASELINES[model]
    baseline_train=replay(rows,f,model,base,180,boundary)
    baseline_holdout=replay(rows,f,model,base,boundary,n)
    samples=[]
    for config in candidates(model):
        train=replay(rows,f,model,config,180,boundary)
        samples.append((train["netPct"]-0.25*train["maxDrawdownPct"],tuple(sorted(config.items())),config,train))
    samples.sort(reverse=True,key=lambda x:(x[0],x[1]))
    best=samples[0]
    cfg=best[2];train=best[3]
    holdout=replay(rows,f,model,cfg,boundary,n)
    # The holdout is used only for the promote-or-keep decision, never
    # to rank candidates. Require meaningful sample size and advantage.
    eligible=(cfg!=base and train["trades"]>=8 and holdout["trades"]>=5
              and holdout["netPct"]>baseline_holdout["netPct"]+0.25
              and holdout["netPct"]>0
              and holdout["maxDrawdownPct"]<=max(2.0,baseline_holdout["maxDrawdownPct"]+0.5)
              and holdout["profitFactor"] is not None
              and holdout["profitFactor"]>=1.15)
    return {"status":"ELIGIBLE" if eligible else "VALIDATED_KEEP_BASELINE",
            "eligible":eligible,"candleCount":n,"trainCandles":boundary,
            "holdoutCandles":n-boundary,"candidateParams":cfg,
            "baselineParams":dict(base),"train":train,"holdout":holdout,
            "baselineTrain":baseline_train,"baselineHoldout":baseline_holdout,
            "method":"chronological_70pct_train_30pct_holdout",
            "candidateCount":len(samples),"notOfficialFreqtrade":True,
            "trainingNote":"Deterministic parameter search; no ML neural network; held-out replay excludes funding, real fills."}
