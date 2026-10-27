// Visible, fixed-source menu linking the separate Binance double-side production panel.
// Idempotent and safe: HTML only, no order endpoints, no settings mutation.
const ID='dual5RobotMenu';
const HTML=String.raw`<nav id="dual5RobotMenu" aria-label="预测机器人菜单" style="margin:12px 0 16px;padding:14px 16px;border-radius:13px;border:1px solid #40506a;background:#162538;color:#f1f5fb;display:block">
  <div style="font-size:13px;color:#b4c4db;margin-bottom:9px;font-weight:650">机器人切换 · 阿里云生产站点</div>
  <div style="display:flex;flex-wrap:wrap;gap:10px">
    <a href="/" id="dual5NavFast5" style="display:inline-flex;align-items:center;justify-content:center;min-height:44px;border-radius:9px;padding:10px 15px;background:#27354b;color:#eff7ff;text-decoration:none;font-weight:700">BTC 五分钟 FAST5</a>
    <a href="/dual5" id="dual5NavPair" style="display:inline-flex;align-items:center;justify-content:center;min-height:44px;border-radius:9px;padding:10px 15px;background:#126a88;color:#fff;text-decoration:none;font-weight:800">UP + DOWN 双边机器人</a>
  </div>
  <p style="font-size:12px;color:#acc0d7;margin:10px 0 0">双边机器人有独立实盘开关和 UP、DOWN 两套止盈止损。进入页面不会自动开启交易。</p>
</nav>`;
export function injectDual5RobotMenu(html){
  if(typeof html!=='string'||!html.includes('</body>')||html.includes('id="'+ID+'"'))return html;
  const root='<div class="w">';
  if(html.includes(root))return html.replace(root,root+'\n'+HTML);
  if(html.includes('<body>'))return html.replace('<body>','<body>'+HTML);
  return html.replace('</body>',HTML+'</body>');
}
