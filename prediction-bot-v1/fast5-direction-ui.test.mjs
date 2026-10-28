import test from 'node:test';
import assert from 'node:assert/strict';
import {injectFast5Dashboard} from './fast5-dashboard-inject.mjs';
const sample='<!doctype html><html><head></head><body>'+
 '<section class="c" id="roundResultsOnlyCard" style="margin:14px 0">legacy</section>'+
 '<section id="tradeControls">order settings</section></body></html>';
test('owner has one unified FAST5 positive or inverse order direction toggle',()=>{
 const html=injectFast5Dashboard(sample);
 assert.match(html,/id="zlF5Forward"/);
 assert.match(html,/id="zlF5Inverse"/);
 assert.match(html,/\/api\/fast5-direction-mode/);
 assert.match(html,/UP买DOWN、DOWN买UP/);
 assert.match(html,/NEXT_ROUND|下一轮开始/);
 assert.match(html,/expectedRevision:f5Direction.revision/);
 assert.match(html,/mode:mode/);
});
test('do not alter original predictive direction, win-rate data or other controls',()=>{
 const html=injectFast5Dashboard(sample);
 assert.match(html,/\/api\/fast5-round-stats/);
 assert.match(html,/FAST5 独立统计面板/);
 assert.match(html,/下单方向开关/);
 assert.match(html,/id="tradeControls"/);
 assert.match(html,/t.enabled===true/);
 assert.ok(!html.includes('id="roundResultsOnlyCard"'));
 assert.equal(injectFast5Dashboard(html),html);
});
test('mode read is non-mutating, explicit POST only on click and no implicit activation',()=>{
 const html=injectFast5Dashboard(sample);
 assert.match(html,/void loadF5Direction\(\)/);
 assert.match(html,/setInterval\(loadF5Direction,15000\)/);
 assert.match(html,/if\(f5Direction.busy\|\|!f5Direction.revision/);
 assert.match(html,/a.disabled=b.disabled=f5Direction.busy\|\|!f5Direction.revision/);
 assert.match(html,/if\(mode===f5Direction.mode\)/);
 assert.match(html,/method:'POST'/);
});
