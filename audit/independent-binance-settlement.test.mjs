import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
const script=new URL('./independent-binance-settlement.mjs',import.meta.url);
test('rejects missing credentials before any network access',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'settlement-audit-'));
 try{
  const input=path.join(dir,'rounds.json');fs.writeFileSync(input,'[]');
  const env={...process.env};delete env.BINANCE_PREDICTION_API_KEY;delete env.BINANCE_PREDICTION_API_SECRET;
  const r=spawnSync(process.execPath,[script.pathname,input],{env,encoding:'utf8'});
  assert.notEqual(r.status,0);
  assert.match(r.stderr,/Missing read-only Binance prediction API credentials/);
 }finally{fs.rmSync(dir,{recursive:true,force:true})}
});
