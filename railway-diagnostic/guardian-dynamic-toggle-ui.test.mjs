import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {injectGuardianMainDashboard} from './guardian-main-dashboard.mjs';
import {validatedRiskConfig} from './risk-config-storage.mjs';

const read=name=>fs.readFileSync(new URL('./'+name,import.meta.url),'utf8');
const control=read('control-shell.mjs');
const runner=read('risk-runner.mjs');

test('Guardian card has an accessible real switch, PIN input and explicit runtime state',()=>{
 const page='<html><body><section class="c" id="roundResultsOnlyCard" style="margin:14px 0">OLD</section></body></html>';
 const out=injectGuardianMainDashboard(page);
 for(const phrase of ['id="zlGuardianRiskSwitchCard"','id="zlGRiskToggleButton"',
                      'id="zlGRiskTogglePin"','/api/guardian-dynamic-risk',
                      'window.zlGuardianToggleRisk','d.effectiveEnabled']){
  assert.ok(out.includes(phrase),phrase);
 }
 assert.equal((out.match(/id="zlGuardianRiskSwitchCard"/g)||[]).length,1);
 assert.equal(injectGuardianMainDashboard(out),out);
 const script=out.match(/<script>([\s\S]*?)<\/script>/);
 assert.ok(script);new vm.Script(script[1]);
});

test('new risk preference defaults OFF and does not alter prior TP/SL settings',()=>{
 const base={takeProfitEnabled:true,takeProfitPercent:95,
  stopLossEnabled:false,stopLossPercent:85,updatedAt:new Date().toISOString()};
 const old=validatedRiskConfig(base);
 assert.equal(old.guardianDynamicEnabled,false);
 assert.equal(old.takeProfitEnabled,true);assert.equal(old.stopLossEnabled,false);
 const yes=validatedRiskConfig({...base,guardianDynamicEnabled:true});
 assert.equal(yes.guardianDynamicEnabled,true);
 assert.equal(yes.stopLossPercent,85);
 assert.throws(()=>validatedRiskConfig({...base,guardianDynamicEnabled:'true'}),/INVALID_GUARDIAN_RISK_SWITCH/);
});

test('only guardian-specific POST can change the Guardian preference',()=>{
 assert.match(control,/url\.pathname === '\/api\/guardian-dynamic-risk'/);
 assert.match(control,/if \(!pinOK\(body\.pin\)\)/);
 assert.match(control,/typeof body\.enabled!=='boolean'/);
 assert.match(control,/body\.enabled && !guardianRiskToggleStatus\(\)\.canEnable/);
 assert.match(control,/guardianDynamicEnabled: current\.guardianDynamicEnabled, \/\/ dedicated authenticated Guardian route only/);
 assert.match(control,/guardianDynamicEnabled:body\.enabled/);
 assert.match(control,/persistenceReady&&persistenceHealthy/);
 assert.match(control,/guardian-sell-execution-verified\.json/);
 assert.match(control,/realSellConfirmed===true/);
 assert.match(control,/unknownSellReconciled===true/);
 assert.match(control,/riskRestartTested===true/);
});

test('the live flag is taken from worker evidence, not GUI intention',()=>{
 assert.match(control,/const effectiveEnabled=Boolean\(live\)/);
 assert.match(control,/runtime\?\.guardianDynamicExitEnabled===true/);
 assert.match(control,/heart\?\.enabled===true/);
 assert.match(control,/requestedEnabled\?'PENDING_NOT_VERIFIED':'OFF'/);
});

test('risk runner defaults to off, uses an explicit approval and retains accepted positions',()=>{
 assert.match(runner,/GUARDIAN_UI_APPROVED=process\.env\.GUARDIAN_RISK_UI_ENABLE_APPROVED==='true'/);
 assert.match(runner,/guardianDynamicEnabled:false/);
 assert.match(runner,/GUARDIAN_UI_APPROVED&&cfg\?\.guardianDynamicEnabled===true/);
 assert.match(runner,/previousGuardianActive&&guardianOpenExposure\(\)/);
 assert.match(runner,/GUARDIAN_DYNAMIC_EXIT_ENABLED: effectiveGuardian\(cfg\)\?'true':'false'/);
 assert.match(runner,/guardianOpenPositionsRetained/);
});
