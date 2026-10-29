// GUARDIAN5 fixed-only readiness. Read actual shared runtime files; never infer
// protection from a UI switch or from the analysis service's readOnly flag.
import fs from 'node:fs';
import nodePath from 'node:path';

export function guardianRiskPaths(env=process.env) {
  const root=env.RISK_DATA_DIR||'/var/lib/zl-prediction/rounds';
  return {
    control:env.RISK_CONTROL_FILE||nodePath.join(root,'risk-control.json'),
    status:env.RISK_STATUS_FILE||nodePath.join(root,'risk-runtime-status.json'),
    health:env.RISK_WORKER_HEALTH_FILE||nodePath.join(root,'risk-worker-health.json'),
  };
}
function readJson(file) {
  try {
    const value=JSON.parse(fs.readFileSync(file,'utf8'));
    return value&&typeof value==='object'&&!Array.isArray(value)?value:null;
  } catch { return null; }
}
function fresh(iso,now,ttl) {
  if(typeof iso!=='string')return false;
  const ms=Date.parse(iso),age=now-ms;
  return Number.isFinite(age)&&age>=0&&age<=ttl;
}
export function guardianFixedReadiness({now=Date.now(),paths=guardianRiskPaths()}={}) {
  const config=readJson(paths.control);
  const runtime=readJson(paths.status);
  const health=readJson(paths.health);
  const result=(reason)=>({ready:reason===null,reason:reason||null,
    fixedTakeProfitEnabled:config?.takeProfitEnabled===true,
    fixedStopLossEnabled:config?.stopLossEnabled===true,
    dynamicExitEnabled:runtime?.guardianDynamicExitEnabled??null,
    workerRunning:runtime?.workerRunning===true,
    configApplied:runtime?.configApplied===true,
    positionsSeen:Number.isSafeInteger(health?.positionsSeen)?health.positionsSeen:null,
    lastSuccessfulPositionsAt:health?.lastSuccessfulPositionsAt??null});
  if(!config||!runtime||!health)return result('RISK_STATE_UNAVAILABLE');
  if(config.takeProfitEnabled!==true||config.stopLossEnabled!==true)
    return result('FIXED_EXIT_DISABLED');
  if(runtime.guardianDynamicExitEnabled!==false)
    return result('DYNAMIC_EXIT_NOT_RETIRED');
  if(runtime.transitioning===true||runtime.enabled!==true||
     runtime.workerRunning!==true||runtime.configApplied!==true)
    return result('RISK_WORKER_NOT_READY');
  if(!Number.isSafeInteger(runtime.workerPid)||runtime.workerPid<=0||
     runtime.workerPid!==health.pid)return result('RISK_WORKER_HEALTH_MISMATCH');
  if(!fresh(runtime.at,now,6000)||!fresh(health.at,now,6000)||
     !fresh(health.lastSuccessfulPositionsAt,now,10000))
    return result('RISK_HEARTBEAT_STALE');
  if(!Number.isSafeInteger(health.positionsSeen)||health.positionsSeen<0)
    return result('RISK_POSITION_CHECK_UNCONFIRMED');
  return result(null);
}
