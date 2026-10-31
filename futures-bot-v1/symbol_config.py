"""Approved Binance USD(S)-M perpetuals and their settlement assets."""
ALLOWED_SYMBOLS=("BTCUSDT","ETHUSDT","BTCUSDC")
DEFAULT_SYMBOLS=",".join(ALLOWED_SYMBOLS)

def margin_asset(symbol):
    if symbol not in ALLOWED_SYMBOLS:
        raise ValueError("Unsupported futures symbol: "+str(symbol))
    return "USDC" if symbol.endswith("USDC") else "USDT"
