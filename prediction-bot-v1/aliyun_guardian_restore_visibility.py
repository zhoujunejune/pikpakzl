#!/usr/bin/env python3
"""Restore GUARDIAN homepage signal, market and per-round read-only visibility.

This script never edits strategy/order/risk code and never flips following state.
When live following is active it stages the UI file WITHOUT restarting trade.
"""
import base64
import os
import re
import sys
import time
from alibabacloud_swas_open20200601.client import Client
from alibabacloud_swas_open20200601 import models as sw
from alibabacloud_tea_openapi import models as api

VIS = r'''<script>(function(){
'use strict';
if(window.__zlGuardianVisibilityRestoreV1)return;
window.__zlGuardianVisibilityRestoreV1=true;
var root=document.querySelector('.w')||document.querySelector('main');
if(!root)return;
var card=document.createElement('section');
card.id='zlGuardianVisibilityRestoreV1';
card.className='c';
card.style.cssText='border:1px solid #38516c;background:#121d2e;color:#e7f0ff;margin:14px 0';
card.innerHTML='<div style="font-weight:750;font-size:17px;margin-bottom:12px">BTC 5分钟 · 实时行情与信号记录</div>'+
'<div class="grid" style="grid-template-columns:repeat(2,minmax(0,1fr));gap:9px">'+
'<div class="kv"><div class="k">BTC/USDT 现货最新报价</div><div class="v" id="zgvPrice">读取中</div></div>'+
'<div class="kv"><div class="k">行情采集时间</div><div class="v" id="zgvFresh">读取中</div></div>'+
'<div class="kv"><div class="k">当前5分钟轮次</div><div class="v" id="zgvRound">读取中</div></div>'+
'<div class="kv"><div class="k">GUARDIAN 分析方向</div><div class="v" id="zgvSignal">读取中</div></div>'+
'<div class="kv"><div class="k">生产下单信号</div><div class="v" id="zgvTrade">读取中</div></div>'+
'<div class="kv"><div class="k">已保存信号数</div><div class="v" id="zgvCount">读取中</div></div></div>'+
'<div class="muted" id="zgvReason" style="margin:12px 0 8px">正在同步分析原因</div>'+
'<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin:12px 0"><strong style="font-size:15px">GUARDIAN 逐轮信号记录</strong><span class="muted" id="zgvStatus">同步中</span></div>'+
'<div style="overflow-x:auto;max-height:380px;border:1px solid #33465d;border-radius:10px"><table style="width:100%;min-width:550px;border-collapse:collapse;font-size:12px"><thead><tr><th style="padding:10px">轮次</th><th>记录时间</th><th>预测</th><th>置信度</th><th>官方结算</th><th>验证</th></tr></thead><tbody id="zgvRows"><tr><td colspan="6" style="padding:10px">读取中</td></tr></tbody></table></div>'+
'<div class="muted" style="font-size:12px;margin-top:10px">报价为 Binance BTCUSDT 现货价，并非 Binance Prediction 的官方结算价。表格只展示GUARDIAN已经持久化的信号；WAIT/无信号轮次如未保存，不会伪造记录。信号不等于真实成交。</div>';
root.insertBefore(card,root.firstChild);
var busy=false,lastTicker=0;
function e(id){return document.getElementById(id)}
function put(id,x){var n=e(id);if(n)n.textContent=x==null?'-':String(x)}
function tm(v){var n=Number(v);return Number.isFinite(n)&&n>0?new Date(n).toLocaleString('zh-CN',{hour12:false,timeZone:'Asia/Shanghai'}):'-'}
function dir(v){return v==='UP'?'UP ↑ 看涨':v==='DOWN'?'DOWN ↓ 看跌':v==='WAIT'?'WAIT · 跳过':v==='THINKING'?'分析中':v==='OBSERVED'?'本轮已保存':'无信号'}
async function get(url,timeout){var r=await fetch(url,{cache:'no-store',credentials:'same-origin',signal:AbortSignal.timeout(timeout||5000)});if(!r.ok)throw Error('HTTP '+r.status);return r.json()}
async function ticker(){
 try{
  var r=await fetch('https://data-api.binance.vision/api/v3/ticker/price?symbol=BTCUSDT',{cache:'no-store',signal:AbortSignal.timeout(4500)});
  if(!r.ok)throw Error('HTTP '+r.status);
  var x=await r.json(),p=Number(x&&x.price);
  if(!Number.isFinite(p)||p<=0)throw Error('无有效报价');
  put('zgvPrice',p.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})+' USDT');
  lastTicker=Date.now();
 }catch(err){put('zgvPrice','现货报价不可用');}
}
function draw(rows){
 var body=e('zgvRows');if(!body)return;
 body.replaceChildren();
 var data=Array.isArray(rows)?rows.slice().sort(function(a,b){return Number(b.round)-Number(a.round)}).slice(0,35):[];
 if(!data.length){var tr=document.createElement('tr'),td=document.createElement('td');td.colSpan=6;td.style.padding='12px';td.textContent='暂无已持久化的GUARDIAN信号；无信号轮次不能当作历史记录';tr.appendChild(td);body.appendChild(tr);return}
 data.forEach(function(x){
  var tr=document.createElement('tr');
  var conf=Number(x.subjectiveConfidence);
  var cells=[tm(x.round),tm(x.at),dir(x.predictedDirection),x.subjectiveConfidence==null||!Number.isFinite(conf)?'-':(100*conf).toFixed(1)+'%（主观）',x.officialDirection||'待官方结算',x.status==='SETTLED'?(x.hit?'命中':'未命中'):'未结算'];
  cells.forEach(function(v){var td=document.createElement('td');td.style.cssText='padding:9px 6px;border-top:1px solid #2b3b4e;white-space:nowrap';td.textContent=v;tr.appendChild(td)});
  body.appendChild(tr);
 });
}
async function load(){
 if(busy||document.hidden)return;busy=true;
 try{
  var pair=await Promise.allSettled([get('/guardian/api/status',6500),get('/api/status',6500)]);
  if(pair[0].status==='fulfilled'&&pair[0].value.ok===true){
   var g=pair[0].value, latest=g.latest||{},records=g.records||[];
   var current=records.find(function(x){return Number(x.round)===Number(g.round)});
   put('zgvRound',tm(g.round));
   put('zgvSignal',dir(current?current.predictedDirection:latest.direction));
   put('zgvCount',g.stats&&g.stats.shadowPredictions!=null?g.stats.shadowPredictions:records.length);
   put('zgvFresh',g.observedAt?Math.max(0,Math.floor((Date.now()-Number(g.observedAt))/1000))+'秒前':'尚无采集时间');
   put('zgvReason',latest.reason||'暂无分析原因');
   put('zgvStatus','最近更新 '+tm(Date.now()));
   draw(records);
  }else{
   put('zgvStatus','GUARDIAN记录接口不可用');
   put('zgvReason','本轮未能取得分析服务数据，不能据此判断没有记录');
  }
  if(pair[1].status==='fulfilled'&&pair[1].value.ok===true){
   var t=pair[1].value,s=t.signal||{};
   put('zgvTrade',s.direction==='UP'||s.direction==='DOWN'?dir(s.direction):'未锁定 / 无有效下单信号');
  }else put('zgvTrade','生产状态接口不可用');
 }finally{busy=false}
}
void load();void ticker();
setInterval(load,4500);setInterval(ticker,9000);
document.addEventListener('visibilitychange',function(){if(!document.hidden){void load();if(Date.now()-lastTicker>9000)void ticker()}});
})();</script>'''

# Remote script is generated with only a base64-encoded, static UI fragment.
REMOTE = r"""#!/bin/bash
set -Eeuo pipefail
NODE=/opt/zl-prediction-node/bin/node
CADDY=/etc/caddy/Caddyfile
ROOT=/opt/zl-prediction-live/ui-sidecar
DEST=$ROOT/guardian-visibility-sidecar.mjs
UNIT=/etc/systemd/system/zl-prediction-ui-visibility.service
HOST=prediction.47-237-188-69.sslip.io
SHA=c1b0c082269274163e892a1db1f4e2c3e556fdc7
test -x "$NODE" && test -r "$CADDY"
systemctl is-active --quiet zl-prediction-trade
systemctl is-active --quiet caddy
id zl-pred >/dev/null
curl -fsS --max-time 8 http://127.0.0.1:13001/api/status | python3 -c "import json,sys; assert json.load(sys.stdin).get('ok') is True"
BACK=/var/backups/guardian-ui-only-$(date -u +%Y%m%dT%H%M%SZ)-$$
mkdir -p -m 0700 "$BACK" "$ROOT"
cp -p "$CADDY" "$BACK/caddy.before"
if test -f "$DEST";then cp -p "$DEST" "$BACK/sidecar.before";fi
if test -f "$UNIT";then cp -p "$UNIT" "$BACK/unit.before";fi
rollback(){
  echo ZGV_ROLLBACK_STARTED=true
  cp -p "$BACK/caddy.before" "$CADDY"
  if test -f "$BACK/sidecar.before";then cp -p "$BACK/sidecar.before" "$DEST";else rm -f "$DEST";fi
  if test -f "$BACK/unit.before";then cp -p "$BACK/unit.before" "$UNIT";else rm -f "$UNIT";fi
  systemctl daemon-reload || true
  if test -f "$BACK/unit.before";then systemctl restart zl-prediction-ui-visibility || true;else systemctl stop zl-prediction-ui-visibility || true;fi
  systemctl reload caddy || true
  echo ZGV_ROLLBACK_DONE=true
}
trap rollback ERR
curl -fsSL --retry 2 --max-time 30 "https://raw.githubusercontent.com/zhoujunejune/pikpakzl/$SHA/prediction-bot-v1/guardian-visibility-sidecar.mjs" -o "$BACK/sidecar.stage.mjs"
"$NODE" --check "$BACK/sidecar.stage.mjs"
install -o zl-pred -g zl-pred -m 0644 "$BACK/sidecar.stage.mjs" "$DEST"
cat > "$UNIT" <<'EOF'
[Unit]
Description=GUARDIAN BTC 5M read-only visibility sidecar
After=network-online.target zl-prediction-trade.service
Wants=network-online.target
[Service]
Type=simple
User=zl-pred
Group=zl-pred
WorkingDirectory=/opt/zl-prediction-live/ui-sidecar
ExecStart=/opt/zl-prediction-node/bin/node /opt/zl-prediction-live/ui-sidecar/guardian-visibility-sidecar.mjs
Restart=on-failure
RestartSec=2
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable zl-prediction-ui-visibility >/dev/null
systemctl restart zl-prediction-ui-visibility
for i in $(seq 1 18);do
  if curl -fsS --max-time 4 http://127.0.0.1:13051/ -o "$BACK/page.html" &&
     grep -q '__zlGuardianLiveVisibilityV2' "$BACK/page.html" &&
     curl -fsS --max-time 3 http://127.0.0.1:13051/healthz | grep -q '"ok":true'; then break;fi
  sleep 1
done
grep -q '__zlGuardianLiveVisibilityV2' "$BACK/page.html"
python3 - <<'PY'
from pathlib import Path
import os
p=Path('/etc/caddy/Caddyfile')
s=p.read_text()
host='\nprediction.47-237-188-69.sslip.io {'
pos=s.find(host)
if pos<0 and s.startswith(host.lstrip('\n')):pos=0
assert pos>=0,'PREDICTION_CADDY_HOST_MISSING'
if '# ZGV_READONLY_VISIBILITY_V2' in s:
 assert s.count('reverse_proxy 127.0.0.1:13051')==2,'EXISTING_ROOT_PROXY_DRIFT'
 print('ZGV_CADDY_ALREADY_WIRED=true')
else:
 anchor='\n  handle {'
 start=s.index(anchor,pos)
 assert 'reverse_proxy 127.0.0.1:13001' in s[start:start+160],'PREDICTION_FALLBACK_NOT_MATCHED'
 patch=('\n  # ZGV_READONLY_VISIBILITY_V2: route only public HTML and read-only market feed'
        '\n  handle / {'
        '\n    reverse_proxy 127.0.0.1:13051'
        '\n  }'
        '\n  handle /zl-guardian-visibility/market {'
        '\n    reverse_proxy 127.0.0.1:13051'
        '\n  }')
 s=s[:start]+patch+s[start:]
 assert s.count('basic_auth')==p.read_text().count('basic_auth'),'AUTH_MUST_BE_PRESERVED'
 staged=p.with_name('Caddyfile.zgv-stage')
 staged.write_text(s)
 os.chmod(staged,0o644)
 os.replace(staged,p)
 print('ZGV_CADDY_READONLY_ROUTES_INSTALLED=true')
PY
caddy validate --config "$CADDY" >/dev/null
systemctl reload caddy
curl -skS --resolve "$HOST:443:127.0.0.1" --max-time 6 -o /dev/null -w '%{http_code}' "https://$HOST/" > "$BACK/public_code"
test "$(cat "$BACK/public_code")" = 401
systemctl is-active --quiet zl-prediction-trade
systemctl is-active --quiet zl-prediction-ui-visibility
systemctl is-active --quiet caddy
curl -fsS --max-time 5 http://127.0.0.1:13001/api/status | python3 -c "import json,sys; assert json.load(sys.stdin).get('ok') is True"
echo ZGV_RESTART_SKIPPED_TO_PROTECT_ACTIVE_TRADES=true
echo ZGV_LIVE_VISIBILITY_RESTORED=true
echo ZGV_TRADE_ENGINE_NOT_RESTARTED=true
echo ZGV_BACKUP_DIR="$BACK"
trap - ERR"""
REMOTE=REMOTE.replace('FRAGMENT_BASE64_HERE',base64.b64encode(VIS.encode()).decode())

def main():
 if os.getenv('GITHUB_REF_NAME')!='feature/zl-futures-bot-v1' or not re.fullmatch('[0-9a-f]{40}',os.getenv('GITHUB_SHA','')):
  print('ZGV_INVALID_WORKFLOW_BRANCH');return 2
 client=Client(api.Config(
  access_key_id=os.environ['ALIBABA_CLOUD_ACCESS_KEY_ID'],
  access_key_secret=os.environ['ALIBABA_CLOUD_ACCESS_KEY_SECRET'],
  endpoint='swas.ap-southeast-1.aliyuncs.com',region_id='ap-southeast-1'))
 invoke=client.run_command(sw.RunCommandRequest(region_id='ap-southeast-1',
  instance_id='b67374069bb3457ba6a3a2ede9305d3f',
  name='restore-guardian-main-readonly-visibility',type='RunShellScript',
  command_content=REMOTE,working_user='root',timeout=230)).body.invoke_id
 for _ in range(132):
  time.sleep(2)
  r=client.describe_invocation_result(sw.DescribeInvocationResultRequest(
   region_id='ap-southeast-1',instance_id='b67374069bb3457ba6a3a2ede9305d3f',
   invoke_id=invoke)).body.invocation_result
  if r and str(r.invocation_status) in ('Success','Failed','Aborted','ExecutionTimeout','ExitCodeNonzero'):
   try:out=base64.b64decode(r.output or '',validate=True).decode('utf8','replace')
   except Exception:out='NON_UTF8_REMOTE_RESULT'
   print('ZGV_REMOTE_RESULT',r.invocation_status,r.exit_code)
   print(out[-3000:])
   return 0 if str(r.invocation_status)=='Success' and int(r.exit_code)==0 and ('ZGV_LIVE_VISIBILITY_RESTORED=true' in out or 'ZGV_PATCH_ON_DISK_BUT_NOT_LIVE=true' in out) else 5
 print('ZGV_REMOTE_TIMEOUT');return 6
if __name__=='__main__':sys.exit(main())
