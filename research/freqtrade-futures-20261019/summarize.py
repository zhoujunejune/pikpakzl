#!/usr/bin/env python3
"""Extract ONLY actual Freqtrade backtesting JSON; no inferred profit numbers."""
import csv
import json
import pathlib
import zipfile

ROOT=pathlib.Path(__file__).resolve().parent
RESULTS=ROOT/"results"
COLUMNS=["pair","strategy","stage","status","trades","wins","winrate_pct",
         "net_profit_pct","net_profit_abs","profit_factor","max_drawdown_pct",
         "extra_slippage_est_abs","net_after_extra_slippage_est_abs","note"]

def parse_exports(prefix,strategy):
    candidates=sorted(RESULTS.glob(prefix+"*"))
    for candidate in candidates:
        if candidate.suffix==".zip":
            with zipfile.ZipFile(candidate) as z:
                for name in z.namelist():
                    if name.endswith(".json") and not name.endswith(".meta.json"):
                        try:
                            parsed=json.loads(z.read(name))
                        except (ValueError,UnicodeDecodeError):
                            continue
                        if isinstance(parsed,dict) and "strategy" in parsed:
                            return parsed
        elif candidate.suffix==".json" and candidate.name!="runs.jsonl":
            try:
                parsed=json.loads(candidate.read_text())
            except ValueError:
                continue
            if isinstance(parsed,dict) and "strategy" in parsed:
                return parsed
    return None

def num(row,*keys):
    for key in keys:
        v=row.get(key)
        if isinstance(v,(int,float)) and not isinstance(v,bool):
            return v
    return None

def main():
    RESULTS.mkdir(parents=True,exist_ok=True)
    ledger=RESULTS/"runs.jsonl"
    if not ledger.exists():
        print("NO_BACKTEST_RESULTS_LEDGER")
        return
    records=[json.loads(x) for x in ledger.read_text().splitlines() if x.strip()]
    rows=[]
    for item in records:
        out={"pair":item["pair"],"strategy":item["strategy"],"stage":item["stage"],
             "status":item["state"],"note":"No output, cannot assess profitability"}
        if item["state"]=="COMMAND_OK":
            result=parse_exports(item.get("export",""),item["strategy"])
            detail=(result or {}).get("strategy",{}).get(item["strategy"])
            if isinstance(detail,dict):
                count=num(detail,"total_trades","trades_count")
                gross=num(detail,"profit_total_abs")
                pct=num(detail,"profit_total")
                dd=num(detail,"max_drawdown_account","max_drawdown")
                wr=num(detail,"winrate")
                pf=num(detail,"profit_factor")
                wins=num(detail,"wins")
                out.update(
                    status="COMPLETED" if count is not None else "MISSING_METRICS",
                    trades=count,wins=wins,
                    winrate_pct=round(wr*100,3) if wr is not None else None,
                    net_profit_pct=round(pct*100,3) if pct is not None else None,
                    net_profit_abs=round(gross,5) if gross is not None else None,
                    profit_factor=round(pf,4) if pf is not None else None,
                    max_drawdown_pct=round(dd*100,3) if dd is not None else None,
                    note="Freqtrade historical simulation; costs exclude real slippage and execution delays")
                trades=detail.get("trades")
                if isinstance(trades,list) and all(isinstance(t,dict) for t in trades):
                    # Extra 3 bps slippage on each side; fee 5bps each side already
                    # charged by Freqtrade. This is a supplemental estimate.
                    stakes=[num(t,"stake_amount") for t in trades]
                    if stakes and all(x is not None for x in stakes) and gross is not None:
                        est=sum(stakes)*0.0006
                        out["extra_slippage_est_abs"]=round(est,5)
                        out["net_after_extra_slippage_est_abs"]=round(gross-est,5)
            else:
                out["status"]="MISSING_METRICS"
                out["note"]="Freqtrade command passed but no parseable exported metrics"
        rows.append(out)
    with (RESULTS/"comparison.csv").open("w",newline="") as f:
        w=csv.DictWriter(f,fieldnames=COLUMNS,extrasaction="ignore")
        w.writeheader()
        w.writerows(rows)
    (RESULTS/"comparison.json").write_text(json.dumps(rows,indent=2,ensure_ascii=False)+"\n")
    report=[
        "# Freqtrade Binance futures strategy research",
        "",
        "All amounts are **hypothetical**, not real Binance fills.",
        "Public market data only. No credentials, no cloud deploy, no real orders.",
        "Train 2026-08-15..09-14; holdout 2026-09-15..10-15 (UTC).",
        "Baseline 1x/no forced leverage, 1000 stake currency per isolated pair,",
        "100 stake currency per order, simulated fee 0.05% per side.",
        "BTCUSDC remains USDC-settled, reported separately from USDT.",
        "Slippage/funding completeness must be independently checked.",
        "",
        "| Pair | Strategy | Window | Status | Trades | Net % | Max DD % | Profit factor |",
        "|---|---|---|---|---:|---:|---:|---:|",
    ]
    for r in rows:
        def val(key):
            v=r.get(key)
            return "N/A" if v is None else str(v)
        report.append("| "+ " | ".join(val(x) for x in
          ("pair","strategy","stage","status","trades","net_profit_pct",
           "max_drawdown_pct","profit_factor"))+" |")
    report.extend([
        "",
        "**Decision rule:** Do not select a strategy based on fewer than 30",
        "holdout trades, missing funding/mark data, insufficient market coverage,",
        "or non-positive cost-adjusted holdout results. These are not proofs",
        "of future profits even if the thresholds are met.",
        "",
        "The 5m and 1h strategy rows represent different horizons; treat them as",
        "exploratory alternatives, not a controlled one-variable experiment.",
    ])
    (RESULTS/"README_RESULTS.md").write_text("\n".join(report)+"\n")
    ok=sum(r["status"]=="COMPLETED" for r in rows)
    print("COMPARISON_ROWS",len(rows),"WITH_REAL_EXPORTED_METRICS",ok)
    if ok==0:
        print("NO_VERIFIED_RETURN_METRICS; DO_NOT_CLAIM_PROFITABILITY")

if __name__=="__main__":
    main()
