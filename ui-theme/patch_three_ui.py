#!/usr/bin/env python3
"""UI-only: three standalone robot screens. No trading logic or API modifications."""
import argparse,os
from pathlib import Path
MARKER="ZL_MINIMAL_TECH_UI_20261028"
SINGLE=Path("/opt/zl-prediction-live/src/railway-diagnostic/panel-stats-shell.mjs")
DUAL=Path("/opt/zl-prediction-dual5/binance_dual5_dashboard.html")
EVENT10=Path("/opt/zl-event10/panel.html")
FILES={"single":SINGLE,"dual":DUAL,"event10":EVENT10}
ZH=r"""const zlStatusZh={
ARBITRAGE_EDGE_TOO_LOW_NO_ORDER:'套利收益不足，本轮不下单',
EDGE_BELOW_REQUIRED:'收益不足，自动跳过',
POSITIVE_EDGE:'已达套利收益门槛',
VALID_QUOTES:'有效报价',INVALID_QUOTES:'无效报价，不下单',
ROUND_ALREADY_ATTEMPTED:'本轮已处理，不重复下单',
ROUND_CLOSING_WAIT:'本轮即将结束，不再开仓',
LIVE_PAIR_SUBMISSION:'正在提交双边订单',
OPPORTUNITY_OBSERVED_TRADING_OFF:'已读取行情，实盘关闭',
FILLED_BOTH:'两边均已成交',
UNHEDGED_OR_UNKNOWN_MANUAL_REVIEW:'订单或持仓待核实',
ENTRY_WINDOW_ELAPSED:'已过本轮开仓时间',
UP_ZERO_FILL_CONFIRMED:'看涨订单未成交',
SUBMITTING_UP:'正在提交看涨订单',
SUBMITTING_DOWN:'正在提交看跌订单',
VERIFYING_UP:'正在核对看涨订单',
VERIFYING_DOWN:'正在核对看跌订单',
PREPARED:'正在准备订单',
UNHEDGED_OR_UNKNOWN_STOPPED:'订单状态异常，交易已暂停',
FILLED:'已成交',FAILED:'失败',ORDER_PENDING:'订单待确认'};
function zlZhStatus(v){
  if(v==null||v==='')return '暂无状态';
  const k=String(v).trim();
  if(zlStatusZh[k])return zlStatusZh[k];
  if(k.startsWith('NO_VALID_PAIR_'))return '暂无有效双边报价';
  if(k.includes('TIMEOUT')||k.includes('EXPIRED'))return '请求超时或报价过期';
  if(k.includes('ERROR')||k.includes('FAILED'))return '行情或订单检查失败';
  return /^[A-Z][A-Z0-9_]*$/.test(k)?'其他状态，请查看订单详情':k;
}
"""
def once(text,old,new):
    n=text.count(old)
    if n!=1:raise ValueError("UI_ANCHOR_UNEXPECTED "+old[:55]+" "+str(n))
    return text.replace(old,new,1)
def style(css):
    if MARKER not in css or "</style>" in css.lower() or chr(96) in css or "$"+"{" in css:
        raise ValueError("INVALID_INLINE_CSS")
    return '<style id="zl-mintech-theme">\n'+css+'\n</style>'
def patch(name,s,css):
    if 'id="zl-mintech-theme"' in s:return s
    themed=style(css)
    if name=="single":
        anchor="function injectStats(html) {\n  html=injectDual5RobotMenu(html); return injectFast5Dashboard(html); }"
        replacement="""function injectStats(html) {
  html=injectDual5RobotMenu(html);
  html=injectFast5Dashboard(html);
  if(html.includes('</head>')&&!html.includes('id="zl-mintech-theme"'))
    html=html.replace('</head>',ZL_MINTECH_STYLE+'</head>');
  return html;
}"""
        s=once(s,anchor,replacement)
        s=once(s,"function injectStats(html) {",
            "const ZL_MINTECH_STYLE = "+chr(96)+themed+chr(96)+";\n\nfunction injectStats(html) {")
    else:
        if '</head>' not in s or '</body>' not in s:raise ValueError("HTML_SHELL_UNKNOWN_"+name)
        s=once(s,"</head>",themed+"</head>")
        if name=="dual":
            el="const el=id=>document.getElementById(id),label=x=>x==null?'--':String(x),fmt=x=>Number.isFinite(Number(x))?Number(x).toFixed(4):'--';"
            s=once(s,el,ZH+"\n"+el)
            s=once(s,"label(d.health)","zlZhStatus(d.health)")
            s=once(s,"q?label(q.status):'等待有效市场'","q?zlZhStatus(q.status):'等待有效市场'")
            s=once(s,"['执行阶段',o.phase]","['执行阶段',zlZhStatus(o.phase)]")
            s=s.replace("配对净收益估计（仅展示，不拦截买单）","套利净收益估计（不足时不下单）")
            s=s.replace("开轮尽快尝试双边下单；没有盈利筛选，两笔独立订单可能亏损或只成交一边。",
                        "达到套利门槛才尝试交易；两边独立成交仍存在执行风险。")
            s=s.replace("每轮最多尝试一组；不再检查买价之和或预估净收益。",
                        "每轮最多尝试一组；净收益不足则不会下单。")
            s=s.replace("UP + DOWN 双边配对","双边套利")
    return s
def verify(name,s):
    if s.count('id="zl-mintech-theme"')!=1:raise ValueError("THEME_MARKER_MISSING_"+name)
    checks={"single":("injectDual5RobotMenu(html)","injectFast5Dashboard(html)","ZL_MINTECH_STYLE"),
            "dual":("/api/dual5-status","/api/dual5-arm","/api/dual5-risk","zlZhStatus(d.health)"),
            "event10":('id="start"','id="records"','id="immediatePrediction"','id="refresh"')}
    for needle in checks[name]:
        if needle not in s:raise ValueError("UI_CONTROL_NOT_PRESERVED_"+name+"_"+needle)
def write(path,s):
    tmp=path.with_name(path.name+".zl-ui-stage")
    tmp.write_text(s,encoding="utf8")
    st=path.stat()
    os.chmod(tmp,st.st_mode&0o777);os.chown(tmp,st.st_uid,st.st_gid)
    os.replace(tmp,path)
def main():
    ap=argparse.ArgumentParser();ap.add_argument("--css",required=True);ap.add_argument("--dry-run",action="store_true")
    args=ap.parse_args();css=Path(args.css).read_text(encoding="utf8")
    all_files={}
    for name,path in FILES.items():
        old=path.read_text(encoding="utf8")
        new=patch(name,old,css);verify(name,new)
        all_files[name]=(path,old,new)
        print("UI_PREFLIGHT",name,"changed",old!=new,"bytes",len(old),len(new))
    if args.dry_run:return
    for name,(path,old,new) in all_files.items():
        if old!=new:write(path,new)
        print("UI_THEME_WRITTEN",name)
if __name__=="__main__":main()
