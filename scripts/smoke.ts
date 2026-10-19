import { spawn } from 'node:child_process';
import {mkdtemp,rm,writeFile,readFile,mkdir,copyFile,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,relative,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
const root=await mkdtemp(join(tmpdir(),'escrow-smoke-'));
const child=spawn(process.execPath,[fileURLToPath(new URL('../src/server.js',import.meta.url))],{cwd:root,env:{...process.env,PANEL_PORT:'0'},windowsHide:true,stdio:['ignore','pipe','pipe']});
let logs='';child.stdout.on('data',c=>logs+=c);child.stderr.on('data',c=>logs+=c);
let base='';
let controlKey='';
async function post(path:string,body:unknown){
  const response=await fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json','x-control-key':controlKey},body:JSON.stringify(body)});
  const value:any=await response.json();if(!response.ok)throw new Error(JSON.stringify(value));return value;
}
try{
  let ready=false;
  for(let i=0;i<100;i++){
    if(child.exitCode!==null)throw new Error(logs);
    const line=logs.split('\n').find(s=>s.startsWith('READY '));
    if(line){base=JSON.parse(line.slice(6)).url;ready=true;break;}
    await new Promise(r=>setTimeout(r,200));
  }
  if(!ready)throw new Error('模拟服务启动超时 '+logs);
  controlKey=((await (await fetch(base+'/api/session')).json()) as {controlKey:string}).controlKey;
  const timeoutSettings:any=await (await fetch(base+'/api/timeouts')).json();await post('/api/timeouts',{...timeoutSettings.policy,reminderMinutes:120});
  const invalidTimeout=await fetch(base+'/api/timeouts',{method:'POST',headers:{'Content-Type':'application/json','x-control-key':controlKey},body:JSON.stringify({...timeoutSettings.policy,reminderMinutes:0})});assert.equal(invalidTimeout.status,400);
  const o=await post('/orders',{kind:'PRODUCT',buyerId:'1001',sellerId:'1002',principal:'100',fee:'5',buyerAddress:'sim:buyer',sellerAddress:'sim:seller',description:'HTTP 完整流程测试'});
  await post(`/orders/${o.id}/accept`,{actor:'1001',version:1});
  await post(`/orders/${o.id}/accept`,{actor:'1002',version:1});
  const funded=await post(`/orders/${o.id}/deposit`,{network:'SIMULATED_TRON',token:'SIM_USDT',txHash:`simtx:${o.id}`,eventIndex:0,amount:'105',confirmed:true,success:true,to:o.deposit_address});
  assert.equal(funded.state,'FUNDED');
  await post(`/orders/${o.id}/action`,{actor:'1002',action:'DECLARE'});
  await post(`/orders/${o.id}/action`,{actor:'1001',action:'RELEASE'});
  const payouts=await post(`/orders/${o.id}/broadcast`,{});
  const done=await post(`/orders/${o.id}/confirm`,{payoutId:payouts[0].id,txHash:payouts[0].tx_hash});
  assert.equal(done.state,'COMPLETED');
  const unauthorized=await fetch(base+'/api/maintenance/backup',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});assert.equal(unauthorized.status,403);
  await writeFile(join(root,'.env'),'BOT_BRAND="Smoke fixture"\nFIXTURE_SECRET="local-only"\n');
  const info=await post('/api/maintenance/backup',{password:'smoke-password-123'});
  const restored=await post('/api/maintenance/verify',{id:info.id,password:'smoke-password-123'});assert.equal(restored.verified,true);assert.equal(restored.summary.orders,1);
  const maintenance:any=await (await fetch(base+'/api/maintenance')).json();assert.equal(maintenance.lastRestore.directory,restored.directory);
  const before:any=await (await fetch(base+'/health')).json();
  await assert.rejects(post('/api/maintenance/shutdown',{expectedInstance:'wrong-instance'}));
  // A separate fixture manager deliberately fails compilation before any shutdown.
  await mkdir(join(root,'scripts'),{recursive:true});await mkdir(join(root,'node_modules/typescript/bin'),{recursive:true});
  await writeFile(join(root,'package.json'),'{"type":"module"}');
  await copyFile(fileURLToPath(new URL('../../scripts/manage-panel.mjs',import.meta.url)),join(root,'scripts/manage-panel.mjs'));
  await writeFile(join(root,'node_modules/typescript/bin/tsc.js'),'process.exit(1);');
  const failed=spawn(process.execPath,[join(root,'scripts/manage-panel.mjs'),'update',base],{cwd:root,windowsHide:true,env:{...process.env,ESCROW_WORKSPACE:root},stdio:'ignore'});
  assert.equal(await new Promise(resolve=>failed.once('exit',resolve)),1);
  const still:any=await (await fetch(base+'/health')).json();assert.equal(still.instanceId,before.instanceId);
  await writeFile(join(root,'data/maintenance.lock'),JSON.stringify({pid:process.pid,id:'live-fixture-owner'}));
  const duplicate=spawn(process.execPath,[join(root,'scripts/manage-panel.mjs'),'update',base],{cwd:root,windowsHide:true,env:{...process.env,ESCROW_WORKSPACE:root},stdio:'ignore'});
  assert.equal(await new Promise(resolve=>duplicate.once('exit',resolve)),1);
  assert.equal(JSON.parse(await readFile(join(root,'data/maintenance.lock'),'utf8')).id,'live-fixture-owner');
  await writeFile(join(root,'data/maintenance.lock'),JSON.stringify({pid:failed.pid,id:'exited-fixture-owner'}));
  await post('/api/maintenance/restart',{});
  let restarted=false;
  for(let n=0;n<180;n++){await new Promise(r=>setTimeout(r,500));try{const h:any=await (await fetch(base+'/health')).json();const job=JSON.parse(await readFile(join(root,'data/maintenance-status.json'),'utf8'));if(job.state==='failed')throw Error(job.message);if(h.instanceId!==before.instanceId&&job.state==='completed'){restarted=true;break;}}catch(error){if(error instanceof Error&&error.message.includes('编译'))throw error;}}
  assert.equal(restarted,true,'更新重启成功');controlKey=((await (await fetch(base+'/api/session')).json()) as {controlKey:string}).controlKey;
  assert.equal((await readdir(join(root,'data'))).some(name=>name.startsWith('maintenance-abandoned-')),true);
  assert.equal((await (await fetch(base+`/orders/${o.id}`)).json() as any).state,'COMPLETED');
  assert.equal((await (await fetch(base+'/api/timeouts')).json() as any).policy.reminderMinutes,120);
  process.stdout.write(JSON.stringify({timeoutSettings:'passed',http:'passed',backup:'passed',restart:'passed',compileFailurePreservesService:'passed',maintenanceLockRecovery:'passed',mode:'simulation',finalState:done.state})+'\n');
}finally{
  if(base){try{controlKey=((await (await fetch(base+'/api/session')).json()) as any).controlKey;const health:any=await (await fetch(base+'/health')).json();await post('/api/maintenance/shutdown',{expectedInstance:health.instanceId});}catch{}}
  let closed=false;for(let i=0;i<100;i++){try{await readFile(join(root,'data/panel-live.lock'));}catch{closed=true;break;}await new Promise(r=>setTimeout(r,200));}
  if(closed){const rel=relative(resolve(tmpdir()),resolve(root));assert(!isAbsolute(rel)&&!rel.startsWith('..')&&rel.startsWith('escrow-smoke-'));await rm(root,{recursive:true,force:true});}
}
