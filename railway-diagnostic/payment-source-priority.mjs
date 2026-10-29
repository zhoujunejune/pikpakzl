// Only two debit sources are authorized: Prediction wallet (MPC) first,
// then Spot (CEX), NEVER Funding. Binance payment-options lists CEX accounts
// and is not a reliable balance check for the separate Prediction wallet.
export const PAYMENT_PRIORITY = Object.freeze(['MPC','SPOT']);
export function predictionWalletPayment() {
  return { displayAccount:'Prediction Wallet', accountType:'SPOT', fundingSource:'MPC' };
}
export function eligibleSpotFallback(balance, amount) {
  if (balance?.ok !== true) return null;
  const requested = Number(amount);
  if (!Number.isFinite(requested) || requested <= 0) return null;
  const accounts = Array.isArray(balance.items) ? balance.items : [];
  const spot = accounts.find(item => item?.enabled === true &&
    String(item.accountType).toUpperCase() === 'SPOT' &&
    Number.isFinite(Number(item.availableBalanceDisplay)) &&
    Number(item.availableBalanceDisplay) >= requested);
  return spot ? {displayAccount:'SPOT', accountType:'SPOT', fundingSource:'CEX'} : null;
}
// Only a clear Binance 4xx no-order insufficient-funds rejection is safe
// for switching source. Never retry timeout, HTTP 5xx, 451 or unknown states.
export function explicitMpcInsufficient(call) {
  if (!call || call.ok === true || call.network === true) return false;
  const status=Number(call.status ?? call.httpStatus);
  if (![400,409,422].includes(status)) return false;
  const message=String(call.data?.msg ?? call.data?.message ?? call.error ?? '').toLowerCase();
  // Binance Prediction quote HTTP 400 / -9000: MPC funds are unavailable.
  // Exact message and code only; never treat unrelated -9000, network, 5xx or 451 as safe fallback.
  if (Number(call.code ?? call.data?.code) === -9000 &&
      /^please ensure your account has enough usdt\.?$/.test(message.trim())) return true;
  return /insufficient.{0,70}(?:balance|funds?|usdt)|(?:balance|funds?).{0,70}insufficient|not enough.{0,30}(?:balance|funds?|usdt)|(?:可用余额|账户余额|余额).{0,10}(?:不足|不够)/.test(message);
}
