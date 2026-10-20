#!/usr/bin/env python3
"""Synchronize only DeepSeek round-stats display script with live prediction panel.
Remote commands do not write any exchange-order configuration or API credentials.
"""
import os,re,time,base64,sys
from alibabacloud_swas_open20200601.client import Client
from alibabacloud_swas_open20200601 import models as sw
from alibabacloud_tea_openapi import models as api
SCRIPT=r"""#!/bin/bash
set -Eeuo pipefail
trap 'echo DEEPSEEK_STATS_FAILURE_LINE=$LINENO' ERR
echo DEEPSEEK_STATS_STEP=start
node=/opt/zl-prediction-node/bin/node
live=/opt/zl-prediction-live/src/railway-diagnostic/panel-stats-shell.mjs
work=$(mktemp -d /tmp/zl-deepseek-stats-view.XXXXXXXX)
trap 'rm -rf "$work"' EXIT
echo DEEPSEEK_STATS_STEP=node_check
test -x "$node"
test -f "$live"
echo DEEPSEEK_STATS_TRADE_SERVICE=$(systemctl is-active zl-prediction-trade || true)
test "$(systemctl is-active zl-prediction-trade)" = active
echo DEEPSEEK_STATS_AI_SERVICE=$(systemctl is-active zl-prediction-deepseek5 || true)
test "$(systemctl is-active zl-prediction-deepseek5)" = active
curl -fsSL --retry 3 --max-time 30 \
 "https://raw.githubusercontent.com/zhoujunejune/pikpakzl/COMMIT_SHA/railway-diagnostic/panel-stats-shell.mjs" \
 -o "$work/git-panel.mjs"
echo DEEPSEEK_STATS_STEP=source_downloaded
"$node" --check "$work/git-panel.mjs"
echo DEEPSEEK_STATS_STEP=before_patch
python3 - "$live" "$work/git-panel.mjs" "$work/new.mjs" <<'PY'
import sys,pathlib
live,repo,out=[pathlib.Path(x) for x in sys.argv[1:4]]
before=live.read_text()
latest=repo.read_text()
start='const statsScript = \x60<script>'
next_card='const primaryCard ='
def extract(s,kind):
 assert s.count(start)==1,kind+': stats script anchor must be unique'
 i=s.index(start)
 j=s.index(next_card,i)
 section=s[i:j]
 assert section.count('</script>\x60;')==1,kind+': unexpected stats script terminator'
 return i,j,section
a,b,donor=extract(latest,'donor')
assert 'async function renderDeepSeekRoundStats()' in donor
assert '/deepseek/api/history?limit=80' in donor
i,j,old=extract(before,'production')
new=before[:i]+donor+before[j:]
assert new[:i]==before[:i]
assert new[i+len(donor):]==before[j:]
# Replace only HTML assembly for the read-only statistics module.
# Do not modify order control scripts or source policy files.
rows=new.splitlines(keepends=True)
outlines=[]
assembly=0
client_scripts=0
already_assembly=0
already_script=0
for row in rows:
 if row.lstrip().startswith('let out = html.includes(marker) ? html.replace(marker,'):
  if 'primaryCard' in row:
   row="  let out = html.includes(marker) ? html.replace(marker, statsCard + marker) : html.replace('</body>', statsCard + '</body>');\n"
   assembly+=1
  elif 'statsCard + marker' in row:already_assembly+=1
 elif row.lstrip().startswith("return out.replace('</body>',"):
  if 'primaryScript' in row:
   row="  return out.replace('</body>', statsScript + '</body>');\n"
   client_scripts+=1
  elif "statsScript + '</body>'" in row:already_script+=1
 outlines.append(row)
assert assembly+already_assembly==1 and client_scripts+already_script==1, 'DEEPSEEK_UI_COMPOSITION_CONTEXT_MISMATCH'
new=''.join(outlines)
assert 'primaryCard}${statsCard}' not in new
assert 'renderDeepSeekRoundStats' in new
assert '/deepseek/api/history?limit=80' in new
assert 'async function load(){' in new
out.write_text(new)
print('DEEPSEEK_STATS_PATCH_ONLY_LENGTH',len(new))
PY
echo DEEPSEEK_STATS_STEP=after_patch
"$node" --check "$work/new.mjs"
python3 - <<'PY'
import json,urllib.request,subprocess
def get(port,route):
 with urllib.request.urlopen('http://127.0.0.1:'+str(port)+route,timeout=8) as r:
  return json.load(r)
models=get(13001,'/api/order-signal-model')
assert models.get('model')=='DEEPSEEK_5M_V1'
assert [x.get('id') for x in models.get('models',[])]==['DEEPSEEK_5M_V1']
history=get(13029,'/api/history?limit=3')
assert history.get('ok') is True and history.get('model')=='DEEPSEEK_5M_V1'
assert isinstance(history.get('records'),list)
print('DEEPSEEK_ONLY_MODEL_VERIFIED=true')
print('DEEPSEEK_HISTORY_RECORDS',len(history['records']))
PY
archive=/var/lib/zl-prediction/archive/source-backups
mkdir -p "$archive"
backup="$archive/deepseek-stats-panel-$(date -u +%Y%m%dT%H%M%SZ).bak"
cp -p "$live" "$backup"
chmod 0600 "$backup"
chown --reference="$live" "$work/new.mjs"
chmod --reference="$live" "$work/new.mjs"
cp -p "$work/new.mjs" "$live"
restore(){
  cp -p "$backup" "$live"
  systemctl restart zl-prediction-trade >/dev/null 2>&1 || true
  echo 'DEEPSEEK_STATS_PANEL_ROLLBACK=true'
}
trap 'restore; rm -rf "$work"' ERR
systemctl restart zl-prediction-trade
python3 - <<'PY'
import urllib.request,json,time
for _ in range(24):
 try:
  with urllib.request.urlopen('http://127.0.0.1:13001/',timeout=6) as r:
   body=r.read(240000).decode('utf-8','replace')
  assert 'renderDeepSeekRoundStats' in body
  assert '/deepseek/api/history?limit=80' in body
  assert 'statsCard' not in body or 'DEEPSEEK_5M_V1' in body
  with urllib.request.urlopen('http://127.0.0.1:13001/api/order-signal-model',timeout=6) as r:
   prod=json.load(r)
  assert prod.get('model')=='DEEPSEEK_5M_V1'
  print('DEEPSEEK_STATS_PANEL_HTTP_200=true')
  print('DEEPSEEK_STATS_PAGE_READS_INDEPENDENT_HISTORY=true')
  print('DEEPSEEK_LEGACY_SOURCE_EXCLUDED=true')
  break
 except Exception:
  time.sleep(2)
else:
 raise RuntimeError('LIVE_PANEL_AFTER_DEPLOY_VERIFICATION_FAILED')
PY
test "$(systemctl is-active zl-futures-bot-paper)" = active
echo 'DEEPSEEK_FUTURES_UNMODIFIED=true'
"""
def main():
 sha=os.getenv('GITHUB_SHA','')
 if os.getenv('GITHUB_REF_NAME')!='feature/zl-futures-bot-v1' or not re.fullmatch(r'[0-9a-f]{40}',sha):
  print('WRONG_SOURCE');return 2
 client=Client(api.Config(access_key_id=os.environ['ALIBABA_CLOUD_ACCESS_KEY_ID'],
    access_key_secret=os.environ['ALIBABA_CLOUD_ACCESS_KEY_SECRET'],
    endpoint='swas.ap-southeast-1.aliyuncs.com',region_id='ap-southeast-1'))
 try:
  invoke=client.run_command(sw.RunCommandRequest(region_id='ap-southeast-1',
    instance_id='b67374069bb3457ba6a3a2ede9305d3f',
    name='zl-deepseek-production-stats-panel-only',working_user='root',
    type='RunShellScript',command_content=SCRIPT.replace('COMMIT_SHA',sha),timeout=190)).body.invoke_id
  for _ in range(85):
   time.sleep(2)
   x=client.describe_invocation_result(sw.DescribeInvocationResultRequest(
     region_id='ap-southeast-1',instance_id='b67374069bb3457ba6a3a2ede9305d3f',invoke_id=invoke)).body.invocation_result
   if x and str(x.invocation_status) in ('Success','Failed','Aborted','ExecutionTimeout','ExitCodeNonzero'):
    output=x.output or ''
    try:output=base64.b64decode(output,validate=True).decode('utf-8','replace')
    except Exception:pass
    print('STATS_PANEL_REMOTE_STATUS',x.invocation_status,'EXIT',x.exit_code)
    print(output[-6400:])
    return 0 if str(x.invocation_status)=='Success' and int(x.exit_code)==0 else 5
  print('STATS_PANEL_DEPLOY_TIMEOUT');return 6
 except Exception as e:
  print('STATS_PANEL_DEPLOY_ERROR',type(e).__name__);return 7
if __name__=='__main__':sys.exit(main())
