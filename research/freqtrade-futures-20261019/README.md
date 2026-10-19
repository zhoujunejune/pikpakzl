# Binance perpetual backtest laboratory (GitHub only)

Status: RESEARCH / NO REAL TRADING.

This experiment lives on the dedicated branch research/freqtrade-futures-20261019,
in the folder research/freqtrade-futures-20261019. It does not edit or
deploy the production bots, and it does not invoke Alibaba Cloud at all.

- Runtime: ephemeral GitHub-hosted ubuntu-latest runner.
- Freqtrade Docker image: freqtradeorg/freqtrade:2026.9 (stable release).
- Strategies: FSampleStrategy (1h), FAdxSmaStrategy (1h), and
  TrendFollowingStrategy (5m, original community source with long/short
  behavior unchanged).
- The three strategy files are downloaded from the public GitHub repository
  freqtrade/freqtrade-strategies, pinned to commit
  f3340ce11f5bdf62f598522e64d1f5638eaa13f5.
- Binance **USD-M futures only**: BTC/USDT:USDT, ETH/USDT:USDT, BTC/USDC:USDC.
- USDT and USDC use separate research configs and wallets.
- Market data period: 2026-08-01 through 2026-10-15 UTC.
- Training sample: Aug 15 to Sep 14. Out-of-sample: Sep 15 to Oct 15.
- Simulated wallet: 1000 USDT or USDC per isolated pair. Per-position
  stake: 100 units. One position per isolated pair/strategy/window run.
- Fee: 0.05% entry plus 0.05% exit; estimate a further 0.03% per
  side slippage where actual backtest trade details permit.
- Freqtrade fetches **futures, funding and mark** candle history through
  its documented public market-data path.

ABSOLUTE SAFETY BOUNDARIES
1. No real exchange credentials, secrets, SSH, Alibaba SDK or local
   production files are passed to the job or the Docker container.
2. Only official Freqtrade commands 'download-data' and 'backtesting' are
   called. No 'trade' command is ever executed.
3. The workflow is scoped to the research branch and research-only paths.
   Its token has contents:read; it cannot write to production branches.
4. The GitHub runner and its generated files are ephemeral. No production
   services, real orders, API balances, or Hedge Mode settings are touched.
5. Failed/blocked market data are reported as NO_DATA, not as 0% return.
   Missing exported results do not become fabricated backtest statistics.
6. Research results (including logs, provenance JSON, CSV, human-readable
   Markdown) are stored as downloadable GitHub Actions artifacts.
7. A strategy with more backtest profit is NOT automatically better.
   Compare out-of-sample net returns after costs, max drawdown,
   profit factor, win rate, trade count and market-specific failure modes.

IMPORTANT LIMITATIONS
- Freqtrade's Binance LIVE connector requires One-way and Single-Asset
  mode. The user's existing exchange account is Hedge Mode. There is no
  real trading connection here and we do not modify those account settings.
- Research uses baseline 1x. It does not pretend to forecast 10x returns.
- Public data may be inaccessible from GitHub Actions' region, or Binance
  may not expose BTC/USDC:USDC to the configured ccxt market set.
  If so, results correctly state NO_DATA, and the project must not
  fill gaps with spot candles or fabricated funding fees.
- A single-month holdout never proves stable future profitability.
- 5m vs 1h strategies compare different trading horizons. Further
  same-timeframe controls are necessary before causally comparing signals.

Workflow location: .github/workflows/research-freqtrade-futures.yml
