#!/usr/bin/env python3
"""Read-only real browser render audit at 390px phone viewport; no clicks or submissions."""
import os,sys
from playwright.sync_api import sync_playwright

PAGES=(
 ("单边预测","https://prediction.47-237-188-69.sslip.io/?zl_view=phone-v2"),
 ("双边套利","https://prediction.47-237-188-69.sslip.io/dual5?zl_view=phone-v2"),
 ("10分钟分析","https://47-237-188-69.sslip.io/event10/?zl_view=phone-v2"),
)
def main():
 password=os.getenv("ZL_PANEL_PASSWORD","")
 if not password:
  print("BROWSER_MISSING_AUTH")
  return 2
 with sync_playwright() as p:
  browser=p.chromium.launch(headless=True,args=["--no-sandbox","--disable-dev-shm-usage"])
  ctx=browser.new_context(
    viewport={"width":390,"height":844},
    device_scale_factor=2,
    is_mobile=True,
    has_touch=True,
    http_credentials={"username":"zl","password":password})
  ctx.set_default_timeout(15000)
  for name,url in PAGES:
   page=ctx.new_page()
   try:
    response=page.goto(url,wait_until="domcontentloaded",timeout=30000)
    if response is None or response.status!=200:raise RuntimeError("INVALID_PAGE_HTTP")
    header=page.locator("header.zl-v2-bar")
    if not header.is_visible():raise RuntimeError("REAL_HEADER_NOT_VISIBLE")
    if page.locator(".zl-v2-tabs a").count()!=3:raise RuntimeError("THREE_NAV_LINKS_NOT_VISIBLE")
    if page.locator("style#zl-mintech-v2").count()!=1:raise RuntimeError("THEME_STYLES_NOT_IN_DOM")
    if not page.locator("main h1, .w h1, h1").first.is_visible():raise RuntimeError("ACTUAL_PAGE_TITLE_NOT_VISIBLE")
    state=page.evaluate("""() => {
      const h=document.querySelector('header.zl-v2-bar');
      const links=[...h.querySelectorAll('.zl-v2-tabs a')];
      const hero=h.getBoundingClientRect();
      return {
        viewport:window.innerWidth,
        barHeight:Math.round(hero.height),
        barWidth:Math.round(hero.width),
        themeBg:getComputedStyle(h).backgroundColor,
        navColumnCount:links.length,
        navLabels:links.map(x=>x.innerText),
        activeTab:links.find(x=>x.getAttribute('aria-current')==='page')?.innerText,
        title:document.querySelector('h1')?.innerText?.slice(0,65),
        cardCount:document.querySelectorAll('article,.card,.w>.c').length
      };
    }""")
    assert state["viewport"]==390,state
    assert state["barHeight"]>=60,state
    assert state["barWidth"]>=375,state
    assert state["activeTab"],state
    assert state["cardCount"]>=1,state
    print("REAL_PHONE_RENDER_OK",name,state)
   finally:
    page.close()
  browser.close()
 print("ALL_THREE_ACTUAL_MOBILE_BROWSER_RENDERED")
 return 0
if __name__=="__main__":sys.exit(main())
