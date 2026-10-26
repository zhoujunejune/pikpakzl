import test from 'node:test';
import assert from 'node:assert/strict';
import {injectFast5Dashboard} from './fast5-dashboard-inject.mjs';

const html='<!doctype html><html><body><section class="c" id="roundResultsOnlyCard" style="margin:14px 0">old results</section>'+
'<section class="c" id="tradeInputsCard">existing trade controls</section>'+
'<script>var rrMeta=1;var old="/api/deepseek-round-results?limit=20";</script>'+
'<script>function keepControls(){return true}</script></body></html>';
test('replaces retired DeepSeek status with FAST5 while keeping trade controls',()=>{
 const out=injectFast5Dashboard(html);
 assert.ok(out.includes('id="zlFast5Card"'));
 assert.ok(out.includes('FAST5 V5 15分钟波动分层'));
 assert.ok(out.includes('/api/fast5-live-status'));
 assert.ok(out.includes('id="tradeInputsCard"'));
 assert.ok(out.includes('keepControls'));
 assert.ok(!out.includes('roundResultsOnlyCard'));
 assert.ok(!out.includes('api/deepseek-round-results'));
 assert.ok(!out.includes('/deepseek/api/status'));
});
test('no duplicate panel injection',()=>{
 const once=injectFast5Dashboard(html);
 assert.equal(injectFast5Dashboard(once),once);
});
test('never claims winrate or fills stats with DeepSeek records',()=>{
 const out=injectFast5Dashboard(html);
 assert.match(out,/V5版本独立统计，从版本切换后重新累计/);
 assert.match(out,/FAST5 独立统计面板/);
 assert.match(out,/zlF5StatAccuracy/);
 assert.match(out,/zlF5OfficialRows/);
 assert.match(out,/FAST5逐轮信号与官方结算/);
 assert.ok(!out.includes('57.27%'));
 assert.ok(out.includes('/api/fast5-round-stats'));
 assert.ok(!out.includes('未关联FAST5'));
 assert.match(out,/信号不是成交回报/);
 assert.match(out,/交易窗口已过/);
});
