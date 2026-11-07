import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
const source=fs.readFileSync(new URL("./app.js",import.meta.url),"utf8");
const from=source.indexOf("function isExpectedCancellation(error){");
const to=source.indexOf("// The ten-minute app is a CURRENT-STRATEGY ONLY view.",from);
assert.ok(from>=0&&to>from);
function extract(fetchImpl){
 const sandbox={AbortController,fetch:fetchImpl,setTimeout,clearTimeout};
 return vm.runInNewContext(source.slice(from,to)+"\n({api,isExpectedCancellation})",sandbox);
}
test("normal foreground signal fetch succeeds and preserves server version",async()=>{
 const x=extract(async()=>({ok:true,json:async()=>({ok:true,decisionReviewVersion:"EVENT10_PURE_RULE_V19_20261107"})}));
 const status=await x.api("/event10/api/status",250);
 assert.equal(status.decisionReviewVersion,"EVENT10_PURE_RULE_V19_20261107");
});
test("switching to another app cancels current status fetch with controlled PAGE_BACKGROUNDED, not WebView raw exception",async()=>{
 const x=extract((_url,options)=>new Promise((_resolve,reject)=>{
   if(options.signal.aborted){reject(new Error("signal is aborted without reason"));return;}
   options.signal.addEventListener("abort",()=>reject(new Error("signal is aborted without reason")),{once:true});
 }));
 const lifecycle=new AbortController();
 const pending=x.api("/event10/api/status",1000,lifecycle.signal);
 lifecycle.abort();
 await assert.rejects(pending,e=>e.name==="AbortError"&&e.message==="PAGE_BACKGROUNDED");
});
test("foreground request timeout is a recoverable message without permanent offline state",async()=>{
 const x=extract((_url,options)=>new Promise((_resolve,reject)=>{
   options.signal.addEventListener("abort",()=>reject(new Error("signal is aborted without reason")),{once:true});
 }));
 await assert.rejects(x.api("/event10/api/status",10),/请求超时，请检查网络/);
});
test("opaque WebView abort is translated into retryable network error, not NO_SIGNAL",async()=>{
 const x=extract(async()=>{throw Error("signal is aborted without reason")});
 await assert.rejects(x.api("/event10/api/status",500),/网络请求被中断，请重新连接/);
});
test("on visibility loss cancel stale requests and resume without automatic page reload",()=>{
 assert.ok(source.includes("function cancelEventRefresh(){"));
 assert.ok(source.includes("state.eventEpoch++;"));
 assert.ok(source.includes("state.eventFetchController.abort()"));
 assert.ok(source.includes("if(epoch===state.eventEpoch){"));
 assert.ok(source.includes("if(outdated())return;"));
 assert.ok(source.includes("function scheduleEventRetry(){"));
 assert.ok(source.includes("window.ZLForegroundResume=foregroundResume;"));
 assert.ok(source.includes('window.addEventListener("focus",()=>foregroundResume("focus"));'));
 assert.ok(source.includes('window.addEventListener("online",()=>foregroundResume("network-online"));'));
 assert.ok(!source.includes("if(onReturn&&!state.manualBusy&&!state.busy){window.location.reload();return;}"));
 const android=fs.readFileSync(new URL("../android-app/app/src/main/java/com/zlcontrol/android/MainActivity.java",import.meta.url),"utf8");
 assert.ok(android.includes('window.ZLForegroundResume(\'native-onResume\')'));
 assert.ok(android.includes("webView.onPause()")&&android.includes("webView.onResume()"));
 assert.ok(android.includes("SignalAlertService.start(this)"));
});
