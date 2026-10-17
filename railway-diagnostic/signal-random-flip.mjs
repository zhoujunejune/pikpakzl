// Pure signal-output transform. Prediction, training and order-side mapping stay untouched.
// A deterministic 50/50 cryptographic draw avoids changing the same round after
// Redis/WebSocket/HTTP retries, page refreshes, or a Railway restart.
import crypto from 'node:crypto';
import {BASE_MODEL,NOVICE_MODEL} from './production-signal-choice.mjs';

export const SIGNAL_RANDOM_FLIP_VERSION='OUTPUT_RANDOM_FLIP_50_V1';
const VALID_MODELS=new Set([BASE_MODEL,NOVICE_MODEL]);
const SIDES=new Set(['UP','DOWN']);
export function shouldFlipSignal(model,round){
  if(!VALID_MODELS.has(model)||!Number.isSafeInteger(round)||round<=0||round%300000!==0)
    throw Error('INVALID_RANDOM_FLIP_IDENTITY');
  const digest=crypto.createHash('sha256')
    .update(SIGNAL_RANDOM_FLIP_VERSION+'|'+model+'|'+round,'utf8').digest();
  return (digest[0]&1)===1;
}
export function applyRandomSignalFlip(signal,selectedModel){
  if(!signal||signal.status!=='LOCKED')return signal;
  if(!SIDES.has(signal.direction))throw Error('INVALID_RANDOM_FLIP_DIRECTION');
  if(signal.randomFlipVersion===SIGNAL_RANDOM_FLIP_VERSION)return signal; // idempotent
  if(signal.randomFlipVersion)throw Error('SIGNAL_FLIP_VERSION_CONFLICT');
  const flip=shouldFlipSignal(selectedModel,Number(signal.round));
  return {...signal,rawDirection:signal.direction,
    direction:flip?(signal.direction==='UP'?'DOWN':'UP'):signal.direction,
    randomFlipApplied:flip,randomFlipProbability:0.5,
    randomFlipVersion:SIGNAL_RANDOM_FLIP_VERSION};
}
