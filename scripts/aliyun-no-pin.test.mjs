import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const files=[
  "railway-diagnostic/index.mjs",
  "railway-diagnostic/control-shell.mjs",
  "railway-diagnostic/panel-stats-shell.mjs",
  "fast-signal-engine/index.mjs",
  "round-tracker/index-rest.mjs",
];
const read=(p)=>readFileSync(new URL("../"+p,import.meta.url),"utf8");
test("prediction services bind loopback, never public interfaces",()=>{
 for(const p of files){
   const s=read(p);
   assert.ok(!s.includes(".listen(PORT, '0.0.0.0'"),p);
   assert.ok(s.includes(".listen(PORT, '127.0.0.1'"),p);
 }
});
test("backend PIN alternative requires trusted authenticated HTTPS proxy and same-site Origin",()=>{
 for(const p of files.slice(0,2)){
   const s=read(p);
   assert.ok(s.includes("ZL_OUTER_AUTH_ONLY === 'true'"),p);
   assert.ok(s.includes("x-zl-verified-login"),p);
   assert.ok(s.includes("req.headers.origin === origin"),p);
   assert.ok(s.includes("req.headers['sec-fetch-site'] === 'same-origin'"),p);
   assert.ok(!s.includes("pinOK(body.pin)"),p);
   assert.ok(s.includes("pinOK(body.pin, req)"),p);
 }
});
test("existing frontend no longer requires legacy controller PIN",()=>{
 const page=read("railway-diagnostic/index.mjs");
 const risk=read("railway-diagnostic/control-shell.mjs");
 const selector=read("railway-diagnostic/panel-stats-shell.mjs");
 assert.ok(page.includes('id="pin" type="hidden"'));
 assert.ok(risk.includes('type=\\\"hidden\\\" id=\\\"tpPin\\\"'));
 assert.ok(risk.includes('type=\\\"hidden\\\" id=\\\"slPin\\\"'));
 assert.ok(!selector.includes("if(!pin||!pin.value)"));
 assert.ok(!selector.includes("if(!select||!pin||!pin.value)"));
});
