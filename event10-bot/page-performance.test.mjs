import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
const panel=fs.readFileSync(new URL("./panel.html",import.meta.url),"utf8");
test("compact history loads separately from current live status",()=>{
 assert.match(panel,/fetch\("api\/history-lite"/);
 assert.doesNotMatch(panel,/fetch\("api\/history",/);
 assert.match(panel,/setInterval\(refresh,4000\)/);
 assert.match(panel,/setInterval\(refreshHistory,30000\)/);
 assert.match(panel,/if\(fingerprint===lastHistoryFingerprint\)return/);
 assert.match(panel,/rows\.replaceChildren\(fragment\)/);
 assert.match(panel,/lastSessionHistoryKey/);
});
test("preserve latest AI evidence, settlement and manual button without repeated redraws",()=>{
 assert.match(panel,/lastDetailFingerprint/);
 assert.match(panel,/lastCoverageFingerprint/);
 assert.match(panel,/if\(fingerprint!==lastDetailFingerprint\)/);
 assert.match(panel,/if\(coverageFingerprint!==lastCoverageFingerprint\)/);
 assert.match(panel,/historyRefreshPending/);
 assert.match(panel,/pageRefreshPending/);
 assert.match(panel,/collectorRefreshPending/);
 assert.match(panel,/visibilitychange/);
 assert.match(panel,/await refreshHistory\(\)/);
 assert.match(panel,/method:"POST",credentials:"same-origin"/);
});
test("embedded panel script is valid JavaScript",()=>{
 const scripts=[...panel.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(x=>x[1]);
 assert.ok(scripts.length>0);
 for(const script of scripts)assert.doesNotThrow(()=>new Function(script));
});
