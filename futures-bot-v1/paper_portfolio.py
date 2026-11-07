"""Paper-only portfolio migration and conservative margin accounting.

Legacy single-position JSON is upgraded atomically and never silently discarded.
This module does not place exchange orders.
"""
from symbol_config import ALLOWED_SYMBOLS


def positions_for_display(state):
    if "paper_positions" not in state:
        legacy=state.get("trade")
        if not legacy:
            return {}
        if not isinstance(legacy,dict) or not legacy.get("paper"):
            raise ValueError("Legacy position is not a paper trade")
        symbol=legacy.get("symbol")
        if symbol not in ALLOWED_SYMBOLS:
            raise ValueError("Unsupported legacy paper symbol")
        return {symbol:legacy}
    positions=state["paper_positions"]
    if not isinstance(positions,dict):
        raise ValueError("Invalid paper positions ledger")
    if state.get("trade"):
        raise ValueError("Conflicting legacy and portfolio positions: manual review required")
    for symbol,trade in positions.items():
        if symbol not in ALLOWED_SYMBOLS or not isinstance(trade,dict):
            raise ValueError("Unexpected paper position key")
        if trade.get("symbol")!=symbol or trade.get("paper") is not True:
            raise ValueError("Corrupt paper position, refusing to discard")
    return positions


def migrate_paper_state(state,save):
    if "paper_positions" in state:
        positions_for_display(state)
        if not isinstance(state.get("last_signals"),dict):
            raise ValueError("Invalid per-symbol signal journal")
        return
    positions=positions_for_display(state)
    previous=state.get("last_signal")
    last_signals={}
    if isinstance(previous,str):
        symbol=previous.split("-",1)[0]
        if symbol in ALLOWED_SYMBOLS:
            last_signals[symbol]=previous
    state["paper_positions"]=dict(positions)
    state["last_signals"]=last_signals
    state["trade"]=None
    # Keep history, balance, last_exit, and previous signal for audit.
    save(state)


def reserved_margin(positions,default_leverage):
    total=0.0
    for trade in positions.values():
        previous=trade.get("margin_reserved")
        if previous is None:
            leverage=trade.get("leverage") or default_leverage
            previous=float(trade["entry"])*float(trade["qty"])/float(leverage)
        reserved=float(previous)
        if not (0<=reserved<float("inf")):
            raise ValueError("Invalid reserved margin")
        total+=reserved
    return total
