#!/usr/bin/env python3
"""Run Freqtrade backtests on an ephemeral Github-hosted container. Never trade."""
import json
import os
import pathlib
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent
USERDIR = ROOT / "user_data"
RESULTS = ROOT / "results"
IMAGE = "freqtradeorg/freqtrade:2026.9"
PAIRS = [("BTCUSDT", "BTC/USDT:USDT", "usdt"),
         ("ETHUSDT", "ETH/USDT:USDT", "usdt"),
         ("BTCUSDC", "BTC/USDC:USDC", "usdc")]
STRATEGIES = ["TrendFollowingStrategy", "FSampleStrategy", "FAdxSmaStrategy"]
RANGES = [("train", "20260815-20260915"),
          ("holdout", "20260915-20261016")]

def execute(name, command):
    logpath = RESULTS / (name + ".log")
    with logpath.open("w") as log:
        finished = subprocess.run(command, stdout=log, stderr=subprocess.STDOUT,
                                  check=False, timeout=1500)
    return finished.returncode == 0

def ft(*args):
    return ["docker", "run", "--rm", "--user", str(os.getuid())+":"+str(os.getgid()),
        "--env", "HOME=/tmp",
        "--mount", "type=bind,source="+str(USERDIR)+",target=/freqtrade/user_data",
        "--mount", "type=bind,source="+str(RESULTS)+",target=/freqtrade/results",
        IMAGE, *args]

def record(**row):
    with (RESULTS / "runs.jsonl").open("a") as f:
        f.write(json.dumps(row, ensure_ascii=False) + "\n")

def main():
    if os.getenv("GITHUB_ACTIONS") != "true":
        raise RuntimeError("Github-hosted research workflow only")
    if any(os.getenv(k) for k in (
        "BINANCE_API_KEY","BINANCE_API_SECRET",
        "ALIBABA_CLOUD_ACCESS_KEY_ID","ALIBABA_CLOUD_ACCESS_KEY_SECRET")):
        raise RuntimeError("Unexpected live credential in research environment")
    RESULTS.mkdir(exist_ok=True)
    print("RESEARCH_ONLY=TRUE; ALIBABA_DEPLOYMENT=NEVER; REAL_ORDERS=NEVER", flush=True)
    from prepare import main as prepare
    prepare()
    if not execute("docker-pull", ["docker", "pull", IMAGE]):
        raise RuntimeError("Pinned Freqtrade Docker image unavailable")
    if not execute("freqtrade-version",ft("--version")):
        raise RuntimeError("Freqtrade version command failed")
    for name, pair, asset in PAIRS:
        config = "/freqtrade/user_data/config_"+asset+".json"
        print("PUBLIC_FUTURES_DATA", name, flush=True)
        ok = execute("download_"+name, ft(
            "download-data","--config",config,
            "--trading-mode","futures","--pairs",pair,
            "--timeframes","5m","1h",
            "--timerange","20260801-20261016"))
        if not ok:
            print("NO_DATA", name, "binance unavailable or market unsupported", flush=True)
            for strategy in STRATEGIES:
                for stage, _ in RANGES:
                    record(pair=name,strategy=strategy,stage=stage,state="NO_DATA")
            continue
        for strategy in STRATEGIES:
            for stage, window in RANGES:
                prefix=name+"_"+strategy+"_"+stage
                status="COMMAND_OK" if execute(prefix,ft(
                    "backtesting","--config",config,
                    "--strategy-path","/freqtrade/user_data/strategies",
                    "--strategy",strategy,"--pairs",pair,
                    "--timerange",window,"--fee","0.0005",
                    "--export","trades",
                    "--export-filename","/freqtrade/results/"+prefix+".json"
                )) else "BACKTEST_FAILED"
                record(pair=name,strategy=strategy,stage=stage,state=status,export=prefix)
                print("RESEARCH_BACKTEST",prefix,status,flush=True)
    from summarize import main as summarize
    summarize()
    print("RESEARCH_FINISHED=TRUE; ONLY REAL EXPORTED METRICS COUNT",flush=True)

if __name__ == "__main__":
    main()
