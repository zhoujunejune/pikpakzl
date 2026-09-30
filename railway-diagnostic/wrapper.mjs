// V7 one-click confirm: button click submits immediately, no secondary browser confirmation.
import fs from 'node:fs';

let source = fs.readFileSync(new URL('./index.mjs', import.meta.url), 'utf8');

const clientJs = String.raw`(function(){
  'use strict';
  var currentPending = null;
  function el(id){ return document.getElementById(id); }
  function text(id,v){ var n=el(id); if(n) n.textContent=String(v); }
  function html(id,v){ var n=el(id); if(n) n.innerHTML=v; }

  function request(method,url,body,cb){
    var x=new XMLHttpRequest();
    x.open(method,url,true);
    x.setRequestHeader('Cache-Control','no-cache');
    if(method!=='GET') x.setRequestHeader('Content-Type','application/json');
    x.onreadystatechange=function(){
      if(x.readyState!==4) return;
      var j={};
      try{ j=JSON.parse(x.responseText||'{}'); }catch(e){ j={error:'返回数据无法解析'}; }
      cb(x.status,j);
    };
    x.onerror=function(){ cb(0,{error:'网络请求失败'}); };
    x.send(body?JSON.stringify(body):null);
  }

  function refresh(){
    request('GET','/api/status?ts='+Date.now(),null,function(code,j){
      if(code!==200){
        html('switch','<span class="bad">● 状态读取失败</span>');
        text('walletMeta',(j&&j.error)||'无法连接 /api/status');
        return;
      }
      html('switch',j.enabled?'<span class="on">● 跟随已开启</span>':'<span class="off">● 跟随已停止</span>');
      var s=j.signal||{};
      text('round',s.round==null?'-':s.round);
      text('status',s.status==null?'-':s.status);
      text('direction',s.direction==null?'-':s.direction);
      text('score',s.score==null?'-':Number(s.score).toFixed(2));
      text('amountView',j.amount==null?'-':j.amount);
      var amount=el('amount');
      if(amount&&document.activeElement!==amount&&j.amount!=null) amount.value=j.amount;

      var b=j.balance||{},items=b.items||[],first=null,i;
      for(i=0;i<items.length;i++){ if(items[i].enabled&&Number(items[i].availableBalanceDisplay)>0){ first=items[i]; break; } }
      if(!first){ for(i=0;i<items.length;i++){ if(items[i].enabled){ first=items[i]; break; } } }
      if(!first&&items.length) first=items[0];
      if(b.ok&&first){
        html('walletBalance','<span class="ok">'+first.availableBalanceDisplay+' USDT</span>');
        text('walletMeta','账户：'+first.accountType+' · Binance Prediction 实时可用余额');
      }else{
        html('walletBalance','<span class="bad">读取失败</span>');
        text('walletMeta',(b.error||'未返回余额')+(b.code!=null?' ('+b.code+')':''));
      }

      currentPending=j.pendingAction||null;
      var btn=el('confirmBtn');
      if(!currentPending){
        text('pendingTitle','暂无');
        text('pendingMeta',j.enabled?'正在等待下一轮 LOCKED，并准备市场/方向...':'开启后等待下一轮 LOCKED 信号。');
        if(btn) btn.classList.add('hidden');
      }else if(currentPending.state==='READY'){
        text('pendingTitle',(currentPending.signal==='UP'?'上涨 / BUY_UP':'下跌 / BUY_DOWN')+' · '+currentPending.amount+' USDT');
        text('pendingMeta','市场 '+(currentPending.marketTitle||'-')+' / '+(currentPending.outcome||'-')+' · 支付 '+(currentPending.paymentAccount||'-')+' · 点击按钮即直接提交真实订单');
        if(btn){
          btn.textContent='确认并直接下单 '+(currentPending.signal==='UP'?'BUY_UP ':'BUY_DOWN ')+currentPending.amount+' USDT';
          btn.disabled=false;
          btn.classList.remove('hidden');
        }
      }else if(currentPending.state==='PREPARE_ERROR'){
        text('pendingTitle','准备失败');
        text('pendingMeta',(currentPending.error||currentPending.state)+(currentPending.code!=null?' ('+currentPending.code+')':''));
        if(btn) btn.classList.add('hidden');
      }else{
        text('pendingTitle',currentPending.state==='QUOTING'?'正在获取最新 Quote...':'正在提交...');
        text('pendingMeta','正在处理，请不要重复点击。');
        if(btn) btn.classList.add('hidden');
      }

      var o=j.lastOrder;
      if(o){
        var filled=o.state==='CONFIRMED_FILLED'||Number(o.fillPercentage||0)>=1||Number(o.filledUsdtAmount||0)>0;
        var failed=o.state==='CONFIRMED_FAILED';
        html('orderTitle',filled?'<span class="ok">已成交</span>':(failed?'<span class="bad">下单失败</span>':'<span class="warn">已提交，核验中</span>'));
        text('orderMeta','orderId '+(o.orderId||'-')+' · '+(o.action||'-')+' · '+(o.amount||'-')+' USDT · 状态 '+(o.status||o.state||'-')+(o.filledUsdtAmount?' · 已成交 '+o.filledUsdtAmount+' USDT':'')+(o.error?' · '+o.error:''));
      }else{
        text('orderTitle','暂无'); text('orderMeta','-');
      }
    });
  }

  window.setV=function(v){
    var amountEl=el('amount'),pinEl=el('pin');
    var a=Number(amountEl&&amountEl.value);
    if(v&&(!isFinite(a)||a<1.5)){ alert('请输入至少 1.5 USDT；实际最低金额仍以 Binance 返回为准'); return; }
    request('POST','/api/control',{enabled:v,amount:v?amountEl.value:undefined,pin:pinEl?pinEl.value:''},function(code,j){
      if(code<200||code>=300){ alert((j&&j.error)||'操作失败'); return; }
      refresh();
    });
  };

  window.confirmOrder=function(){
    if(!currentPending||currentPending.state!=='READY') return;
    var btn=el('confirmBtn'),pinEl=el('pin');
    if(btn){ btn.disabled=true; btn.textContent='正在获取最新 Quote 并提交...'; }
    request('POST','/api/confirm',{pin:pinEl?pinEl.value:'',confirmationToken:currentPending.confirmationToken},function(code,j){
      if(code<200||code>=300){ alert(((j&&j.error)||'下单失败')+(j&&j.code!=null?' ('+j.code+')':'')); }
      refresh();
    });
  };

  function boot(){
    html('switch','<span class="warn">● V7 正在读取状态...</span>');
    refresh();
    setInterval(refresh,2500);
  }
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',boot); else boot();
})();`;

const scriptPattern=/<script>[\s\S]*?<\/script>/;
if(!scriptPattern.test(source)) throw new Error('INLINE_SCRIPT_NOT_FOUND');
source=source.replace(scriptPattern,'<script src="/panel-client.js?v=7" defer></script>');
source=source.replace('加载中...','V7 页面已加载，等待状态...');

const marker="  if (req.method === 'GET' && url.pathname === '/healthz') {";
if(!source.includes(marker)) throw new Error('HEALTH_ROUTE_MARKER_NOT_FOUND');
const route="  if (req.method === 'GET' && url.pathname === '/panel-client.js') {\n    return send(res, 200, "+JSON.stringify(clientJs)+", 'application/javascript; charset=utf-8');\n  }\n\n";
source=source.replace(marker,route+marker);

fs.writeFileSync('/tmp/trade-control-fixed.mjs',source);
await import('file:///tmp/trade-control-fixed.mjs');
