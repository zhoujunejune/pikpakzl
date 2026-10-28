#!/usr/bin/env python3
"""V2 visual frontend update for three bots; never touches trading endpoints or data."""
from pathlib import Path
import argparse,json,os
FILES={
 "single":Path("/opt/zl-prediction-live/src/railway-diagnostic/panel-stats-shell.mjs"),
 "dual":Path("/opt/zl-prediction-dual5/binance_dual5_dashboard.html"),
 "event10":Path("/opt/zl-event10/panel.html")
}
MARKER="ZL_MINTECH_V2_REAL_LAYOUT_20261028"
def once(src,old,new):
 count=src.count(old)
 if count!=1:raise ValueError("BAD_ANCHOR "+old[:45]+" count="+str(count))
 return src.replace(old,new,1)
def bar(kind):
 links=[
 ("single","5分钟单边预测","https://prediction.47-237-188-69.sslip.io/"),
 ("dual","5分钟双边套利","https://prediction.47-237-188-69.sslip.io/dual5"),
 ("event10","10分钟事件分析","https://47-237-188-69.sslip.io/event10/")
 ]
 nav="".join('<a href="'+url+'"'+(' class="is-active" aria-current="page"' if k==kind else '')+'>'+name+'</a>' for k,name,url in links)
 return ('<header class="zl-v2-bar" data-zl-theme="v2"><div class="zl-v2-inner"><div class="zl-v2-brand">'
         '<span class="zl-v2-logo" aria-hidden="true">◇</span>'
         '<div class="zl-v2-product"><b>BTC 智能交易控制台</b><small>MARKET MONITOR · 五分钟 / 十分钟</small></div>'
         '</div><nav class="zl-v2-tabs" aria-label="三个机器人切换">'+nav+'</nav></div></header>')
def styles(css):
 if MARKER not in css or "</style>" in css or chr(96) in css or "$"+"{" in css:raise ValueError("INVALID_CSS")
 return '<style id="zl-mintech-v2">'+css+'</style>'
def patch(name,src,css):
 if 'id="zl-mintech-v2"' in src:return src
 decor=bar(name)
 style=styles(css)
 if name=="single":
  old="""function injectStats(html) {
  html=injectDual5RobotMenu(html);
  html=injectFast5Dashboard(html);
  if(html.includes('</head>')&&!html.includes('id="zl-mintech-theme"'))
    html=html.replace('</head>',ZL_MINTECH_STYLE+'</head>');
  return html;
}"""
  updated="""function injectStats(html) {
  html=injectDual5RobotMenu(html);
  html=injectFast5Dashboard(html);
  if(html.includes('</head>')&&!html.includes('id="zl-mintech-theme"'))
    html=html.replace('</head>',ZL_MINTECH_STYLE+'</head>');
  if(html.includes('</head>')&&!html.includes('id="zl-mintech-v2"'))
    html=html.replace('</head>',ZL_THEME_V2+'</head>');
  if(!html.includes('data-zl-theme="v2"'))
    html=html.replace(/(<body[^>]*>)/i,'$1'+ZL_HEADER_V2);
  return html;
}"""
  src=once(src,old,updated)
  # JSON-encoded JS strings ensure the header cannot terminate a template literal.
  anchor="function injectStats(html) {"
  prefix="const ZL_THEME_V2 = "+json.dumps(style,ensure_ascii=False)+";\n"
  prefix+="const ZL_HEADER_V2 = "+json.dumps(decor,ensure_ascii=False)+";\n"
  src=once(src,anchor,prefix+anchor)
 else:
  src=once(src,"</head>",style+"</head>")
  src=once(src,"<body>","<body>"+decor)
 return src
def validate(name,src):
 # source single has one V2 style literal and one V2 idempotency check;
 # both event/dual have literal inserted markup.
 need=2 if name=="single" else 1
 if src.count('id="zl-mintech-v2"')!=need:
  raise ValueError("V2_STYLE_NOT_PRESENT_OR_DUPLICATED_"+name)
 if name=="single":
  for marker in ["ZL_THEME_V2","ZL_HEADER_V2","injectDual5RobotMenu(html)","injectFast5Dashboard(html)","data-zl-theme"]:
   if marker not in src:raise ValueError("SINGLE_MISSING_"+marker)
 else:
  if src.count('data-zl-theme="v2"')!=1:raise ValueError("V2_HEADER_MISSING_"+name)
  for href in ("/dual5","/event10/"):
   if href not in src:raise ValueError("NAV_NOT_PRESENT_"+name)
 if name=="dual" and "/api/dual5-arm" not in src:raise ValueError("DUAL_ARM_MISSING")
 if name=="event10" and 'id="start"' not in src:raise ValueError("EVENT10_MANUAL_BUTTON_MISSING")
def main():
 p=argparse.ArgumentParser()
 p.add_argument("--css",required=True)
 p.add_argument("--dry-run",action="store_true")
 args=p.parse_args()
 css=Path(args.css).read_text(encoding="utf8")
 out={}
 for name,path in FILES.items():
  src=path.read_text(encoding="utf8")
  dst=patch(name,src,css)
  validate(name,dst)
  out[name]=(path,src,dst)
  print("V2_PREFLIGHT",name,"changed",src!=dst,"bytes",len(src),len(dst))
 if args.dry_run:return
 for name,(path,src,dst) in out.items():
  if src!=dst:
   tmp=path.with_name(path.name+".v2.stage")
   tmp.write_text(dst,encoding="utf8")
   st=path.stat()
   os.chmod(tmp,st.st_mode&0o777)
   os.chown(tmp,st.st_uid,st.st_gid)
   os.replace(tmp,path)
  print("V2_UI_WRITTEN",name)
if __name__=="__main__":main()
