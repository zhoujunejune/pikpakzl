import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const base=new URL('./',import.meta.url);
const page=fs.readFileSync(new URL('index.mjs',base),'utf8');
const control=fs.readFileSync(new URL('control-shell.mjs',base),'utf8');
const stats=fs.readFileSync(new URL('panel-stats-shell.mjs',base),'utf8');
const wallet='<div class="c"><div class="k">Prediction 可用余额';
const card='<div class="c" id="tradeInputsCard">';
const anchor='<div id="riskControlsAnchor"></div>';
const each=(s,x)=>(s.split(x).length-1);

test('amount and PIN are directly beneath wallet, before round/status and order history',()=>{
 const walletAt=page.indexOf(wallet);
 const amountAt=page.indexOf('<input id="amount"');
 const pinAt=page.indexOf('<input id="pin"');
 const cardAt=page.indexOf(card);
 const statusAt=page.indexOf('<div class="c"><div class="grid">');
 const orderAt=page.indexOf('<div class="c pending">');
 const anchorAt=page.indexOf(anchor);
 assert.ok(walletAt>=0&&walletAt<cardAt,'trade control card follows wallet');
 assert.ok(cardAt<amountAt&&amountAt<pinAt,'amount then PIN inside the same card');
 assert.ok(pinAt<statusAt&&statusAt<orderAt&&orderAt<anchorAt,'no scrolling to bottom for amount/PIN');
 assert.equal(each(page,card),1);
 assert.equal(each(page,'<input id="amount"'),1);
 assert.equal(each(page,'<input id="pin"'),1);
 assert.equal(each(page,anchor),1);
 assert.ok(page.includes('onclick="setV(true)"'));
 assert.ok(page.includes('onclick="setV(false)"'));
 assert.ok(page.includes('onclick="checkEgressIp()"'));
 assert.ok(page.includes('id="egressProbeResult"'));
});

test('risk and model statistics panels inject using stable anchor, not moved amount field',()=>{
 assert.ok(control.includes("const marker = '<div id=\"riskControlsAnchor\"></div>';"));
 assert.ok(stats.includes("const marker = '<div id=\"riskControlsAnchor\"></div>';"));
 assert.ok(control.includes('$'+'{riskCards}'+'$'+'{marker}'));
 assert.ok(stats.includes('${primaryCard}${statsCard}${shadowCard}${marker}'));
 assert.ok(!control.includes("const marker = '<div class=\"c\"><input id=\"amount\"'"));
 assert.ok(!stats.includes("const marker = '<div class=\"c\"><input id=\"amount\"'"));
});

test('actual two-stage page injection keeps trade inputs near wallet and risk panel below order results',()=>{
 const start=page.indexOf(wallet);
 const finish=page.indexOf('</div><script>',start);
 assert.ok(start>=0&&finish>start,'extract HTML page body fragment');
 const html='<body>'+page.slice(start,finish)+'</div></body>';
 const controlBegin=control.indexOf('function injectRiskControls(html) {');
 const controlEnd=control.indexOf('\nlet inner = null;',controlBegin);
 const statsBegin=stats.indexOf('function injectStats(html) {');
 const statsEnd=stats.indexOf('\nlet child = null;',statsBegin);
 assert.ok(controlBegin>=0&&controlEnd>controlBegin);
 assert.ok(statsBegin>=0&&statsEnd>statsBegin);
 const injectRisk=vm.runInNewContext(control.slice(controlBegin,controlEnd)+'\ninjectRiskControls',{
  riskCards:'<section id="riskCardsMock"></section>',riskScript:'<script id="riskScriptMock"></script>'
 });
 const injectStats=vm.runInNewContext(stats.slice(statsBegin,statsEnd)+'\ninjectStats',{
  layoutStabilityStyle:'<style id="dashboard-layout-stability"></style>',
  primaryCard:'<section id="primaryMock"></section>',
  statsCard:'<section id="statsMock"></section>',
  shadowCard:'<section id="shadowMock"></section>',
  shadowScript:'<script id="shadowScriptMock"></script>',
  statsScript:'<script id="statsScriptMock"></script>',
  primaryScript:'<script id="primaryScriptMock"></script>'
 });
 const result=injectStats(injectRisk(html));
 const at=x=>result.indexOf(x);
 assert.ok(at('walletBalance')<at('tradeInputsCard'));
 assert.ok(at('tradeInputsCard')<at('pendingTitle'));
 assert.ok(at('pendingTitle')<at('riskCardsMock'));
 assert.ok(at('riskCardsMock')<at('primaryMock'));
 assert.ok(at('primaryMock')<at('riskControlsAnchor'));
 assert.equal(each(result,'tradeInputsCard'),1);
 assert.equal(each(result,'riskCardsMock'),1);
 assert.equal(each(result,'statsMock'),1);
 assert.equal(each(result,'shadowMock'),1);
});


test('mobile model statistics have non-expanding columns and a single raw-signal writer',()=>{
 assert.match(stats,/grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
 assert.match(stats,/out = out\.replace\('<\/head>', layoutStabilityStyle\+'<\/head>'\)/);
 const orderPoll=stats.slice(stats.indexOf('function updateOrderSignal(){'),stats.indexOf('\nfunction boot(){',stats.indexOf('function updateOrderSignal(){'));
 assert.doesNotMatch(orderPoll,/activeFast8Direction'\)\.textContent/);
});
