import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";
const page=fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)),"panel.html"),"utf8");
test("manual action shows the live result directly beneath its click button",()=>{
 const click=page.indexOf('id="start"');
 const immediate=page.indexOf('id="immediatePrediction"');
 const endSection=page.indexOf('</section>',click);
 const collector=page.indexOf("后台持续成交采集");
 const complete=page.indexOf("完整分析详情（本轮 / 最近一轮）");
 assert.ok(click>=0&&immediate>click&&immediate<endSection);
 assert.ok(complete>endSection&&complete<collector);
 assert.ok(page.includes('id="quickDirection"'));
 assert.ok(page.includes('id="quickReason"'));
 assert.ok(page.includes('id="quickPhase"'));
 assert.ok(page.includes('id="quickOpen"'));
});
test("auto-refresh displays the confirmed newest server record; never a fabricated AI direction",()=>{
 assert.match(page,/const s=d\.lastSession\|\|null/);
 assert.match(page,/\$\("quickDirection"\)\.textContent=s\.direction\|\|/);
 assert.match(page,/\$\("quickReason"\)\.textContent=s\.status==="ANALYZING"/);
 assert.match(page,/setInterval\(refresh,4000\)/);
 assert.match(page,/s\.analysisArguments\|\|\{\}/);
 assert.match(page,/args\.upCase/);
 assert.match(page,/args\.downCase/);
 assert.match(page,/args\.decisiveEvidence/);
 assert.match(page,/args\.uncertainty/);
 assert.ok(page.includes('p.textContent=name+"："+val;'));
});
test("unique HTML ids and mobile width fit; no trading controls added",()=>{
 const ids=[...page.matchAll(/\bid="([^"]+)"/g)].map(m=>m[1]);
 assert.equal(new Set(ids).size,ids.length);
 assert.match(page,/@media\(max-width:700px\)/);
 assert.match(page,/overflow-wrap:anywhere/);
 assert.doesNotMatch(page,/\/fapi\/v1\/order|\/api\/v3\/order|trade\/submit|placeEventOrder/);
});
