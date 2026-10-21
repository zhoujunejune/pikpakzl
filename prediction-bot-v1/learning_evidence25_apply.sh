#!/bin/bash
set -Eeuo pipefail
: "${LEARN_SHA:?}" "${BASE_SHA:?}"
app=/opt/zl-prediction-live/deepseek5
node=/opt/zl-prediction-node/bin/node
back=/var/lib/zl-prediction/archive/source-backups/learning-proof25-$LEARN_SHA
names="deepseek-5m-learner.mjs deepseek-adaptive15-quality-store.mjs deepseek-adaptive15-runner.mjs deepseek-adaptive15-production-adapter.mjs"
python3 - <<'PY'
import urllib.request,json
def get(p,u):
 with urllib.request.urlopen('http://127.0.0.1:%d%s'%(p,u),timeout=7) as x:return json.load(x)
a=get(13029,'/api/status');t=get(13001,'/api/status')
assert a.get('maxCallsPerRound')==6
assert a.get('decisionWindowEndMs',0)-a.get('round',0)==25000
assert t.get('enabled') is False
print('BEFORE_OFFICIAL',a.get('learning',{}).get('allOfficialSamples'))
PY
t=$(mktemp -d)
trap 'rm -rf "$t"' EXIT
mkdir -p "$back" "$t/new" "$t/merged" "$t/patch"
curl -fsSL --max-time 25 "https://raw.githubusercontent.com/zhoujunejune/pikpakzl/$LEARN_SHA/prediction-bot-v1/learner_lifetime_compatible_patch.py" > "$t/learner-compat.py"
python3 -m py_compile "$t/learner-compat.py"
curl -fsSL --max-time 25 "https://raw.githubusercontent.com/zhoujunejune/pikpakzl/$BASE_SHA/prediction-bot-v1/deepseek-5m-episodic-memory.mjs" > "$t/episodic-memory.mjs"
"$node" --check "$t/episodic-memory.mjs"
if test -f "$app/deepseek-5m-episodic-memory.mjs";then
 "$node" --check "$app/deepseek-5m-episodic-memory.mjs"
 grep -q 'export function retrieveOfficialCases' "$app/deepseek-5m-episodic-memory.mjs" || { echo "EPISODIC_HELPER_DIVERGED_ABORT";exit 15; }
 echo EPISODIC_HELPER_PRESENT=true
else
 echo EPISODIC_HELPER_WILL_INSTALL=true
fi
for n in $names;do
 curl -fsSL --max-time 25 "https://raw.githubusercontent.com/zhoujunejune/pikpakzl/$BASE_SHA/prediction-bot-v1/$n" > "$t/$n"
 
 curl -fsSL --max-time 25 "https://raw.githubusercontent.com/zhoujunejune/pikpakzl/$LEARN_SHA/prediction-bot-v1/$n" > "$t/new/$n"
 "$node" --check "$t/new/$n"
# Merge only the reviewed difference into the currently running version.
# This preserves independent production improvements and refuses conflicts.
 cp -p "$app/$n" "$t/merged/$n"
 if test "$n" = "deepseek-5m-learner.mjs" && ! cmp -s "$app/$n" "$t/$n";then
  echo "PRESERVE_LIFETIME_COUNTERS_AND_ADD_CASE_MEMORY=true"
  python3 "$t/learner-compat.py" "$t/merged/$n"
 elif ! cmp -s "$app/$n" "$t/$n";then
  echo "SAFE_MERGE_REQUIRED=$n"
  diff -u "$t/$n" "$t/new/$n" > "$t/patch/$n.diff" || test "$?" -eq 1
  patch --batch --forward --fuzz=0 "$t/merged/$n" "$t/patch/$n.diff" ||
    { echo "MERGE_CONFLICT_ABORT=$n";exit 15; }
  echo "SAFE_PATCH_MERGED=$n"
 else
  cp -p "$t/new/$n" "$t/merged/$n"
 fi
 "$node" --check "$t/merged/$n"
 cp -p "$app/$n" "$back/$n"
done
rollback(){
 for n in $names;do cp -p "$back/$n" "$app/$n";done
 if test -e "$back/installed-new-episodic-helper";then rm -f "$app/deepseek-5m-episodic-memory.mjs";fi
 systemctl restart zl-prediction-deepseek5.service || true
}
trap rollback ERR
if ! test -f "$app/deepseek-5m-episodic-memory.mjs";then
 cp -p "$t/episodic-memory.mjs" "$app/deepseek-5m-episodic-memory.mjs"
 touch "$back/installed-new-episodic-helper"
fi
for n in $names;do cp -p "$t/merged/$n" "$app/$n";done
systemctl restart zl-prediction-deepseek5.service
for i in $(seq 1 20);do
 if curl -fsS --max-time 3 http://127.0.0.1:13029/api/learning-effect > "$t/result" 2>/dev/null;then break;fi
 sleep 2
done
python3 - "$t/result" <<'PY'
import json,sys,urllib.request
x=json.load(open(sys.argv[1]))
assert x['ok'] is True and x['maxCallsPerRound']==6
assert x['hardDecisionDeadlineMs']==25000 and x['additionalApiCalls']==0
assert x['controlledComparisonVerdict']=='NOT_PROVEN'
with urllib.request.urlopen('http://127.0.0.1:13001/api/status',timeout=7) as r:t=json.load(r)
assert t.get('enabled') is False
print('LEARNING25_ONLINE=true')
print('LEARNING25_EVIDENCE',json.dumps(x['evidence'],separators=(',',':')))
print('LEARNING25_FOLLOW_OFF=true')
PY
trap - ERR
