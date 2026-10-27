import test from 'node:test';
import assert from 'node:assert/strict';
import {injectDual5RobotMenu} from './dual5-menu-nav.mjs';
test('show FAST5 and UP DOWN menu as topmost visible links inside mobile control container',()=>{
 const s=injectDual5RobotMenu('<!doctype html><html><head></head><body><div class="w"><h2>5分钟 API 实盘确认控制台</h2></div></body></html>');
 assert.ok(s.includes('href="/dual5"'));assert.ok(s.includes('id="dual5RobotMenu"'));
 assert.ok(s.indexOf('id="dual5RobotMenu"')<s.indexOf('<h2>5分钟'));
 assert.ok(s.includes('UP + DOWN 双边机器人'));
 assert.ok(s.includes('href="/"'));
 assert.equal(injectDual5RobotMenu(s),s,'refresh or nested injection must not duplicate menu');
});
test('do not add hidden or forced trading actions',()=>{
 const s=injectDual5RobotMenu('<html><body><div class="w"></div></body></html>');
 assert.ok(!s.includes('/api/dual5-arm'));
 assert.ok(!s.includes('method="POST"'));
 assert.ok(!s.includes('display:none'));
});
test('does not rewrite unrelated pages',()=>{
 assert.equal(injectDual5RobotMenu('not html'),'not html');
});
