import {spawn} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {mkdir,open,readFile,writeFile,unlink,access,lstat,rename} from 'node:fs/promises';
import {resolve,join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
const sourceRoot=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const root=resolve(process.env.ESCROW_WORKSPACE||sourceRoot),action=process.argv[2]||'start';
const url=new URL(process.argv[3]||'http://127.0.0.1:8781');
if(url.hostname!=='127.0.0.1' || url.protocol!=='http:')throw Error('仅允许本机服务');
const workspaceId=createHash('sha256').update(root.toLowerCase()).digest('hex').slice(0,24);
const data=join(root,'data');await mkdir(data,{recursive:true});
if((await lstat(data)).isSymbolicLink())throw Error('服务数据目录不能是链接');
const status=async(state,message)=>writeFile(join(data,'maintenance-status.json'),JSON.stringify({state,message,updatedAt:new Date().toISOString()}));
const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function get(path){const response=await fetch(new URL(path,url),{signal:AbortSignal.timeout(2000)});if(!response.ok)throw Error('服务尚未就绪');return response.json();}
async function identity(){const health=await get('/health');if(health.application!=='telegram-usdt-escrow' || health.workspaceId!==workspaceId || !health.instanceId)throw Error('当前服务不支持安全重启，或属于其他项目。请手动重启一次以加载新版本。');return health;}
async function post(path,body){const {controlKey}=await get('/api/session');const response=await fetch(new URL(path,url),{method:'POST',headers:{'Content-Type':'application/json','x-control-key':controlKey},body:JSON.stringify(body),signal:AbortSignal.timeout(60000)});if(!response.ok)throw Error('服务拒绝维护请求');return response.json();}
function run(args,cwd){return new Promise((ok,no)=>{const p=spawn(process.execPath,args,{cwd,windowsHide:true,stdio:'inherit'});p.once('error',no);p.once('exit',code=>code===0?ok():no(Error('编译失败，旧服务继续运行')));});}
let lock;
const lockPath=join(data,'maintenance.lock'),lockId=randomUUID();
try{
  try{lock=await open(lockPath,'wx');}catch(error){
    if(error.code!=='EEXIST')throw error;
    if((await lstat(lockPath)).isSymbolicLink())throw Error('维护锁不能是链接');
    let prior;try{prior=JSON.parse(await readFile(lockPath,'utf8'));}catch{throw Error('旧维护锁需要人工核对');}
    if(!Number.isSafeInteger(prior.pid)||prior.pid<=0)throw Error('维护锁需要人工核对');
    let alive=true;try{process.kill(prior.pid,0);}catch(e){if(e.code==='ESRCH')alive=false;}
    if(alive)throw error;
    await rename(lockPath,join(data,`maintenance-abandoned-${randomUUID()}.json`));
    lock=await open(lockPath,'wx');
  }
  await lock.writeFile(JSON.stringify({pid:process.pid,id:lockId,createdAt:new Date().toISOString()}));
  await status('running','正在检查本地服务');
  let previous=null;
  try{await get('/health');previous=await identity();}catch(error){if(error.message.includes('手动重启'))throw error;if(action!=='start')throw Error('本地服务未启动，请先启动控制面板');}
  if(action==='start' && previous){await status('completed','控制面板已经运行');process.stdout.write(url.href+'\n');}
  else{
    if(!['start','update','stop'].includes(action))throw Error('无效维护操作');
    if(action!=='stop'){
      await status('running','正在编译；失败时保留旧服务');
      const require=createRequire(join(sourceRoot,'package.json'));
      await run([require.resolve('typescript/bin/tsc')],sourceRoot);
      await run([join(sourceRoot,'scripts/write-build-info.mjs')],sourceRoot);
    }
    if(previous){
      const current=await identity();if(current.instanceId!==previous.instanceId)throw Error('服务实例发生变化，请重试');
      await status('running','正在正常停止机器人和数据库');
      await post('/api/maintenance/shutdown',{expectedInstance:previous.instanceId});
      let closed=false;
      for(let n=0;n<120;n++){let listening=true,locked=true;try{await get('/health');}catch{listening=false;}try{await access(join(data,'panel-live.lock'));}catch{locked=false;}if(!listening&&!locked){closed=true;break;}await wait(500);}
      if(!closed)throw Error('服务尚未完全停止，未启动第二个实例');
    }
    if(action!=='stop'){
      const log=await open(join(data,'panel-output.log'),'a');
      const child=spawn(process.execPath,[join(sourceRoot,'dist/src/server.js')],{cwd:root,windowsHide:true,detached:true,stdio:['ignore',log.fd,log.fd],env:{...process.env,PANEL_PORT:url.port||'80'}});
      let launchError=false;child.once('error',()=>{launchError=true;});child.unref();await log.close();let current;
      for(let n=0;n<120;n++){if(launchError)throw Error('服务启动失败');try{current=await identity();break;}catch{}await wait(500);}
      if(!current)throw Error('启动超时，请检查 data/panel-output.log');
      if(previous?.telegramConnected)await post('/api/bot/start',{});
      await status('completed','更新重启完成');process.stdout.write(url.href+'\n');
    }else await status('completed','控制面板已正常停止');
  }
}catch(error){if(lock)await status('failed',error.message);process.stderr.write((error.code==='EEXIST'?'已有维护任务在执行':error.message)+'\n');process.exitCode=1;}
finally{if(lock){await lock.close();const saved=JSON.parse(await readFile(lockPath,'utf8'));if(saved.pid===process.pid&&saved.id===lockId)await unlink(lockPath);}}
