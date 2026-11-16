#!/usr/bin/env python3
"""Launch the audited Alibaba DeepSeek-only cutover by existing SWAS Cloud Assistant permission."""
import base64,os,re,sys,time
from alibabacloud_swas_open20200601.client import Client
from alibabacloud_swas_open20200601 import models as sw
from alibabacloud_tea_openapi import models as api
REGION='ap-southeast-1'
INSTANCE='b67374069bb3457ba6a3a2ede9305d3f'
def main():
 sha=os.getenv('GITHUB_SHA','')
 if os.getenv('GITHUB_REF_NAME')!='feature/zl-futures-bot-v1' or not re.fullmatch(r'[a-f0-9]{40}',sha):
  print('DEEPSEEK_CUTOVER_REF_INVALID');return 2
 dry=os.getenv('DEEPSEEK_CUTOVER_DRY_RUN')=='1'
 cli=Client(api.Config(access_key_id=os.environ['ALIBABA_CLOUD_ACCESS_KEY_ID'],
    access_key_secret=os.environ['ALIBABA_CLOUD_ACCESS_KEY_SECRET'],
    endpoint='swas.ap-southeast-1.aliyuncs.com',region_id=REGION))
 script=r"""#!/bin/bash
set -Eeuo pipefail
file=$(mktemp /tmp/zl-deepseek-cutover.XXXXXXXX.py)
trap 'rm -f "$file"' EXIT
curl -fsSL --retry 3 --max-time 35 \
 "https://raw.githubusercontent.com/zhoujunejune/pikpakzl/COMMIT_SHA/prediction-bot-v1/aliyun_deepseek_prod_cutover.py" -o "$file"
python3 -m py_compile "$file"
DEEPSEEK_CUTOVER_DRY_RUN=IS_DRY python3 "$file"
""".replace('COMMIT_SHA',sha).replace('IS_DRY','1' if dry else '0')
 request=sw.RunCommandRequest(region_id=REGION,instance_id=INSTANCE,
   name='zl-deepseek-cutover-'+('dryrun' if dry else 'production'),
   type='RunShellScript',working_user='root',command_content=script,timeout=390)
 try:
  inv=cli.run_command(request).body.invoke_id
  for _ in range(125):
   time.sleep(3)
   result=cli.describe_invocation_result(sw.DescribeInvocationResultRequest(
    region_id=REGION,instance_id=INSTANCE,invoke_id=inv)).body.invocation_result
   if result and str(result.invocation_status) in ('Success','Failed','Aborted','ExecutionTimeout','ExitCodeNonzero'):
    output=result.output or ''
    try:output=base64.b64decode(output,validate=True).decode('utf8','replace')
    except Exception:pass
    print('DEEPSEEK_CUTOVER_REMOTE_STATUS',result.invocation_status)
    print('DEEPSEEK_CUTOVER_REMOTE_EXIT',result.exit_code)
    print(output[-7500:])
    return 0 if str(result.invocation_status)=='Success' and int(result.exit_code)==0 else 5
  print('DEEPSEEK_CUTOVER_TIMEOUT');return 6
 except Exception as e:
  print('DEEPSEEK_CUTOVER_LAUNCH_ERROR',type(e).__name__);return 7
if __name__=='__main__':sys.exit(main())
