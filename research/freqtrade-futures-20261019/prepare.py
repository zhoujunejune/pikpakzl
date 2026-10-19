#!/usr/bin/env python3
"""Prepare public Binance futures strategy research, never exchange credentials."""
import hashlib
import json
import pathlib
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent
USER = ROOT / "user_data"
STRATEGY = USER / "strategies"
STRATEGY.mkdir(parents=True, exist_ok=True)
(USER / "data").mkdir(parents=True, exist_ok=True)
(RESULTS := ROOT / "results").mkdir(parents=True, exist_ok=True)
SHA = "f3340ce11f5bdf62f598522e64d1f5638eaa13f5"
FILES = ["FSampleStrategy.py", "FAdxSmaStrategy.py", "TrendFollowingStrategy.py"]
BASE = f"https://raw.githubusercontent.com/freqtrade/freqtrade-strategies/{SHA}/user_data/strategies/futures/"
manifest = {"source": "freqtrade/freqtrade-strategies", "commit": SHA, "files": {}}
for name in FILES:
    url = BASE + name
    with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "research-only"}), timeout=25) as r:
        content = r.read()
    if len(content) < 900 or len(content) > 200000 or b"class " not in content:
        raise RuntimeError(f"INVALID_STRATEGY_SOURCE_{name}")
    (STRATEGY / name).write_bytes(content)
    manifest["files"][name] = {"sha256": hashlib.sha256(content).hexdigest(), "url": url}

for asset in ("USDT", "USDC"):
    pairs = ["BTC/USDT:USDT", "ETH/USDT:USDT"] if asset == "USDT" else ["BTC/USDC:USDC"]
    cfg = {
        "bot_name": f"public_backtest_{asset.lower()}",
        "dry_run": True,
        "dry_run_wallet": 1000,
        "stake_currency": asset,
        "stake_amount": 100,
        "max_open_trades": 1,
        "trading_mode": "futures",
        "margin_mode": "isolated",
        "fiat_display_currency": "USD",
        "timeframe": "1h",
        "cancel_open_orders_on_exit": True,
        "exchange": {
            "name": "binance",
            "key": "",
            "secret": "",
            "ccxt_config": {"enableRateLimit": True},
            "pair_whitelist": pairs,
            "pair_blacklist": [],
        },
        "pairlists": [{"method": "StaticPairList"}],
        "entry_pricing": {"price_side": "same", "use_order_book": True, "order_book_top": 1},
        "exit_pricing": {"price_side": "same", "use_order_book": True, "order_book_top": 1},
        "order_types": {
            "entry": "limit", "exit": "limit", "stoploss": "market",
            "stoploss_on_exchange": False,
        },
    }
    (USER / f"config_{asset.lower()}.json").write_text(json.dumps(cfg, indent=2) + "\n")
    assert not cfg["exchange"]["key"] and not cfg["exchange"]["secret"]
(RESULTS / "provenance.json").write_text(json.dumps(manifest, indent=2) + "\n")
print("RESEARCH_CONFIGS_AND_PINNED_GITHUB_STRATEGIES_READY")
print("NO_API_KEYS_NO_PRODUCTION_DEPLOY")
