// Presentation-only navigation for independent Binance 5m UP+DOWN pair bot.
// This is not a trade/model selector and does not toggle any live execution.
export const robotMenuHtml = `<nav id="zlRobotMenu" aria-label="机器人切换" style="background:#191d27;border:1px solid #3a516f;border-radius:16px;padding:15px;margin:0 0 16px">
<div style="font-size:15px;font-weight:800;margin-bottom:10px">机器人切换</div>
<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(125px,1fr));gap:8px">
<a href="/" aria-current="page" style="display:block;text-align:center;text-decoration:none;background:#1b513f;border:1px solid #3ddc84;border-radius:10px;padding:12px 7px;color:#e5fff0;font-weight:750;font-size:14px">5分钟趋势预测</a>
<a href="/dual5" id="zlDual5RobotLink" style="display:block;text-align:center;text-decoration:none;background:#263c5c;border:1px solid #638bd2;border-radius:10px;padding:12px 7px;color:#e9f2ff;font-weight:750;font-size:14px">5分钟UP+DOWN双边</a>
<a href="/api-keys/" style="display:block;text-align:center;text-decoration:none;background:#252d3b;border:1px solid #485b76;border-radius:10px;padding:12px 7px;color:#d9e5f5;font-size:14px">机器人 / API 管理</a>
</div>
<div style="font-size:12px;color:#a8b0bd;margin-top:9px">双边机器人使用独立实盘开关及独立的 UP/DOWN 止盈止损，切换页面不会自动启动交易。</div>
</nav>`;
export function injectRobotMenu(html){
 if(typeof html!=='string'||!html.includes('</body>'))return html;
 if(html.includes('id="zlRobotMenu"'))return html;
 if(html.includes('<div class="w">'))
  return html.replace('<div class="w">','<div class="w">'+robotMenuHtml);
 if(html.includes('<body>'))return html.replace('<body>','<body>'+robotMenuHtml);
 return html;
}
