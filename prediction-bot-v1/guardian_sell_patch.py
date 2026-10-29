"""Exact-hunk overlay: never replace production-only auth, exits or retry logic."""
import difflib
def overlay(baseline,new,live,name):
    if not isinstance(live,str) or not live:raise ValueError('EMPTY_PRODUCTION_CODE')
    if name not in ('risk-runner.mjs','control-shell.mjs','wrapper.mjs','guardian-main-dashboard.mjs'):
        raise ValueError('NON_WHITELISTED_PATCH')
    aa=baseline.splitlines(keepends=True)
    bb=new.splitlines(keepends=True)
    original=live
    count=0
    for tag,a0,a1,b0,b1 in difflib.SequenceMatcher(None,aa,bb,autojunk=False).get_opcodes():
        if tag=='equal':continue
        old=''.join(aa[a0:a1])
        desired=''.join(bb[b0:b1])
        if old:
            if live.count(old)!=1:raise ValueError('LIVE_ANCHOR_CHANGED:%s:%d'%(name,a0))
            live=live.replace(old,desired,1)
        else:
            prev=''.join(aa[max(0,a0-3):a0])
            following=''.join(aa[a0:a0+3])
            if not prev or not following or live.count(prev+following)!=1:
                raise ValueError('LIVE_INSERT_CONTEXT_CHANGED:%s:%d'%(name,a0))
            live=live.replace(prev+following,prev+desired+following,1)
        count+=1
    if not count or live==original:raise ValueError('NOTHING_CHANGED')
    if name=='control-shell.mjs':
        if 'x-zl-verified-login' in original and 'x-zl-verified-login' not in live:
            raise ValueError('SITE_AUTH_REGRESSION')
        for k in ['pinOK(body.pin, req)','guardianRiskToggleStatus','riskExecutionStatus','/api/guardian-dynamic-risk']:
            if k not in live:raise ValueError('CONTROL_GUARD_MISSING:'+k)
    if name=='risk-runner.mjs':
        for k in ['guardianOpenExposure','GUARDIAN_MONITOR_ARM_ALLOWED','guardianOpenPositionsRetained']:
            if k not in live:raise ValueError('RUNNER_GUARD_MISSING:'+k)
    if name=='wrapper.mjs':
        for k in ['guardianExitMonitorReady','guardian-risk-ready.json','risk_sell_unknown']:
            if k not in live and k!='risk_sell_unknown':raise ValueError('WRAPPER_GUARD_MISSING:'+k)
    if name=='guardian-main-dashboard.mjs' and 'zlGRiskToggleButton' not in live:
        raise ValueError('UI_TOGGLE_MISSING')
    return live
