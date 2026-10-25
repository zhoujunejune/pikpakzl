import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {injectAi40Dashboard} from './ai40-dashboard-inject.mjs';
const card='<section class="c" id="roundResultsOnlyCard" style="margin:14px 0">旧版5秒数据</section>';
const base='<html><body><main>原实盘按钮与菜单</main>'+card+'</body></html>';
test('inject a dedicated DeepSeek 120/15/40/45 UI and preserve all control markup',()=>{
 const updated=injectAi40Dashboard(base);
 assert.ok(updated.includes('id="zlDeepSeek40Card"'));
 assert.ok(updated.includes('120秒'));
 assert.ok(updated.includes('15～40秒'));
 assert.ok(updated.includes('45秒'));
 assert.ok(updated.includes('High深度思考'));
 assert.ok(updated.includes('PREWARM120_NEW_ROUND15_LIVE_DEEPSEEK_ONLY40S'));
 assert.ok(updated.includes('旧版5秒记录（已停用）'));
 assert.ok(updated.includes(card));
 assert.ok(updated.includes('<main>原实盘按钮与菜单</main>'));
 assert.equal(updated.split('id="zlDeepSeek40Card"').length-1,1);
 const scripts=[...updated.matchAll(/<script>([\s\S]*?)<\/script>/g)];
 assert.equal(scripts.length,1);
 assert.doesNotThrow(()=>new vm.Script(scripts[0][1]));
 assert.ok(!scripts[0][1].includes("method:'POST'"));
});
test('no duplicate panels, no injections into unrelated frontend pages',()=>{
 const updated=injectAi40Dashboard(base);
 assert.equal(injectAi40Dashboard(updated),updated);
 assert.equal(injectAi40Dashboard('<html><body>unrelated</body></html>'),'<html><body>unrelated</body></html>');
});
