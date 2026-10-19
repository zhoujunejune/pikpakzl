import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {initialOffDirectionModes,applyDirectionSettings,directionSettingsSnapshot,
 mappedOrderSignal,ORDER_SOURCES,ORDER_MODE_REDIS_KEY} from './order-direction-policy.mjs';

test('no previous mode configuration defaults to all OFF, never authorizes an order',()=>{
 const modes=initialOffDirectionModes();
 assert.equal(Object.keys(modes).length,3);
 assert.deepEqual(Object.values(modes).map(x=>x.UP),['OFF','OFF','OFF']);
 assert.deepEqual(Object.values(modes).map(x=>x.DOWN),['OFF','OFF','OFF']);
 applyDirectionSettings({modes,revision:'init-1'});
 for(const source of ORDER_SOURCES)for(const direction of ['UP','DOWN']){
  const locked={status:'LOCKED',direction,source,executionEligible:true,round:1792387800000};
  assert.equal(mappedOrderSignal(locked).orderSignal,null);
  assert.equal(mappedOrderSignal(locked).action,null);
 }
 assert.equal(ORDER_MODE_REDIS_KEY,'trade-control:direction-mode:v4');
});

test('each independently confirmed source and direction can map forward, inverse or off',()=>{
 for(const source of ORDER_SOURCES)for(const direction of ['UP','DOWN']){
  for(const mode of ['FORWARD','INVERSE','OFF']){
   const modes=initialOffDirectionModes();
   modes[source][direction]=mode;
   applyDirectionSettings({modes,revision:'mode-'+source.slice(0,3)+direction+mode});
   const locked={status:'LOCKED',source,direction,round:1792387800000};
   const out=mappedOrderSignal(locked);
   assert.equal(out.orderSignal,mode==='OFF'?null:mode==='FORWARD'?direction:direction==='UP'?'DOWN':'UP');
   assert.equal(out.mappingMode,mode);
  }
 }
});

test('POST direction uses Caddy authenticated same-origin login, not obsolete PIN field',()=>{
 const index=fs.readFileSync(new URL('./index.mjs',import.meta.url),'utf8');
 const panel=fs.readFileSync(new URL('./panel-stats-shell.mjs',import.meta.url),'utf8');
 const policy=fs.readFileSync(new URL('./order-direction-policy.mjs',import.meta.url),'utf8');
 const start=index.indexOf("if (req.method === 'POST' && url.pathname === '/api/direction-mode')");
 assert.ok(start>0);
 const route=index.slice(start,start+1700);
 assert.match(route,/ZL_OUTER_AUTH_ONLY/);
 assert.match(route,/pinOK\(null,req\)/);
 assert.doesNotMatch(route,/pinOK\(body\.pin/);
 assert.match(panel,/window\.confirm\('将 '/);
 assert.match(panel,/data-dir-mode/);
 assert.match(panel,/\['FORWARD','INVERSE','OFF'\]\.map/);
 assert.match(panel,/body:JSON\.stringify\(\{source:src\.id,direction:side,mode:mode,expectedRevision:revision\}\)/);
 assert.doesNotMatch(panel,/var pin=e\('pin'\)/);
 assert.match(policy,/db\.set\(ORDER_MODE_REDIS_KEY,proposed,\{NX:true\}\)/);
 assert.match(policy,/modes=initialOffDirectionModes\(\)/);
});
