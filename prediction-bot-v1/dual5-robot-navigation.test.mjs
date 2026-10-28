import test from 'node:test';
import assert from 'node:assert/strict';
import {robotMenuHtml,injectRobotMenu} from './dual5-robot-navigation.mjs';
test('exposes clickable third independent robot in primary dashboard menu',()=>{
 const html='<html><body><div class="w"><h2>5分钟预测</h2></div></body></html>';
 const next=injectRobotMenu(html);
 assert.match(next,/id="zlRobotMenu"/);
 assert.match(next,/href="\/dual5" id="zlDual5RobotLink"/);
 assert.match(next,/5分钟UP\+DOWN双边/);
 assert.match(next,/5分钟趋势预测/);
 assert.match(next,/href="\/api-keys\/"/);
 assert.ok(next.indexOf('id="zlRobotMenu"')<next.indexOf('<h2>5分钟预测'));
 assert.equal(injectRobotMenu(next),next);
});
test('does not alter buttons, buy controls or order logic',()=>{
 const html='<html><body><div class="w"><button id="startFollow">开始跟随</button></div></body></html>';
 const next=injectRobotMenu(html);
 assert.match(next,/id="startFollow"/);
 assert.ok(!robotMenuHtml.includes('fetch('));
 assert.ok(!robotMenuHtml.includes('onclick='));
 assert.ok(!robotMenuHtml.includes('<script'));
});
test('provides fallback if root wrapper markup differs and safe no-op if unstructured',()=>{
 assert.match(injectRobotMenu('<html><body><p>hello</p></body></html>'),/id="zlRobotMenu"/);
 assert.equal(injectRobotMenu('unstructured'),'unstructured');
});
