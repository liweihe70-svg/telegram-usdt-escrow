import {createServer,type IncomingMessage,type ServerResponse} from 'node:http';
import {randomBytes,randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {AdminAuth} from './admin-auth.js';
import type {ProductionDatabase} from './database.js';
import {ProductionOrders} from './orders.js';
import {chainPolicy} from './bep20.js';
import {ProductionTelegramRuntime} from './telegram-runtime.js';
import {ProductionDepositMonitor} from './deposit-monitor.js';
import {ProductionPayouts} from './payouts.js';
import {ProductionGas} from './gas.js';
import {ProductionSweeps} from './sweeps.js';
import {ProductionReplacements} from './replacements.js';
import {ProductionTimeouts} from './timeouts.js';
import {ProductionCaseFiles} from './case-files.js';
import {ProductionBackups} from './backup.js';
import {ProductionAlerts} from './alerts.js';
import {ProductionManual,holdings} from './manual.js';
import {loadPlatformSettings,savePlatformSettings,effective} from './platform-settings.js';
import {HotWallet} from './hot-wallet.js';
import {revenueAddress,setRevenueAddress} from './revenue.js';
import {FixedCustody,setFixedAddress} from './fixed-custody.js';
import {loadWelcomeImage,saveWelcomeImage,welcomeImage,WELCOME_IMAGE_MAX} from './welcome-image.js';
import {ProductionAutomation} from './automation.js';
import {join as joinPath} from 'node:path';
import {chain,isMainnet,network,instanceFiles,limits} from './network.js';
import type {PGlite} from '@electric-sql/pglite';
import {ProductionCases} from './cases.js';

export function productionApp(db:ProductionDatabase,engine:string,identity:{workspaceId?:string;instanceId?:string;onStop?:()=>Promise<void>;botToken?:string;saveBotToken?:(token:string)=>Promise<void>;rpcUrl?:string;saveRpc?:(rpc:string)=>Promise<void>;backupRoot?:string}={}){
  const auth=new AdminAuth(db),setupNonce=randomBytes(32).toString('hex');
  const monitor=new ProductionDepositMonitor(db,identity.rpcUrl);
  const payouts=new ProductionPayouts(db,identity.rpcUrl,undefined,()=>monitor.running());
  const gas=new ProductionGas(db,payouts,identity.rpcUrl,undefined,()=>monitor.running());
  const sweeps=new ProductionSweeps(db,identity.rpcUrl,undefined,()=>monitor.running());
  const replacements=new ProductionReplacements(db,payouts,identity.rpcUrl,undefined,()=>monitor.running());
  const timeouts=new ProductionTimeouts(db);
  const alerts=new ProductionAlerts(db,(chat,text)=>bot.sendText(chat,text),async()=>monitor.status(),async()=>{const g=await gas.status() as {chain?:{native:string}|null};return g.chain?BigInt(g.chain.native):null;});
  const custody=new FixedCustody(db);let custodyTimer:ReturnType<typeof setInterval>|undefined;
  const wallet=new HotWallet(),automation=new ProductionAutomation(db,{payouts,gas,sweeps,replacements,wallet,monitoring:()=>monitor.running(),alert:(key,text)=>alerts.custom(key,text)});
  // Physical snapshots are only available for the embedded database; PostgreSQL uses its own tooling.
  const backups=identity.backupRoot&&engine==='pglite-local'?new ProductionBackups(identity.backupRoot,()=>(db as unknown as PGlite).dumpDataDir('gzip') as Promise<Blob>,joinPath(identity.backupRoot,instanceFiles().envFile),isMainnet()?'production-mainnet':'production'):null;
  const bot=new ProductionTelegramRuntime(db,identity.botToken,()=>monitor.running(),()=>true);
  let ready=false,mutations=0,closing=false;
  const sessions=(req:IncomingMessage)=>req.headers.cookie?.split(';').map(v=>v.trim()).find(v=>v.startsWith('escrow_production='))?.slice('escrow_production='.length)??'';
  const json=(res:ServerResponse,body:unknown,status=200)=>{res.statusCode=status;res.setHeader('Content-Type','application/json; charset=utf-8');res.end(JSON.stringify(body));};
  const error=(message:string,status:number)=>Object.assign(new Error(message),{httpStatus:status});
  const body=async(req:IncomingMessage)=>{
    if(!req.headers['content-type']?.startsWith('application/json'))throw error('需要 JSON 请求',415);
    const chunks:Buffer[]=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>16384)throw error('请求过大',413);chunks.push(Buffer.from(chunk));}
    try{const parsed=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(!parsed||Array.isArray(parsed)||typeof parsed!=='object')throw Error();return parsed;}catch{throw error('无效请求内容',400);}
  };
  const policy=async()=>{
    const setting=(await db.query<{chain_id:number;token_contract:string|null}>('SELECT chain_id,token_contract FROM production_chain_settings WHERE id=1')).rows[0];
    if(!setting.token_contract)throw Error('请先在网络配置中填写代币合约');return chainPolicy(setting.chain_id,setting.token_contract);
  };
  const server=createServer(async(req,res)=>{
    let tracked=false;
    res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try{
      if(!ready||closing)throw error('服务正在启动或停止',503);
      const address=server.address();const port=address&&typeof address==='object'?address.port:0;
      if(![`127.0.0.1:${port}`,`localhost:${port}`].includes(req.headers.host??''))throw error('仅限本机访问',403);
      const url=new URL(req.url??'/',`http://127.0.0.1:${port}`);
      const signing=url.pathname.startsWith('/api/signing/');
      if(signing&&req.headers.origin){
        if(!['http://127.0.0.1:8783','http://localhost:8783',`http://127.0.0.1:${port}`,`http://localhost:${port}`].includes(req.headers.origin))throw error('签名页面来源无效',403);
        res.setHeader('Access-Control-Allow-Origin',req.headers.origin);res.setHeader('Access-Control-Allow-Credentials','true');res.setHeader('Vary','Origin');
        if(req.method==='OPTIONS'){res.setHeader('Access-Control-Allow-Methods','GET, POST');res.setHeader('Access-Control-Allow-Headers','Content-Type, X-CSRF-Token');res.statusCode=204;res.end();return;}
      }
      if(req.method==='GET'&&['/','/app.js','/style.css','/admin-guide.js'].includes(url.pathname)){
        const name=url.pathname==='/'?'index.html':url.pathname.slice(1);
        res.setHeader('Content-Type',name.endsWith('.html')?'text/html; charset=utf-8':name.endsWith('.js')?'text/javascript; charset=utf-8':'text/css; charset=utf-8');
        res.end(await readFile(new URL(`../../../public/production/${name}`,import.meta.url)));return;
      }
      if(req.method==='GET'&&url.pathname==='/health'){json(res,{ok:true,application:'escrow-production-development',engine,network:network(),chainId:chain(),realFunds:isMainnet(),broadcastEnabled:false,mainnetBroadcastEnabled:isMainnet(),testnetPayoutAvailable:!isMainnet(),pid:process.pid,workspaceId:identity.workspaceId,instanceId:identity.instanceId});return;}
      if(req.method==='GET'&&url.pathname==='/api/status'){const initialized=await auth.initialized();json(res,{initialized,...(!initialized?{setupNonce}:{}),engine,realFunds:false,broadcastEnabled:false});return;}
      if(req.method!=='GET'&&req.method!=='POST')throw error('不支持此请求',405);
      if(req.method==='POST'){
        if(req.headers.origin&&![`http://127.0.0.1:${port}`,`http://localhost:${port}`].includes(req.headers.origin)&&!(signing&&['http://127.0.0.1:8783','http://localhost:8783'].includes(req.headers.origin)))throw error('请求来源无效',403);
        mutations++;tracked=true;
      }
      if(req.method==='POST'&&url.pathname==='/api/setup'){
        const input=await body(req);if(input.setupNonce!==setupNonce)throw error('初始化会话无效',403);
        await auth.bootstrap(input.username,input.password);json(res,{ok:true});return;
      }
      if(req.method==='POST'&&url.pathname==='/api/login'){
        const input=await body(req);let session;try{session=await auth.login(input.username,input.password,req.socket.remoteAddress??'local');}catch{throw error('账号或密码错误，连续失败会暂时锁定',401);}
        res.setHeader('Set-Cookie',`escrow_production=${session.token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800`);
        json(res,{admin:session.admin,csrf:session.csrf});return;
      }
      const token=sessions(req);let admin;
      try{admin=await auth.authenticate(token);}catch{throw error('请先登录',401);}
      if(req.method==='POST'){
        const csrf=req.headers['x-csrf-token'];if(typeof csrf!=='string')throw error('请求会话已失效，请刷新',403);
        try{await auth.authenticate(token,csrf);}catch{throw error('请求会话已失效，请刷新',403);}
      }
      if(req.method==='GET'&&url.pathname==='/api/session'){json(res,{admin,csrf:await auth.freshCsrf(token)});return;}
      if(signing){
        if(admin.role!=='OWNER')throw error('仅负责人可处理测试网出款',403);
        if(req.method==='GET'&&url.pathname==='/api/signing/session'){json(res,{admin,csrf:await auth.freshCsrf(token),...payouts.status()});return;}
        if(req.method==='GET'&&url.pathname==='/api/signing/requests'){json(res,{requests:await payouts.list(),...payouts.status()});return;}
        if(req.method==='GET'&&url.pathname==='/api/signing/gas'){json(res,await gas.status());return;}
        if(req.method==='GET'&&url.pathname==='/api/signing/sweeps'){json(res,await sweeps.status());return;}
        const sweepTarget=url.pathname.match(/^\/api\/signing\/sweeps\/([a-f0-9-]{36})\/(prepare|submit|broadcast|reconcile)$/);
        if(req.method==='POST'&&sweepTarget){const input=await body(req);const [,id,action]=sweepTarget;
          if(action==='prepare')json(res,await sweeps.prepare(id,admin.id));
          if(action==='submit')json(res,await sweeps.submit(id,admin.id,input.raw,input.planHash));
          if(action==='broadcast')json(res,await sweeps.broadcast(id,admin.id,input.confirmation));
          if(action==='reconcile'){await sweeps.reconcileOrder(id);json(res,{ok:true});}return;
        }
        const replaceTarget=url.pathname.match(/^\/api\/signing\/([a-f0-9-]{36})\/replace-(prepare|submit|broadcast)$/);
        if(req.method==='POST'&&replaceTarget){const input=await body(req);const [,id,action]=replaceTarget;
          if(action==='prepare')json(res,await replacements.prepare(id,admin.id));
          if(action==='submit')json(res,await replacements.submit(id,admin.id,input.raw,input.planHash));
          if(action==='broadcast')json(res,await replacements.broadcast(id,admin.id,input.confirmation));return;
        }
        const gasTarget=url.pathname.match(/^\/api\/signing\/([a-f0-9-]{36})\/gas-(prepare|submit|broadcast|reconcile)$/);
        if(req.method==='POST'&&gasTarget){const input=await body(req);const [,id,action]=gasTarget;
          if(action==='prepare')json(res,await gas.prepare(id,admin.id));
          if(action==='submit')json(res,await gas.submit(id,admin.id,input.raw,input.planHash));
          if(action==='broadcast')json(res,await gas.broadcast(id,admin.id,input.confirmation));
          if(action==='reconcile'){await gas.reconcileRequest(id);json(res,{ok:true});}return;
        }
        const target=url.pathname.match(/^\/api\/signing\/([a-f0-9-]{36})\/(prepare|submit|broadcast|reconcile)$/);
        if(req.method==='POST'&&target){const input=await body(req);const [,id,action]=target;
          if(action==='prepare')json(res,await payouts.prepare(id,admin.id));
          if(action==='submit')json(res,await payouts.submit(id,admin.id,input.raw,input.planHash));
          if(action==='broadcast')json(res,await payouts.broadcast(id,admin.id,input.confirmation));
          if(action==='reconcile'){await payouts.reconcile(id);json(res,{ok:true});}return;
        }
      }
      if(url.pathname==='/api/backups'||url.pathname.startsWith('/api/backups/')){
        if(admin.role!=='OWNER')throw error('仅负责人可管理备份',403);
        if(!backups)throw error(engine==='pglite-local'?'此实例未启用备份':'使用 PostgreSQL 时请使用数据库自带的备份工具',400);
        if(req.method==='GET'&&url.pathname==='/api/backups'){json(res,{backups:await backups.list()});return;}
        if(req.method==='POST'&&url.pathname==='/api/backups'){const input=await body(req);const info=await backups.create(input.password,input.repeat);await db.query('INSERT INTO production_admin_audit(id,actor_id,action,target_id) VALUES($1,$2,$3,$4)',[randomUUID(),admin.id,'BACKUP_CREATED',info.id]);json(res,info,201);return;}
        const check=url.pathname.match(/^\/api\/backups\/([a-f0-9-]{36})\/verify$/);
        if(req.method==='POST'&&check){const input=await body(req);const result=await backups.verify(check[1],input.password);await db.query('INSERT INTO production_admin_audit(id,actor_id,action,target_id) VALUES($1,$2,$3,$4)',[randomUUID(),admin.id,'BACKUP_VERIFIED',check[1]]);json(res,result);return;}
      }
      // Arbitrators may read and decide cases, change their own password and log out; nothing else changes state.
      if(admin.role==='ARBITRATOR'&&req.method==='POST'&&!/^\/api\/cases\/[a-f0-9-]{36}\/resolve$/.test(url.pathname)&&!['/api/logout','/api/admins/password'].includes(url.pathname))throw error('仲裁员只能处理争议',403);
      if(url.pathname==='/api/admins/password'&&req.method==='POST'){const input=await body(req);await auth.changePassword(admin.id,String(input.current??''),String(input.next??''));json(res,{ok:true});return;}
      if(url.pathname==='/api/admins'||url.pathname.startsWith('/api/admins/')){
        if(admin.role!=='OWNER')throw error('仅负责人可管理账号',403);
        if(req.method==='GET'&&url.pathname==='/api/admins'){json(res,{admins:await auth.list()});return;}
        if(req.method==='POST'&&url.pathname==='/api/admins'){const input=await body(req);await auth.create(admin.id,String(input.username??''),String(input.password??''),String(input.role??''));json(res,{admins:await auth.list()});return;}
        const toggle=url.pathname.match(/^\/api\/admins\/([a-f0-9-]{36})\/(disable|enable)$/);
        if(req.method==='POST'&&toggle){await body(req);await auth.setDisabled(admin.id,toggle[1],toggle[2]==='disable');json(res,{admins:await auth.list()});return;}
      }
      if(url.pathname==='/api/automation'||url.pathname.startsWith('/api/automation/')){
        if(admin.role!=='OWNER')throw error('仅负责人可管理自动出款',403);
        if(req.method==='GET'&&url.pathname==='/api/automation'){json(res,await automation.status());return;}
        if(req.method==='POST'&&url.pathname==='/api/automation/unlock'){
          const input=await body(req),root=(await db.query<{xpub:string}>('SELECT xpub FROM production_wallet_root WHERE id=1')).rows[0];if(!root)throw error('请先配置平台钱包',400);
          await wallet.unlock(input.backup,input.password,root.xpub);await db.query('INSERT INTO production_admin_audit(id,actor_id,action) VALUES($1,$2,$3)',[randomUUID(),admin.id,'HOT_WALLET_UNLOCKED']);json(res,await automation.status());return;
        }
        if(req.method==='POST'&&url.pathname==='/api/automation/lock'){await body(req);wallet.lock();await db.query('INSERT INTO production_admin_audit(id,actor_id,action) VALUES($1,$2,$3)',[randomUUID(),admin.id,'HOT_WALLET_LOCKED']);json(res,await automation.status());return;}
        if(req.method==='POST'&&url.pathname==='/api/automation/enable'){
          const input=await body(req),enabled=input.enabled===true;if(enabled&&input.confirmation!=='AUTO')throw error('开启自动出款请准确输入 AUTO',400);
          await automation.setEnabled(admin.id,enabled);json(res,await automation.status());return;
        }
      }
      // The /start welcome picture: raw PNG/JPEG upload (not JSON), preview and removal.
      if(url.pathname==='/api/welcome-image'||url.pathname==='/api/welcome-image/remove'){
        if(req.method==='GET'&&url.pathname==='/api/welcome-image'){const image=welcomeImage();if(!image)throw error('未上传欢迎图片',404);res.writeHead(200,{'Content-Type':image.mime,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(Buffer.from(image.bytes));return;}
        if(admin.role!=='OWNER')throw error('仅负责人可修改欢迎图片',403);
        if(req.method==='POST'&&url.pathname==='/api/welcome-image/remove'){await body(req);await saveWelcomeImage(db,admin.id,null);json(res,{uploaded:false});return;}
        if(req.method==='POST'&&url.pathname==='/api/welcome-image'){
          if(!['image/png','image/jpeg'].includes(String(req.headers['content-type']??'')))throw error('图片须为 PNG 或 JPG',415);
          const chunks:Buffer[]=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>WELCOME_IMAGE_MAX)throw error('图片不能超过 5 MB',413);chunks.push(Buffer.from(chunk));}
          try{await saveWelcomeImage(db,admin.id,new Uint8Array(Buffer.concat(chunks)));}catch(e){throw error((e as Error).message,400);}
          json(res,{uploaded:true});return;
        }
      }
      if(url.pathname==='/api/custody'||url.pathname.startsWith('/api/custody/')){
        if(req.method==='GET'&&url.pathname==='/api/custody'){json(res,await custody.status());return;}
        if(req.method==='POST'&&url.pathname==='/api/custody/address'){
          if(admin.role!=='OWNER')throw error('仅负责人可设置固定托管地址',403);
          const input=await body(req),address=await setFixedAddress(db,admin.id,input.address);
          await alerts.custom(`custody-address:${Date.now()}`,address?`⚠️ 固定托管地址已设置为：
${address}
之后新的群订单都会显示这个地址，出款需要你手动转账。如果不是你本人操作，请立即检查后台账号。`:'⚠️ 固定托管地址已清除，新的群订单改用平台生成的地址。').catch(()=>{});
          json(res,await custody.status());return;
        }
        const action=url.pathname.match(/^\/api\/custody\/transfers\/([a-f0-9-]{36})\/(assign|ignore)$/);
        if(req.method==='POST'&&action){const input=await body(req);if(action[2]==='assign')await custody.assign(admin.id,action[1],String(input.orderId??''));else await custody.ignore(admin.id,action[1]);json(res,await custody.status());return;}
      }
      if(url.pathname==='/api/revenue-address'){
        if(admin.role!=='OWNER')throw error('仅负责人可修改收益地址',403);
        if(req.method==='GET'){json(res,{address:await revenueAddress(db)});return;}
        if(req.method==='POST'){
          const input=await body(req),address=await setRevenueAddress(db,admin.id,input.address);
          await alerts.custom(`revenue:${Date.now()}`,address?`⚠️ 平台手续费收益地址已修改为：
${address}
如果不是你本人操作，请立即关闭自动出款并检查后台账号。`:'⚠️ 平台手续费收益地址已清除，手续费改回归集到平台收益钱包。').catch(()=>{});
          json(res,{address});return;
        }
      }
      if(url.pathname==='/api/platform-settings'){
        if(req.method==='GET'){json(res,effective());return;}
        if(req.method==='POST'){if(admin.role!=='OWNER')throw error('仅负责人可修改平台设置',403);json(res,await savePlatformSettings(db,admin.id,await body(req)));return;}
      }
      if(url.pathname==='/api/alerts'||url.pathname.startsWith('/api/alerts/')){
        const list=async()=>(await db.query('SELECT user_id::text,created_at FROM production_alert_recipients ORDER BY created_at')).rows;
        if(req.method==='GET'&&url.pathname==='/api/alerts'){json(res,{recipients:await list(),botRunning:bot.status().state==='running'});return;}
        if(admin.role!=='OWNER')throw error('仅负责人可管理提醒',403);const input=await body(req);
        if(url.pathname==='/api/alerts/test'){try{await alerts.test();}catch(e){throw error((e as Error).message==='bot offline'?'机器人未运行，无法发送':(e as Error).message.includes('chat not found')?'发送失败：请先用该账号私聊机器人发送 /start':(e as Error).message.startsWith('请先')?(e as Error).message:'发送失败，请确认该账号已私聊机器人 /start',400);}json(res,{ok:true});return;}
        const userId=String(input.userId??'');if(!/^[1-9]\d{0,18}$/.test(userId)||BigInt(userId)>9223372036854775807n)throw error('请填写有效的 Telegram 数字 ID',400);
        if(url.pathname==='/api/alerts')await db.query('INSERT INTO production_alert_recipients(user_id,added_by) VALUES($1,$2) ON CONFLICT DO NOTHING',[userId,admin.id]);
        else if(url.pathname==='/api/alerts/remove')await db.query('DELETE FROM production_alert_recipients WHERE user_id=$1',[userId]);else throw error('未知操作',404);
        json(res,{recipients:await list(),botRunning:bot.status().state==='running'});return;
      }
      if(url.pathname==='/api/trade-settings'&&req.method==='POST'){
        if(admin.role!=='OWNER')throw error('仅负责人可修改交易开放设置',403);const input=await body(req);
        if(typeof input.open!=='boolean'||!Number.isInteger(input.maxPerUser)||input.maxPerUser<1||input.maxPerUser>20)throw error('设置无效：每人进行中订单上限为1至20',400);
        await db.query('UPDATE production_trade_settings SET open_trading=$1,max_open_orders_per_user=$2,updated_at=now() WHERE id=1',[input.open,input.maxPerUser]);
        await db.query('INSERT INTO production_admin_audit(id,actor_id,action,target_id) VALUES($1,$2,$3,$4)',[randomUUID(),admin.id,input.open?'TRADING_OPENED':'TRADING_RESTRICTED',String(input.maxPerUser)]);json(res,{ok:true});return;
      }
      if(url.pathname==='/api/allowlist'||url.pathname==='/api/allowlist/remove'){
        if(req.method==='GET'){json(res,{users:(await db.query('SELECT user_id::text,note,created_at FROM production_allowlist ORDER BY created_at')).rows,settings:(await db.query('SELECT open_trading,max_open_orders_per_user FROM production_trade_settings WHERE id=1')).rows[0]});return;}
        if(admin.role!=='OWNER')throw error('仅负责人可管理白名单',403);
        const input=await body(req),userId=String(input.userId??'');if(!/^[1-9]\d{0,18}$/.test(userId)||BigInt(userId)>9223372036854775807n)throw error('请填写有效的 Telegram 数字 ID',400);
        if(url.pathname==='/api/allowlist'){const note=typeof input.note==='string'?input.note.trim().slice(0,100):'';await db.query('INSERT INTO production_allowlist(user_id,note,added_by) VALUES($1,$2,$3) ON CONFLICT(user_id) DO UPDATE SET note=excluded.note',[userId,note,admin.id]);}
        else await db.query('DELETE FROM production_allowlist WHERE user_id=$1',[userId]);
        await db.query('INSERT INTO production_admin_audit(id,actor_id,action,target_id) VALUES($1,$2,$3,$4)',[randomUUID(),admin.id,url.pathname==='/api/allowlist'?'ALLOWLIST_ADDED':'ALLOWLIST_REMOVED',userId]);
        json(res,{users:(await db.query('SELECT user_id::text,note,created_at FROM production_allowlist ORDER BY created_at')).rows});return;
      }
      if(req.method==='GET'&&url.pathname==='/api/timeouts'){json(res,await timeouts.settings());return;}
      if(req.method==='POST'&&url.pathname==='/api/timeouts'){await timeouts.configure(admin.id,await body(req));json(res,await timeouts.settings());return;}
      const resume=url.pathname.match(/^\/api\/orders\/([a-f0-9-]{36})\/resume$/);
      if(req.method==='POST'&&resume){const input=await body(req);if(input.confirmation!=='RESUME')throw error('请准确输入 RESUME',400);await timeouts.resume(resume[1],admin.id,Number(input.revision));json(res,{ok:true});return;}
      if(req.method==='GET'&&url.pathname==='/api/bot'){json(res,bot.status());return;}
      if(req.method==='GET'&&url.pathname==='/api/wallet'){json(res,await monitor.status());return;}
      if(req.method==='POST'&&['/api/wallet/configure','/api/wallet/start','/api/wallet/stop'].includes(url.pathname)){
        if(admin.role!=='OWNER')throw error('仅负责人可配置和启停入金监听',403);const input=await body(req);
        if(url.pathname==='/api/wallet/configure'){
          if(!identity.saveRpc)throw error('此实例不支持保存 RPC 配置',400);await monitor.configure(input.xpub,input.rpcUrl,admin.id,identity.saveRpc);payouts.setRpc(input.rpcUrl);gas.setRpc(input.rpcUrl);sweeps.setRpc(input.rpcUrl);replacements.setRpc(input.rpcUrl);
        }else if(url.pathname==='/api/wallet/start'){await monitor.start();await db.query('UPDATE production_runtime_state SET monitor_enabled=true,updated_at=now() WHERE id=1');}else{await monitor.stop();await db.query('UPDATE production_runtime_state SET monitor_enabled=false,updated_at=now() WHERE id=1');}
        await db.query('INSERT INTO production_admin_audit(id,actor_id,action) VALUES($1,$2,$3)',[randomUUID(),admin.id,url.pathname==='/api/wallet/start'?'DEPOSIT_MONITOR_STARTED':url.pathname==='/api/wallet/stop'?'DEPOSIT_MONITOR_STOPPED':'DEPOSIT_MONITOR_CONFIGURED']);
        json(res,await monitor.status());return;
      }
      if(req.method==='POST'&&['/api/bot/configure','/api/bot/start','/api/bot/stop'].includes(url.pathname)){
        if(admin.role!=='OWNER')throw error('仅负责人可配置和启停机器人',403);const input=await body(req);
        if(url.pathname==='/api/bot/configure'){
          if(!identity.saveBotToken)throw error('此实例不支持保存机器人凭据',400);await bot.configure(input.token,identity.saveBotToken);
        }else if(url.pathname==='/api/bot/start'){await bot.start();await db.query('UPDATE production_runtime_state SET bot_enabled=true,updated_at=now() WHERE id=1');}else{await bot.stop();await db.query('UPDATE production_runtime_state SET bot_enabled=false,updated_at=now() WHERE id=1');}
        json(res,bot.status());return;
      }
      if(req.method==='POST'&&url.pathname==='/api/logout'){await body(req);await auth.logout(token);res.setHeader('Set-Cookie','escrow_production=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');json(res,{ok:true});return;}
      if(req.method==='GET'&&url.pathname==='/api/overview'){
        const orders=(await db.query('SELECT id,kind,buyer_id::text,seller_id::text,principal::text,fee::text,state,created_at FROM production_orders ORDER BY created_at DESC LIMIT 200')).rows;
        const approvals=(await db.query('SELECT r.id,r.order_id,r.kind,r.allocations,r.fee::text,r.status,r.snapshot_hash,r.review_note,r.created_at,o.chain_id,o.token_contract,o.description FROM production_payout_requests r JOIN production_orders o ON o.id=r.order_id ORDER BY r.created_at DESC LIMIT 200')).rows;
        const settings=(await db.query('SELECT chain_id,token_contract FROM production_chain_settings WHERE id=1')).rows[0];
        const balances=(await db.query('SELECT account,sum(amount)::text AS balance FROM production_ledger_entries GROUP BY account ORDER BY account')).rows;
        const audit=(await db.query('SELECT a.action,a.target_id,a.created_at,u.username FROM production_admin_audit a LEFT JOIN production_admins u ON u.id=a.actor_id ORDER BY a.created_at DESC LIMIT 50')).rows;
        const partyActions=(await db.query('SELECT order_id,user_id::text,action,created_at FROM production_party_actions ORDER BY created_at DESC LIMIT 50')).rows;
        const payoutTransactions=(await db.query('SELECT request_id,order_id,status,tx_hash,last_error,updated_at FROM production_payout_transactions ORDER BY created_at DESC LIMIT 200')).rows;
        const cap=limits();
        json(res,{network:{name:network(),chainId:chain(),maxOrder:cap.maxOrder?.toString()??null,maxCustody:cap.maxCustody?.toString()??null,feeMin:cap.feeMin,feeBps:cap.feeBps},orders,approvals,settings,balances,audit,partyActions,cases:await new ProductionCases(db).list(),payoutTransactions,payout:payouts.status(),bot:bot.status(),wallet:await monitor.status(),engine,realFunds:false,broadcastEnabled:false,testnetPayoutAvailable:true});return;
      }
      if(req.method==='POST'&&url.pathname==='/api/settings'){
        if(admin.role!=='OWNER')throw error('仅负责人可修改网络',403);const input=await body(req);if(Number(input.chainId)!==chain())throw error(isMainnet()?'本实例为主网，只能选择 BNB 主网（56）':'本实例为测试网，只能选择 BNB 测试网（97）',400);const p=chainPolicy(Number(input.chainId),input.tokenContract);
        await db.transaction(async tx=>{
          await tx.query('LOCK TABLE production_wallet_root IN EXCLUSIVE MODE');
          const root=(await tx.query<{chain_id:number;token_contract:string}>('SELECT chain_id,token_contract FROM production_wallet_root WHERE id=1')).rows[0];
          if(root&&(root.chain_id!==p.chainId||root.token_contract!==p.tokenContract))throw Error('收款分支已锁定，不能更改网络或代币');
          await tx.query('UPDATE production_chain_settings SET chain_id=$1,token_contract=$2,updated_at=now() WHERE id=1',[p.chainId,p.tokenContract]);
        });json(res,{ok:true});return;
      }
      if(req.method==='POST'&&url.pathname==='/api/orders'){const input=await body(req);json(res,await new ProductionOrders(db,await policy()).create(input,admin.id),201);return;}
      const caseFile=url.pathname.match(/^\/api\/case-files\/([a-f0-9-]{36})$/);
      if(req.method==='GET'&&caseFile){
        const file=await new ProductionCaseFiles(db).read(caseFile[1]),inline=url.searchParams.get('inline')==='1'&&file.mime.startsWith('image/');
        // Never render uploaded content as a page: images may preview inline, everything else downloads.
        res.setHeader('Content-Type',file.mime);res.setHeader('Content-Security-Policy',"default-src 'none'; sandbox");
        res.setHeader('Content-Disposition',`${inline?'inline':'attachment'}; filename="evidence"; filename*=UTF-8''${encodeURIComponent(file.filename)}`);
        res.end(Buffer.from(file.bytes));return;
      }
      const cancelAction=url.pathname.match(/^\/api\/orders\/([a-f0-9-]{36})\/cancel$/);
      if(req.method==='POST'&&cancelAction){
        const input=await body(req);if(input.confirmation!=='CANCEL')throw error('请准确输入 CANCEL',400);
        await new ProductionManual(db).cancelUnpaid(cancelAction[1],admin.id,Number(input.revision),input.note);json(res,{ok:true});return;
      }
      const manualAction=url.pathname.match(/^\/api\/orders\/([a-f0-9-]{36})\/manual$/);
      if(req.method==='POST'&&manualAction){
        const input=await body(req),words={continue:'CONTINUE',refund:'REFUND',close:'CLOSE'} as const,action=input.action as keyof typeof words;
        if(!(action in words))throw error('未知的处理方式',400);if(input.confirmation!==words[action])throw error(`请准确输入 ${words[action]}`,400);
        const manual=new ProductionManual(db),revision=Number(input.revision);
        if(action==='continue')await manual.continueOrder(manualAction[1],admin.id,revision,input.note);
        else if(action==='refund')await manual.refundAll(manualAction[1],admin.id,revision,input.note);
        else await manual.close(manualAction[1],admin.id,revision,input.note);
        json(res,{ok:true});return;
      }
      const detail=url.pathname.match(/^\/api\/orders\/([a-f0-9-]+)$/);
      if(req.method==='GET'&&detail){
        const raw=(await db.query<{chain_id:56|97;token_contract:string}>('SELECT chain_id,token_contract FROM production_orders WHERE id=$1',[detail[1]])).rows[0];if(!raw)throw error('订单不存在',404);
        const orders=new ProductionOrders(db,chainPolicy(raw.chain_id,raw.token_contract));const order=await orders.get(detail[1]);
        const acceptances=(await db.query('SELECT user_id::text FROM production_order_acceptances WHERE order_id=$1',[order.id])).rows;
        const deposits=(await db.query('SELECT tx_hash,amount::text,classification,block_number::text FROM production_deposits WHERE order_id=$1',[order.id])).rows;
        const username=bot.status().username;
        json(res,{order,acceptances,deposits,terms:(await db.query('SELECT user_id::text,text,created_at FROM production_deal_terms WHERE order_id=$1 ORDER BY created_at',[order.id])).rows,...await new ProductionCases(db).history(order.id),files:await new ProductionCaseFiles(db).list(order.id),holdings:await holdings(db,order.id).then(h=>({escrow:h.escrow.toString(),exception:h.exception.toString()})),manual:(await db.query('SELECT action,escrow::text,exception::text,note,created_at FROM production_manual_resolutions WHERE order_id=$1 ORDER BY created_at',[order.id])).rows,group:(await db.query('SELECT chat_id::text,state,language,pause_reason,created_at FROM production_group_bindings WHERE order_id=$1',[order.id])).rows[0]??null,inviteUrl:username&&order.kind==='PRODUCT'?`https://t.me/${encodeURIComponent(username)}?start=order_${order.id}`:null});return;
      }
      const review=url.pathname.match(/^\/api\/approvals\/([a-f0-9-]+)\/review$/);
      const resolution=url.pathname.match(/^\/api\/cases\/([a-f0-9-]{36})\/resolve$/);
      if(req.method==='POST'&&resolution){const input=await body(req);if(input.confirmation!=='RESOLVE')throw error('请准确输入 RESOLVE',400);
        const request=await new ProductionCases(db).resolve(resolution[1],admin.id,input.outcome,input.note,input.revision);json(res,{requestId:request,awaitingApproval:true});return;
      }
      if(req.method==='POST'&&review){
        const input=await body(req);if(typeof input.approve!=='boolean')throw error('无效审核操作',400);
        const raw=(await db.query<{chain_id:56|97;token_contract:string}>('SELECT o.chain_id,o.token_contract FROM production_payout_requests r JOIN production_orders o ON o.id=r.order_id WHERE r.id=$1',[review[1]])).rows[0];if(!raw)throw error('审批记录不存在',404);
        await new ProductionOrders(db,chainPolicy(raw.chain_id,raw.token_contract)).review(review[1],admin.id,input.approve,input.snapshotHash,input.note);json(res,{ok:true,broadcastEnabled:false});return;
      }
      if(req.method==='POST'&&url.pathname==='/api/shutdown'){
        if(admin.role!=='OWNER')throw error('没有停止权限',403);await body(req);json(res,{ok:true});setTimeout(()=>void stop(),50);return;
      }
      throw error('接口不存在',404);
    }catch(caught){
      const e=caught as Error&{httpStatus?:number;code?:string};
      json(res,{error:e.code?'操作未成功，请刷新核对':e.message??'请求失败'},e.httpStatus??400);
    }finally{if(tracked)mutations--;}
  });
  server.requestTimeout=15000;server.headersTimeout=10000;
  // Bring back whatever the administrator had running before the restart. Failures stay visible in the panel
  // as the usual monitor/bot error state and are retried a few times in case the network is still coming up.
  const resumeStatus={monitor:'',bot:''};
  async function resume(){
    const state=(await db.query<{monitor_enabled:boolean;bot_enabled:boolean}>('SELECT monitor_enabled,bot_enabled FROM production_runtime_state WHERE id=1')).rows[0];if(!state)return;
    for(const [enabled,key,run] of [[state.monitor_enabled,'monitor',()=>monitor.start()],[state.bot_enabled,'bot',()=>bot.start()]] as const){
      if(!enabled)continue;
      for(let attempt=0;attempt<5&&!closing;attempt++){
        try{await run();resumeStatus[key]='resumed';break;}catch{resumeStatus[key]='failed';await new Promise(r=>setTimeout(r,attempt<4?15000:0));}
      }
    }
  }
  async function start(port:number){await loadPlatformSettings(db);await loadWelcomeImage(db);await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});ready=true;payouts.start();gas.start();sweeps.start();timeouts.start();alerts.start();automation.start();custodyTimer=setInterval(()=>void custody.reminders((key,text)=>alerts.custom(key,text)).catch(()=>{}),20000);void resume();const address=server.address();return `http://127.0.0.1:${typeof address==='object'&&address?address.port:port}`;}
  let stopping:Promise<void>|undefined;
  async function stop(){return stopping??=(async()=>{closing=true;server.closeIdleConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));while(mutations)await new Promise(resolve=>setTimeout(resolve,20));await monitor.stop();await payouts.stop();await gas.stop();await sweeps.stop();await timeouts.stop();await automation.stop();wallet.lock();if(custodyTimer)clearInterval(custodyTimer);await alerts.stop();await bot.stop();await db.close();await identity.onStop?.();})();}
  return {start,stop,server};
}
