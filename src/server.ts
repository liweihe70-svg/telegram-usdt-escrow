import { OrderTimeouts } from './order-timeouts.js';
import { EvidenceFiles } from './evidence-files.js';
import { createServer } from 'node:http';
import { randomUUID,createHash } from 'node:crypto';
import { readFile,mkdir,open,writeFile } from 'node:fs/promises';
import { resolve,join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Escrow,TEST_NETWORK } from './escrow.js';
import { amount } from './bot-ui.js';
import { BotController } from './bot-controller.js';
import { LocalSettings,LOCAL_ADMIN } from './local-settings.js';
import { BotRuntime } from './bot-runtime.js';
import { Backups } from './backup.js';
import { claimService } from './service-lock.js';
const root=resolve(process.cwd()),workspaceId=createHash('sha256').update(root.toLowerCase()).digest('hex').slice(0,24);
const application='telegram-usdt-escrow',instanceId=randomUUID(),controlKey=randomUUID();
let port=Number(process.env.PANEL_PORT??8781);
if(!Number.isSafeInteger(port) || port<0 || port>65535)throw new Error('无效本地端口');
let ready=false,stopping=false,busy=false,restartRequested=false,pendingMutations=0;
let escrow!:Escrow,runtime!:BotRuntime,backups!:Backups,releaseLock:(()=>Promise<void>)|undefined;
const config=new LocalSettings();
let timeouts:OrderTimeouts,timeoutTimer:ReturnType<typeof setInterval>|undefined,timeoutWork:Promise<void>|undefined;
function timeoutTick(){if(busy||stopping||timeoutWork)return;timeoutWork=timeouts.tick().catch(()=>{}).finally(()=>{timeoutWork=undefined;});}
let build:{version:string;buildId:string;builtAt:string|null}={version:'development',buildId:'unknown',builtAt:null};
try{build=JSON.parse(await readFile(new URL('../build-info.json',import.meta.url),'utf8'));}catch{}
const health=()=>({ok:true,application,workspaceId,instanceId,pid:process.pid,...build,mode:'simulation',realFunds:false,telegramConnected:runtime.status().state==='running'});
const drain=async()=>{while(pendingMutations)await new Promise(resolve=>setTimeout(resolve,25));};
const staticFiles:Record<string,[string,string]>={
  '/':['index.html','text/html; charset=utf-8'],'/app.js':['app.js','text/javascript; charset=utf-8'],'/panel-i18n.js':['panel-i18n.js','text/javascript; charset=utf-8'],'/style.css':['style.css','text/css; charset=utf-8']
};
const server=createServer(async(req,res)=>{
  let tracked=false;
  res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  const json=(value:unknown,status=200)=>{res.statusCode=status;res.setHeader('Content-Type','application/json; charset=utf-8');res.end(JSON.stringify(value));};
  try{
    if(!ready || stopping)return json({error:'服务正在启动或停止，请稍后刷新'},503);
    if(![`127.0.0.1:${port}`,`localhost:${port}`].includes(req.headers.host??''))return json({error:'仅限本机访问'},403);
    const url=new URL(req.url??'/',`http://127.0.0.1:${port}`);
    if(req.method==='GET' && staticFiles[url.pathname]){const [file,type]=staticFiles[url.pathname];res.setHeader('Content-Type',type);res.end(await readFile(new URL(`../../public/${file}`,import.meta.url)));return;}
    if(req.method==='GET' && url.pathname==='/api/session')return json({controlKey});
    const fileRoute=url.pathname.match(/^\/api\/evidence-files\/([a-f0-9-]+)$/);
    if(req.method==='GET'&&fileRoute){
      if(req.headers['x-control-key']!==controlKey)return json({error:'控制会话已失效，请刷新页面'},403);
      if(req.headers.origin&&![`http://127.0.0.1:${port}`,`http://localhost:${port}`].includes(req.headers.origin))return json({error:'请求来源无效'},403);
      const f=await new EvidenceFiles(escrow).read(fileRoute[1],LOCAL_ADMIN);res.setHeader('Content-Type',f.mime);res.setHeader('Content-Disposition',"attachment; filename*=UTF-8''"+encodeURIComponent(f.filename));res.end(Buffer.from(f.bytes));return;
    }
    if(req.method==='GET' && url.pathname==='/health')return json(health());
    if(req.method==='GET' && url.pathname==='/api/maintenance'){
      let operation=null;try{operation=JSON.parse(await readFile(join(root,'data/maintenance-status.json'),'utf8'));}catch{}
      let lastRestore=null;try{const r=JSON.parse(await readFile(join(root,'data/last-restore-check.json'),'utf8'));if(r.verified===true && /^data\/restore-checks\/[a-f0-9-]+$/.test(r.directory))lastRestore={verified:true,directory:r.directory};}catch{}
      return json({service:health(),busy,operation,lastRestore,backups:await backups.list()});
    }
    if(req.method==='GET' && url.pathname==='/api/timeouts')return json({policy:await timeouts.policy(),worker:timeouts.status(),reviews:await timeouts.reviews()});
    if(req.method==='GET' && url.pathname==='/api/settings')return json({...await config.public(),bot:runtime.status()});
    if(req.method==='GET' && url.pathname==='/api/overview'){
      const orders=(await escrow.db.query(`SELECT id,kind,buyer_id::text,seller_id::text,principal::text,fee::text,state,description,created_at FROM orders ORDER BY created_at DESC LIMIT 500`)).rows;
      const balances=(await escrow.db.query('SELECT account,sum(amount)::text AS balance FROM ledger_entries GROUP BY account ORDER BY account')).rows;
      const counts=(await escrow.db.query(`SELECT count(*)::int AS total,count(*) FILTER(WHERE state IN ('COMPLETED','ARBITRATED'))::int AS completed,count(*) FILTER(WHERE state='DISPUTED')::int AS disputed,count(*) FILTER(WHERE state='SETTLING')::int AS settling FROM orders`)).rows[0];
      const recent=(await escrow.db.query(`SELECT a.id,a.order_id,a.actor,a.event,a.created_at FROM audit_events a ORDER BY created_at DESC LIMIT 15`)).rows;
      const payouts=(await escrow.db.query(`SELECT p.id,s.order_id,p.recipient,p.amount::text,p.status,p.tx_hash FROM payouts p JOIN settlements s ON s.id=p.settlement_id ORDER BY s.created_at DESC LIMIT 200`)).rows;
      return json({orders,balances,counts,recent,payouts,bot:runtime.status(),mode:'simulation'});
    }
    const path=url.pathname.replace(/^\/api(?=\/orders)/,'');
    const route=path.match(/^\/orders\/([a-f0-9-]+)(?:\/(accept|deposit|action|arbitrate|broadcast|confirm|payouts|detail|fund|settle))?$/);
    if(req.method==='GET' && route){
      const id=route[1];
      if(route[2]==='detail')return json({order:await escrow.get(id),acceptances:(await escrow.db.query('SELECT user_id::text,terms_version FROM order_acceptances WHERE order_id=$1',[id])).rows,
        deposits:(await escrow.db.query('SELECT id,amount::text,classification,tx_hash,created_at FROM deposits WHERE order_id=$1 ORDER BY created_at',[id])).rows,
        payouts:await escrow.payouts(id),audit:(await escrow.db.query('SELECT actor,event,created_at FROM audit_events WHERE order_id=$1 ORDER BY created_at',[id])).rows,
        dispute:(await escrow.db.query('SELECT reason,decision,decided_by::text FROM disputes WHERE order_id=$1',[id])).rows[0]??null,
        timer:await timeouts.timer(id),
        files:await new EvidenceFiles(escrow).list(id),
        evidence:(await escrow.db.query('SELECT user_id::text,note,created_at FROM bot_evidence_notes WHERE order_id=$1 ORDER BY created_at,id',[id])).rows,
        groupBinding:(await escrow.db.query('SELECT chat_id::text,owner_id::text,state,language,expires_at FROM bot_group_bindings WHERE order_id=$1',[id])).rows[0]??null});
      return json(route[2]==='payouts'?await escrow.payouts(id):await escrow.get(id));
    }
    if(req.method!=='POST')return json({error:'路由不存在'},404);
    if(req.headers['x-control-key']!==controlKey)return json({error:'控制会话已失效，请刷新页面'},403);
    if(req.headers.origin && ![`http://127.0.0.1:${port}`,`http://localhost:${port}`].includes(req.headers.origin))return json({error:'请求来源无效'},403);
    if(busy || (restartRequested && url.pathname!=='/api/maintenance/shutdown'))return json({error:'维护任务正在执行，请稍后重试'},409);
    let raw='';for await(const chunk of req){raw+=chunk.toString();if(Buffer.byteLength(raw)>16384)throw new Error('请求过大');}
    const body=JSON.parse(raw);if(!body || Array.isArray(body) || typeof body!=='object')throw new Error('请求须为 JSON 对象');
    if(busy || (restartRequested && url.pathname!=='/api/maintenance/shutdown'))return json({error:'维护任务正在执行，请稍后重试'},409);
    if(url.pathname==='/api/maintenance/shutdown'){
      if(body.expectedInstance!==instanceId)throw new Error('服务实例已变化，拒绝停止');
      busy=true;await drain();res.once('finish',()=>void stop());json({accepted:true});return;
    }
    if(url.pathname==='/api/maintenance/restart'){
      restartRequested=true;await mkdir(join(root,'data'),{recursive:true});
      const log=await open(join(root,'data/maintenance-output.log'),'a');
      const child=spawn(process.execPath,[fileURLToPath(new URL('../../scripts/manage-panel.mjs',import.meta.url)),'update',`http://127.0.0.1:${port}`],{cwd:root,windowsHide:true,detached:true,stdio:['ignore',log.fd,log.fd],env:{...process.env,ESCROW_WORKSPACE:root}});
      child.once('error',()=>{restartRequested=false;});child.once('exit',()=>{restartRequested=false;});child.unref();await log.close();
      // The manager needs the shutdown endpoint while all other writes stay blocked.
      busy=false;json({accepted:true,instanceId});return;
    }
    if(url.pathname==='/api/maintenance/backup'){
      if(typeof body.password!=='string' || body.password.trim().length<12 || body.password.length>256)throw new Error('备份密码须为12至256个字符');
      busy=true;const running=runtime.status().state==='running';
      let result;try{await drain();if(timeoutWork)await timeoutWork;await runtime.quiesce();result=await backups.create(body.password);}
      finally{try{if(running)await runtime.start(await config.load());}finally{busy=false;}}
      return json(result);
    }
    if(url.pathname==='/api/maintenance/verify'){
      busy=true;try{const result=await backups.verify(body.id,body.password);await writeFile(join(root,'data/last-restore-check.json'),JSON.stringify(result),{mode:0o600});return json(result);}finally{busy=false;}
    }
    tracked=true;pendingMutations++;
    if(url.pathname==='/api/timeouts')return json(await timeouts.save(body));
    const resumeRoute=url.pathname.match(/^\/api\/timeouts\/([a-f0-9-]+)\/resume$/);if(resumeRoute){await timeouts.resume(resumeRoute[1],LOCAL_ADMIN,body.revision);return json({ok:true});}
    if(url.pathname==='/api/settings'){
      if(['running','starting','stopping'].includes(runtime.status().state))throw new Error('请先停止机器人，再修改配置');
      const saved=await config.save(body);escrow.setAdmins([LOCAL_ADMIN,...saved.admins]);return json(saved);
    }
    if(url.pathname==='/api/bot/start')return json(await runtime.start(await config.load()));
    if(url.pathname==='/api/bot/stop')return json(await runtime.stop());
    if(url.pathname==='/api/demo')return json(await createOrder({kind:body.kind==='P2P'?'P2P':'PRODUCT',buyerId:'1001',sellerId:'1002',principal:'100',description:'模拟演练：交付约定与验收，三天内完成。'}));
    let result;
    if(path==='/orders' && !url.pathname.startsWith('/api/'))result=await escrow.create(body);
    else if(url.pathname==='/api/orders')result=await createOrder(body);
    else if(route){
      const id=route[1];switch(route[2]){
        case 'accept':result=await escrow.accept(id,body.actor,body.version);break;
        case 'deposit':result=await escrow.deposit(id,body);break;
        case 'action':result=await escrow.act(id,body.actor,body.action,body.reason);break;
        case 'arbitrate':result=await escrow.arbitrate(id,LOCAL_ADMIN,body.buyerAmount,body.sellerAmount,body.reason);break;
        case 'broadcast':result=await escrow.broadcast(id);break;
        case 'confirm':result=await escrow.confirmPayout(id,body.payoutId,body.txHash);break;
        case 'fund':{const o=await escrow.get(id);result=await escrow.deposit(id,{network:TEST_NETWORK,token:'SIM_USDT',txHash:`simtx:${randomUUID()}`,eventIndex:0,amount:body.amount??amount(o.expected_deposit),confirmed:true,success:true,to:o.deposit_address});break;}
        case 'settle':{const payouts=await escrow.broadcast(id);for(const p of payouts)if(p.status!=='CONFIRMED')await escrow.confirmPayout(id,p.id,p.tx_hash!);result=await escrow.get(id);break;}
        default:return json({error:'路由不存在'},404);
      }
    }else return json({error:'路由不存在'},404);
    json(result);
  }catch(error){const internal=error && typeof error==='object' && ('code' in error || 'response' in error);if(!res.writableEnded)json({error:internal?'操作未成功，请检查输入或刷新订单。':error instanceof Error?error.message:'请求失败'},400);}
  finally{if(tracked)pendingMutations--;}
});
async function createOrder(body:any){const s=await config.load();const c=new BotController(escrow,{username:'LocalEscrow_bot',brand:s.brand,minimumFee:s.minimumFee,feeBps:s.feeBps});return escrow.create({kind:body.kind,buyerId:body.buyerId,sellerId:body.sellerId,principal:body.principal,fee:c.quote(body.principal),description:body.description,buyerAddress:`sim:tg_${body.buyerId}`,sellerAddress:`sim:tg_${body.sellerId}`});}
async function stop(){if(stopping)return;stopping=true;busy=true;
  const closed=new Promise<void>(resolve=>server.close(()=>resolve()));
  if(timeoutTimer)clearInterval(timeoutTimer);await drain();if(timeoutWork)await timeoutWork;if(runtime)await runtime.quiesce();await closed;if(escrow)await escrow.db.close();if(releaseLock)await releaseLock();process.exit(0);
}
process.on('SIGINT',()=>void stop());process.on('SIGTERM',()=>void stop());
try{
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
  port=(server.address() as {port:number}).port;
  releaseLock=await claimService(root,instanceId);
  const settings=await config.load();escrow=await Escrow.open('data/local-demo',[LOCAL_ADMIN,...settings.admins]);
  timeouts=new OrderTimeouts(escrow);runtime=new BotRuntime(escrow);backups=new Backups(root,escrow.db,join(root,'.env'));ready=true;timeoutTick();timeoutTimer=setInterval(timeoutTick,30000);
  process.stdout.write('本地控制面板：http://127.0.0.1:'+port+'\nREADY '+JSON.stringify({url:`http://127.0.0.1:${port}`,application,workspaceId,instanceId})+'\n');
}catch{process.stderr.write('本地服务启动失败，请检查端口、服务锁、配置或本地日志。\n');server.close();if(typeof escrow!=='undefined')await escrow.db.close();if(releaseLock)await releaseLock();process.exit(1);}
