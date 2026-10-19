import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const read=name=>fs.readFileSync(new URL('./'+name,import.meta.url),'utf8');
const index=read('index.mjs');
const wrapper=read('wrapper.mjs');
const panel=read('panel-stats-shell.mjs');
test('Alibaba-only trading gate does not inherit Render environment authorization',()=>{
 assert.match(index,/function deploymentAllowsLiveFollowing\(\)/);
 assert.match(index,/ZL_OUTER_AUTH_ONLY==='true'/);
 assert.match(index,/ZL_PUBLIC_ORIGIN==='https:\/\/prediction\.47-237-188-69\.sslip\.io'/);
 assert.match(index,/body\.enabled === true && !deploymentAllowsLiveFollowing\(\)/);
 assert.doesNotMatch(index,/实盘开关尚未获得部署授权/);
 assert.match(index,/if \(!pinOK\(body\.pin, req\)\)/);
 assert.match(index,/x-zl-verified-login/);
 assert.match(index,/sec-fetch-site/);
 assert.match(index,/startAfterRound = current\?\.round \?\? null/);
 assert.match(index,/pendingAction = null/);
});
test('automatic following has one and only one READY handler',()=>{
 assert.doesNotMatch(index,/void processOrderConfirmation\(makeInternalOrderResult/);
 assert.match(wrapper,/submitPendingOrder\(pendingAction, \{ source: 'auto' \}\)/);
 assert.match(wrapper,/AUTO_CONFIRM_ENABLED && enabled && !autoConfirmHalted/);
 assert.match(wrapper,/autoAttemptedRounds\.has\(String\(p\.round\)\)/);
 assert.match(wrapper,/claimOrderSubmitAttempt\(p\.round\)/);
 assert.match(wrapper,/submittedRounds\.has\(String\(p\.round\)\)/);
 assert.match(wrapper,/if \(!enabled\)/);
});
test('owner control uses authenticated website, no legacy PIN in browser request',()=>{
 assert.match(wrapper,/request\('POST','\/api\/control',\{enabled:v,amount:v&&amountEl\?amountEl\.value:undefined\}/);
 assert.doesNotMatch(wrapper,/request\('POST','\/api\/control',[^\n]*pin:/);
 assert.match(wrapper,/if \(!pinOK\(body\.pin, req\)\)/);
 assert.match(wrapper,/request\('POST','\/api\/confirm',\{confirmationToken:currentPending\.confirmationToken\}/);
 assert.match(panel,/url\.pathname === '\/api\/round-stats'/);
});
test('amount minimum and actual trading safeguard remain in production',()=>{
 assert.match(index,/Number\(amount\) < 1/);
 assert.match(index,/startAfterRound/);
 assert.match(wrapper,/currentRetry\.status!=='LOCKED'/);
 assert.match(wrapper,/RETRY_ABORTED/);
 assert.match(wrapper,/MAX_ORDER_SUBMIT_ATTEMPTS/);
});
