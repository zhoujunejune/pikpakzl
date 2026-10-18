// One-time Render FREE preview initializer. Never enable in real trading.
// This module only seeds missing, explicitly DISABLED settings on an ephemeral Render Key Value.
// Atomic NX writes ensure it will never overwrite a migrated or user-edited setting.
import crypto from 'node:crypto';
import { createClient } from 'redis';

if (process.env.RENDER_MIGRATION_PREVIEW === 'true') {
  if (process.env.AUTO_CONFIRM_ENABLED !== 'false') {
    throw Error('RENDER_PREVIEW_REQUIRES_AUTO_CONFIRM_DISABLED');
  }
  if (process.env.BINANCE_PREDICTION_API_KEY || process.env.BINANCE_PREDICTION_API_SECRET) {
    throw Error('RENDER_PREVIEW_DISALLOWS_TRADING_CREDENTIALS');
  }
  const url = String(process.env.SIGNAL_REDIS_URL || '').trim();
  if (!url) throw Error('RENDER_PREVIEW_REDIS_MISSING');
  const db = createClient({url, socket:{connectTimeout:4000,reconnectStrategy:()=>false}});
  db.on('error', ()=>{});
  await db.connect();
  try {
    const ts=new Date().toISOString();
    const sources=[
      'SELECTIVE_V2_FAST8_PRIMARY',
      'EDGE_RESCUE_FAST8_PRIMARY',
      'SELECTIVE_V2_FAST8_UNVERIFIED_DIRECTION'
    ];
    const modes=Object.fromEntries(sources.map(k=>[k,{UP:'OFF',DOWN:'OFF'}]));
    const direction={modes,revision:crypto.randomUUID(),updatedAt:ts,effectiveAfterRound:null};
    const disabledRisk={takeProfitEnabled:false,takeProfitPercent:50,
      stopLossEnabled:false,stopLossPercent:50,updatedAt:ts};
    const directionNew=await db.set('trade-control:direction-mode:v4',JSON.stringify(direction),{NX:true});
    const riskNew=await db.set('trade-control:risk-config:v1',JSON.stringify(disabledRisk),{NX:true});
    // production-signal-choice.mjs seeds BASELINE itself on first refresh.
    console.log(JSON.stringify({event:'render_preview_configs_checked',
      directionCreated:directionNew==='OK',riskCreated:riskNew==='OK',
      defaultDirectionMode:'OFF',autoOrder:false}));
  } finally {
    await db.quit();
  }
}
