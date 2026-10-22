#!/usr/bin/env python3
"""Patch ACTUAL live control-shell response, not dormant panel-stats-shell.
Imports only CARD/JS source literals, never executes donor's module body.
"""
from pathlib import Path
import ast,sys,json
assert len(sys.argv)==4,'USAGE SOURCE LIVE_CONTROL_SHELL OUT'
donor,live,out=map(Path,sys.argv[1:4])
tree=ast.parse(donor.read_text())
parts={}
for n in tree.body:
 if isinstance(n,ast.Assign):
  for target in n.targets:
   if isinstance(target,ast.Name) and target.id in ('CARD','JS'):
    parts[target.id]=ast.literal_eval(n.value)
assert len(parts)==2
card=parts['CARD'];js=parts['JS']
src=live.read_text()
anchor='function injectRiskControls(html) {'
end_marker='  return out;\n}\n\nlet inner = null;'
route="  if (req.method === 'GET' && url.pathname === '/api/risk-control') {"
assert src.count(anchor)==1,'LIVE_CONTROL_SHELL_NOT_FOUND'
assert src.count(end_marker)==1,'RISK_PAGE_TRANSFORM_CHANGED'
assert src.count(route)==1,'LIVE_READ_ROUTE_CHANGED'
assert 'roundResultsOnlyCard' not in src,'RESULT_PANEL_ALREADY_PATCHED'
assert 'function injectRiskControls(html)' in src
assert 'riskControlsAnchor' in src
inject="const roundResultsOnlyCard="+json.dumps(card,ensure_ascii=False)+";\n"
inject+="const roundResultsOnlyScript="+json.dumps('<script>'+js+'</script>',ensure_ascii=False)+";\n"
inject+=r"""function injectRoundResults(html) {
  if(html.includes('id="roundResultsOnlyCard"'))return html;
  // Show the results near the TOP of the real prediction page, not below controls.
  const anchor='<div class="w">';
  const inserted=html.includes(anchor)
    ?html.replace(anchor,anchor+roundResultsOnlyCard)
    :html.replace('<div id="riskControlsAnchor"></div>',
      roundResultsOnlyCard+'<div id="riskControlsAnchor"></div>');
  return inserted.replace('</body>',roundResultsOnlyScript+'</body>');
}
"""
src=src.replace(anchor,inject+'\n'+anchor,1)
src=src.replace("  if (html.includes('id=\"slCard\"')) return html;", "  if (html.includes('id=\"slCard\"')) return injectRoundResults(html);", 1)
src=src.replace(end_marker,'  return injectRoundResults(out);\n}\n\nlet inner = null;',1)
route_body=r"""  // Display-only route. Does not change the trading handler.
  if(req.method==='GET'&&url.pathname==='/api/deepseek-round-results'){
    const limit=Math.max(1,Math.min(300,Number.parseInt(url.searchParams.get('limit'),10)||100));
    const r=http.get({hostname:'127.0.0.1',port:13029,
      path:'/api/round-results?limit='+limit,headers:{accept:'application/json'}},upstream=>{
       res.writeHead(upstream.statusCode||502,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});
       upstream.pipe(res);
    });
    r.setTimeout(5000,()=>r.destroy(new Error('RESULTS_SOURCE_TIMEOUT')));
    r.on('error',()=>{if(!res.headersSent){
      res.writeHead(502,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});
      res.end(JSON.stringify({ok:false,error:'ROUND_RESULTS_SOURCE_UNAVAILABLE'}));
    }else res.end();});
    return;
  }
"""
src=src.replace(route,route_body+route,1)
assert src.count('function injectRoundResults(html)')==1
assert src.count("url.pathname==='/api/deepseek-round-results'")==1
assert src.count('function injectRiskControls(html)')==1
assert src.count('roundResultsOnlyCard')>=2
out.write_text(src)
print('ACTIVE_CONTROL_SHELL_ROUND_RESULTS_PATCH_READY=true')
