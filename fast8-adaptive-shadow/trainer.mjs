import {parentPort,workerData} from 'node:worker_threads';
import {trainAdaptive} from './core.mjs';
try { parentPort.postMessage({ok:true,result:trainAdaptive(workerData.rows)}); }
catch(error){parentPort.postMessage({ok:false,error:String(error?.message||error)}); }
