import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
const read=p=>fs.readFileSync(new URL(p,import.meta.url),"utf8");
const html=read("./index.html"),js=read("./app.js");
const main=read("../android-app/app/src/main/java/com/zlcontrol/android/MainActivity.java");
const overlay=read("../android-app/app/src/main/java/com/zlcontrol/android/SignalPopupOverlay.java");
const alert=read("../android-app/app/src/main/java/com/zlcontrol/android/SignalAlertService.java");
test("white and light-blue UI preserves SpongeBob and Patrick art and real V19 status slots",()=>{
 assert.ok(html.includes("color-scheme:light"));
 assert.ok(html.includes("#e9f5ff"));
 assert.ok(html.includes('alt="海绵宝宝和派大星"'));
 assert.ok(html.includes('src="/app/icon-192.png"'));
 for(const id of ["eHero","eSignal","eReason","ePhase","eStatus","eFreshness",
   "eHomeTotal","eProxyAccuracy","eLastTen","eHomeRecords","eMiniConnection"]){
   assert.ok(html.includes('id="'+id+'"'),id);
 }
 assert.ok(js.includes('$("eHero").dataset.direction=direction||"WAIT"'));
 assert.ok(js.includes('renderRecords("eHomeRecords",state.eventRecords.slice(0,2))'));
 assert.ok(!html.includes("102,356.20")); // No fictional live BTC price.
});
test("navigation exposes four real panels and historical signal pagination stays in records tab",()=>{
 for(const tab of ["event10","stats","records","more"]){
   assert.ok(html.includes('id="panel-'+tab+'"'));
   assert.ok(html.includes('data-go="'+tab+'"'));
 }
 assert.ok(js.includes('["event10","stats","records","more"].includes(initial)'));
 assert.ok(js.includes('panel-records")'));
 assert.ok(html.includes('id="eRecordScroll"'));
 assert.ok(html.includes('id="eRecords"'));
 assert.ok(js.includes('eventHistoryFingerprint'));
});
test("signal popup retains notification directions and a dedicated stop-alarm action",()=>{
 for(const part of ["买涨","买跌","UP","DOWN","V19 原始信号","反向模式",
   "信号时间","提醒延迟","haipai_up","haipai_down","确认并打开币安",
   "关闭提醒","R.drawable.sea_friends_icon", "SignalAlertService.ACTION_SILENCE"]){
   assert.ok(overlay.includes(part),part);
 }
 assert.ok(alert.includes('AlertDirectionPolicy.notifiedDirection(direction,reverse)'));
 assert.ok(alert.includes("SignalAlarmPolicy.decide("));
 assert.ok(alert.includes("SIGNAL_WATCH_URL"));
});
test("Android login is a new visual skin on top of original HTTP Basic Auth and Keystore",()=>{
 assert.ok(main.includes("void onReceivedHttpAuthRequest("));
 assert.ok(main.includes("handler.proceed(sessionUsername,sessionPassword)"));
 assert.ok(main.includes("SecureStore.saveLogin(this,sessionUsername,sessionPassword)"));
 assert.ok(main.includes('subtitle.setText("欢迎来到海派信号站")'));
 assert.ok(main.includes("R.drawable.sea_friends_icon"));
 assert.ok(main.includes("ImageView mascot=new ImageView(this)"));
 assert.ok(main.includes('manage.setText("提醒管理 ▾")'));
 assert.ok(main.includes("advanced.setVisibility(View.GONE)"));
 assert.ok(main.includes("showAlarmDiagnostics()"));
 assert.ok(main.includes("openOverlayPermissionSettings()"));
 assert.ok(!js.includes("fetch('/api/login'"));
});
test("configuration remains real and Android-only: no fake reminder status or trading write APIs",()=>{
 assert.ok(html.includes('id="reverseAlertToggle"'));
 assert.ok(js.includes("configureReverseAlertSetting()"));
 assert.ok(js.includes("bridge.setReverseAlertsEnabled(next)"));
 assert.ok(!js.includes("localStorage")&&!js.includes("sessionStorage"));
 assert.ok(!js.includes("/fapi/v1/order")&&!js.includes("POST /order"));
 assert.ok(html.includes("非真实交易收益"));
});
