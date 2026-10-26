import test from 'node:test';
import assert from 'node:assert/strict';
import {injectFast5Dashboard} from './fast5-dashboard-inject.mjs';
const html='<!doctype html><html><body><section class="c" id="roundResultsOnlyCard" style="margin:14px 0">old</section>'+
'<div id="round">-</div><div id="status">-</div><div id="direction">-</div>'+
'<div id="orderDirection">-</div><div id="score">-</div><div id="tradeControls">control</div></body></html>';
test('shows last FAST5 lock on legacy trade card only as non-executable history',()=>{
 const rendered=injectFast5Dashboard(html);
 assert.match(rendered,/function renderTradeTilesSnapshot\(state,trade,now,round,signal\)/);
 assert.match(rendered,/if\(trade.signal&&trade.signal.status==='LOCKED'\)return/);
 assert.match(rendered,/已锁定 · 下单窗口结束（不可补单）/);
 assert.match(rendered,/参考；未提交/);
 assert.match(rendered,/5秒内未锁定，不下单/);
 assert.match(rendered,/renderTradeTilesSnapshot\(s,t,now,round,signal\)/);
 assert.match(rendered,/下单金额未配置/);
 assert.match(rendered,/id="tradeControls"/);
 assert.match(rendered,/\/api\/fast5-round-stats/);
 assert.match(rendered,/\/api\/fast5-direction-mode/);
 assert.doesNotMatch(rendered,/method:'POST'.*?renderTradeTilesSnapshot/s);
});
test('no duplicate panel or trading controls after second inject',()=>{
 const once=injectFast5Dashboard(html);
 assert.equal(injectFast5Dashboard(once),once);
});
