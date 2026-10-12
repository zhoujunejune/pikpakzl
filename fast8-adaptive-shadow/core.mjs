// The complete policy is fixed before prospective collection starts. No abstention.
export const VERSION = 'ZL_FAST8_65';
export const POLICY = 'FAST8_FULL_COVERAGE_LOGISTIC_V2';
export const ROUND_MS = 300000;
// Leave six seconds for a slow durable volume and the parent publication queue.
export const CUTOFF_MS = 1500;
export const LOCK_MS = 2000;
export const DEADLINE_MS = 8000;
export const MIN_TRAINING = 300;
export const FEATURES = [
  ['currentScore', 1], ['currentTrendScore', 1], ['microScore', 1],
  ['regimeScore', 1], ['liveScore', 1], ['distanceFromOpenBps', 10],
  ['normalizedMomentum5s', 1], ['normalizedMomentum15s', 1],
  ['normalizedMomentum60s', 1], ['normalizedMomentum180s', 1],
  ['normalizedMomentum300s', 1], ['tradePressure15s', 1],
  ['tradePressure60s', 1], ['ofiNormalized5s', 1],
  ['rangePosition180', 1], ['predictionMarketUpMid', 1], ['spreadBps', 5],
];
export const finite = n => typeof n === 'number' && Number.isFinite(n);
export const isDirection = d => d === 'UP' || d === 'DOWN';
export const sigmoid = n => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, n))));

export function featureVector(features = {}) {
  const values = [], missing = [];
  for (const [key, scale] of FEATURES) {
    const present = finite(features[key]);
    let value = present ? features[key] : 0;
    if (present && (key === 'predictionMarketUpMid' || key === 'rangePosition180')) value = (value - 0.5) * 2;
    values.push(Math.max(-5, Math.min(5, value / scale)));
    missing.push(present ? 0 : 1);
  }
  // Fixed transformations: no future normalization statistics or fitted imputers.
  return [...values, ...missing, values[0] * values[3], values[2] * values[3]];
}

export function probability(weights, x) {
  if (!Array.isArray(weights) || weights.length !== x.length + 1 || !weights.every(finite)) return null;
  const score = weights[0] + x.reduce((sum, value, i) => sum + value * weights[i + 1], 0);
  return finite(score) ? sigmoid(score) : null;
}

function fit(samples) {
  const weights = new Array(samples[0].x.length + 1).fill(0);
  for (let epoch = 0; epoch < 160; epoch++) {
    const gradient = new Array(weights.length).fill(0);
    for (const { x, y } of samples) {
      const error = probability(weights, x) - y;
      gradient[0] += error;
      for (let j = 0; j < x.length; j++) gradient[j + 1] += error * x[j];
    }
    for (let j = 0; j < weights.length; j++) {
      weights[j] -= 0.06 * (gradient[j] / samples.length + (j ? 0.02 * weights[j] : 0));
    }
  }
  return weights;
}

export function trainFast8(samples) {
  if (samples.length < MIN_TRAINING || samples.some(s => !Array.isArray(s.x) ||
      s.x.length !== FEATURES.length * 2 + 2 || !s.x.every(finite) || ![0, 1].includes(s.y))) {
    throw new Error('INVALID_TRAINING_ROWS');
  }
  const ordered = [...samples].sort((a, b) => a.roundStartMs - b.roundStartMs);
  const split = Math.floor(ordered.length * 0.8);
  const validation = ordered.slice(split);
  // Labels for a training row must have existed before the first holdout decision.
  const train = ordered.slice(0, split).filter(s => s.labelReceivedAt < validation[0].decisionAt);
  if (train.length < 100) throw new Error('INSUFFICIENT_TEMPORAL_TRAINING');
  const candidate = fit(train);
  let hits = 0, baselineHits = 0, brier = 0;
  for (const s of validation) {
    const p = probability(candidate, s.x);
    hits += Number(Number(p >= 0.5) === s.y);
    baselineHits += Number(s.baseline === (s.y ? 'UP' : 'DOWN'));
    brier += (p - s.y) ** 2;
  }
  const holdout = { samples: validation.length, hits, accuracy: hits / validation.length,
    baselineHits, baselineAccuracy: baselineHits / validation.length,
    brier: brier / validation.length, coverage: 1, evidence: 'TEMPORAL_HOLDOUT_NOT_FORWARD' };
  return { accepted: hits >= baselineHits && holdout.brier < 0.26,
    weights: fit(ordered), trainingSamples: ordered.length, holdout,
    trainingThroughRound: ordered.at(-1).roundStartMs,
    trainingLabelsReceivedThrough: Math.max(...ordered.map(s => s.labelReceivedAt)) };
}


/* Standalone adaptive shadow extensions. Does NOT run or mutate the production router. */
export const ADAPTIVE_VERSION='ZL_FAST8_ADAPTIVE_SHADOW_V1';
export const ADAPTIVE_FEATURES=FEATURES.map(v=>v[0]);
const avg=xs=>xs.reduce((a,b)=>a+b,0)/Math.max(1,xs.length);
const clip=(x,a,b)=>Math.min(b,Math.max(a,x));
export function observeCandles(candles){
  if(!Array.isArray(candles)||candles.length<16)return null;
  const bars=candles.slice(-16).map(c=>({open:+c[1],high:+c[2],low:+c[3],close:+c[4],volume:+c[5],quote:+c[7],buy:+c[9]}));
  if(!bars.every(b=>Object.values(b).every(finite)&&b.close>0&&b.volume>=0))return null;
  const last=bars.at(-1),closes=bars.map(b=>b.close),volumes=bars.map(b=>b.volume);
  const mom=n=>(last.close/closes[closes.length-1-n]-1)*1000;
  const returns=closes.slice(1).map((c,i)=>Math.log(c/closes[i]));
  const volatility=Math.sqrt(avg(returns.map(r=>r*r)))*1000;
  const travel=closes.slice(1).reduce((sum,c,i)=>sum+Math.abs(c-closes[i]),0);
  const efficiency=travel?Math.abs(last.close-closes[0])/travel:0;
  const five=bars.slice(-5),top=Math.max(...five.map(b=>b.high)),bottom=Math.min(...five.map(b=>b.low));
  const m1=mom(1),m3=mom(3),m5=mom(5);
  const regime=volatility>3?'HIGH_VOL':efficiency>.42&&Math.abs(m5)>.35?'TREND':'RANGE';
  // Only fill signals actually derivable from public 1m candles. Do not mislabel 1m as 5s or 15s data.
  const facts={currentTrendScore:clip(m5/4,-5,5),currentScore:clip(m1/4,-5,5),
    regimeScore:clip(efficiency*2-1,-1,1),distanceFromOpenBps:clip(m1*10,-50,50),
    normalizedMomentum60s:clip(m1,-5,5),normalizedMomentum180s:clip(m3,-5,5),
    normalizedMomentum300s:clip(m5,-5,5),rangePosition180:top>bottom?clip((last.close-bottom)/(top-bottom),0,1):.5,
    tradePressure60s:last.volume?clip(2*last.buy/last.volume-1,-1,1):0};
  return {facts,regime,baseline:m1>0?'UP':m1<0?'DOWN':m5>=0?'UP':'DOWN',
    featureCount:Object.values(facts).filter(finite).length,
    momentum60s:m1,volatility,efficiency};
}
export function adaptiveProbability(model,features,regime){
  const weights=model?.regimes?.[regime]??model?.global;
  return weights?probability(weights,featureVector(features)):null;
}
export function adaptiveDrift(rows){
  const s=rows.filter(r=>[0,1].includes(r.y)&&['UP','DOWN'].includes(r.signal)).slice(-200);
  if(s.length<160)return false;
  const h=r=>Number(r.signal===(r.y?'UP':'DOWN'));
  return avg(s.slice(-60).map(h))<.54&&avg(s.slice(0,100).map(h))-avg(s.slice(-60).map(h))>=.12;
}
export function trainAdaptive(rows){
  const clean=rows.filter(r=>r&&Array.isArray(r.x)&&r.x.length===FEATURES.length*2+2&&
    r.x.every(finite)&&[0,1].includes(r.y)&&finite(r.roundStartMs)&&finite(r.decisionAt)&&
    finite(r.labelReceivedAt)&&r.labelReceivedAt>r.decisionAt&&['UP','DOWN'].includes(r.baseline))
    .sort((a,b)=>a.roundStartMs-b.roundStartMs).slice(-2000);
  if(clean.length<MIN_TRAINING)throw Error('NEED_300_ELIGIBLE');
  // Existing trainFast8 performs chronological 80/20 validation plus label-time purging.
  const globalResult=trainFast8(clean);
  const regimes={},tests={global:globalResult.holdout};
  let accepted=globalResult.accepted;
  if(accepted)regimes.global=globalResult.weights;
  for(const name of ['TREND','RANGE','HIGH_VOL']){
    const data=clean.filter(r=>r.regime===name);
    if(data.length<300)continue;
    const result=trainFast8(data);
    tests[name]=result.holdout;
    if(result.accepted){regimes[name]=result.weights;accepted=true;}
  }
  return {accepted,weights:accepted?{global:regimes.global??null,regimes:Object.fromEntries(
    ['TREND','RANGE','HIGH_VOL'].filter(k=>regimes[k]).map(k=>[k,regimes[k]]))}:null,
    holdouts:tests,trainingSamples:clean.length,trainingThroughRound:clean.at(-1).roundStartMs};
}
