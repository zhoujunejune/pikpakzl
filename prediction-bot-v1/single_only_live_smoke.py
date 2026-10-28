#!/usr/bin/env python3
"""Authenticate and inspect actual publicly served single-only Alibaba console."""
import os,sys,json,base64,urllib.request,urllib.error
HOST="https://prediction.47-237-188-69.sslip.io"
BASE="https://47-237-188-69.sslip.io"
password=os.environ["ZL_PANEL_PASSWORD"]
assert password
auth="Basic "+base64.b64encode(("zl:"+password).encode()).decode()
class NoRedirect(urllib.request.HTTPRedirectHandler):
 def redirect_request(self,*args,**kwargs):return None
opener=urllib.request.build_opener(NoRedirect)
def get(host,path,authorized=True):
 req=urllib.request.Request(host+path,headers={"Authorization":auth,"Cache-Control":"no-store"} if authorized else {"Cache-Control":"no-store"})
 try:
  with opener.open(req,timeout=18) as r:return r.status,r.read(1000000)
 except urllib.error.HTTPError as e:return e.code,e.read(3000)
def main():
 code,html=get(HOST,"/",False)
 assert code==401,("AUTH_MISSING",code)
 code,html=get(HOST,"/")
 assert code==200,("SINGLE_PAGE_FAILED",code)
 s=html.decode("utf8","replace")
 assert "5分钟单边预测" in s, "SINGLE_HEADER_NOT_VISIBLE"
 assert 'data-zl-theme="v2"' in s,"SINGLE_TECH_THEME_MISSING"
 for bad in ('aria-label="三个机器人切换"','href="https://prediction.47-237-188-69.sslip.io/dual5"','href="https://47-237-188-69.sslip.io/event10/"'):
  assert bad not in s,("OBSOLETE_HEADER_LINK",bad)
 print("PUBLIC_SINGLE_ONLY_BRANDED_PAGE_OK=true")
 code,raw=get(HOST,"/api/status")
 assert code==200,("SINGLE_STATUS_HTTP",code)
 data=json.loads(raw)
 assert data.get("ok") is True and data.get("enabled") is False, "SINGLE_FOLLOW_STATE_CHANGED"
 print("PUBLIC_SINGLE_API_STATUS_OK=true")
 for path in ("/dual5","/event10/","/dashboard/","/futures-lab/","/api/dual5-status","/deepseek/api/status"):
  code,_=get(HOST,path)
  assert code==404,("RETIRED_ROUTE_ACCESSIBLE",path,code)
  print("REMOVED_PUBLIC_ROUTE_404",path)
 code,_=get(HOST,"/api-keys/")
 assert code==200,("PREDICTION_API_KEYS_MANAGER_LOST",code)
 print("PREDICTION_API_KEYS_MANAGER_PRESERVED=true")
 code,_=get(BASE,"/event10/")
 assert code in (301,302,307,308),("MAIN_HOST_REDIRECT_MISSING",code)
 print("MAIN_HOST_REDIRECTS_TO_SINGLE=true")
 print("SINGLE_ONLY_PUBLIC_SMOKE_PASSED=true")
if __name__=="__main__":
 try:sys.exit(main() or 0)
 except Exception as e:print("SMOKE_FAILURE",str(e)[:300]);sys.exit(2)
