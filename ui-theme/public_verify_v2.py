#!/usr/bin/env python3
"""Verify the actual public URLs are serving new layouts, not just localhost files."""
import base64
import os
import sys
import urllib.error
import urllib.request

TARGETS=(
 ("单边预测","https://prediction.47-237-188-69.sslip.io/?zl_ui=v2a"),
 ("双边套利","https://prediction.47-237-188-69.sslip.io/dual5?zl_ui=v2a"),
 ("10分钟分析","https://47-237-188-69.sslip.io/event10/?zl_ui=v2a")
)
def main():
 password=os.environ.get("ZL_PANEL_PASSWORD","")
 if not password:
  print("PUBLIC_AUTH_SECRET_MISSING")
  return 2
 token=base64.b64encode(("zl:"+password).encode()).decode()
 for name,url in TARGETS:
  request=urllib.request.Request(url,headers={
    "Authorization":"Basic "+token,
    "User-Agent":"ZL-UI-V2-public-verification",
    "Cache-Control":"no-cache",
    "Pragma":"no-cache"
   })
  try:
   with urllib.request.urlopen(request,timeout=20) as response:
    code=response.status
    content=response.read(300000).decode("utf8","replace")
    cache=response.headers.get("Cache-Control","<none>")
    ctype=response.headers.get("Content-Type","")
  except urllib.error.HTTPError as e:
   print("PUBLIC_PAGE_FAILED",name,"HTTP",e.code)
   return 3
  except Exception as e:
   print("PUBLIC_PAGE_ERROR",name,type(e).__name__)
   return 4
  checks={
    "nav":"data-zl-theme=\"v2\"" in content,
    "theme":"id=\"zl-mintech-v2\"" in content,
    "three-tabs":all(x in content for x in ["5分钟单边预测","5分钟双边套利","10分钟事件分析"]),
    "layout-rules":".zl-v2-inner" in content and ".zl-v2-tabs" in content
  }
  print("PUBLIC_PAGE",name,"HTTP",code,"length",len(content),"type",ctype,"cache",cache,"checks",checks)
  if code!=200 or not all(checks.values()):return 5
 print("ALL_THREE_PUBLIC_REAL_UI_V2_CONFIRMED")
 return 0
if __name__=="__main__":sys.exit(main())
