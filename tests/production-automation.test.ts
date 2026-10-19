import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {HDNodeWallet,Interface,Transaction,keccak256} from 'ethers';
import {migrateProduction,type ProductionDatabase} from '../src/production/database.js';
import {AdminAuth} from '../src/production/admin-auth.js';
import {ProductionOrders} from '../src/production/orders.js';
import {GAS_STATION_INDEX,TREASURY_INDEX,ProductionWallets} from '../src/production/wallets.js';
import {ProductionPayouts} from '../src/production/payouts.js';
import {ProductionGas} from '../src/production/gas.js';
import {ProductionSweeps} from '../src/production/sweeps.js';
import {ProductionReplacements} from '../src/production/replacements.js';
import {HotWallet} from '../src/production/hot-wallet.js';
import {ProductionAutomation} from '../src/production/automation.js';
import type {GasRpc,NativeProof,ReplacementRpc} from '../src/production/payout-rpc.js';
import {chainPolicy,type DepositProof} from '../src/production/bep20.js';
import {tokenUnits} from '../src/production/amounts.js';
import {productionApp} from '../src/production/http-app.js';

// Public test vector only; never used with real funds.
const PHRASE='test test test test test test test test test test test junk',ROOT_PATH="m/44'/60'/0'/0",backupPassword='test-only-backup-password';
const root=HDNodeWallet.fromPhrase(PHRASE,'',ROOT_PATH),child=root.deriveChild(0),station=root.deriveChild(GAS_STATION_INDEX),xpub=root.neuter().extendedKey;
const backupJson=async(chainId=97,pub=xpub)=>{const e=JSON.parse(await root.encrypt(backupPassword));e.escrowTestWallet={version:1,chainId,rootPath:ROOT_PATH,xpub:pub,rootId:'x'};return JSON.stringify(e);};
const backup=backupJson();
const buyer='0x1111111111111111111111111111111111111111',seller='0x2222222222222222222222222222222222222222',token='0x3333333333333333333333333333333333333333';
const policy=chainPolicy(97,token),block='0x'+'b'.repeat(64),depositHash='0x'+'a'.repeat(64),password='test-only-auto-password',GWEI=1000000000n;
function receipt(hash:string,from:string,to:string,amount:string,status=1,gasUsed?:bigint):DepositProof{
  const abi=new Interface(['event Transfer(address indexed from,address indexed to,uint256 value)']);
  const log=abi.encodeEventLog(abi.getEvent('Transfer')!,[from,to,tokenUnits(amount)]);
  return {chainId:97,finalizedBlock:12,canonicalBlockHash:block,receipt:{hash,status,blockNumber:11,blockHash:block,logs:status===1?[{address:token,index:0,...log}]:[],gasUsed}};
}
class Rpc implements ReplacementRpc,GasRpc{
  nonce=0;stationNonce=0;stationNative=10n**17n;orderNative=10n**17n;sends:string[]=[];known_=new Set<string>();proofs=new Map<string,DepositProof>();fail='';
  async terms(){if(this.fail)throw Error(this.fail);if(this.orderNative<90000n*GWEI)throw Error('独立收款地址缺少 tBNB 手续费');return {nonce:this.nonce,gasLimit:'90000',gasPrice:GWEI.toString()};}
  async quote(){return {gasLimit:'90000',gasPrice:GWEI.toString(),native:this.orderNative.toString()};}
  async station(){return {nonce:this.stationNonce,gasPrice:GWEI.toString(),native:this.stationNative.toString()};}
  async pending(){return {minedNonce:0,gasPrice:GWEI.toString(),native:this.orderNative.toString()};}
  async known(hash:string){return this.known_.has(hash);}
  async send(raw:string){this.sends.push(raw);const hash=keccak256(raw);this.known_.add(hash);return hash;}
  async proof(hash:string){return this.proofs.get(hash)??null;}
  async nativeProof():Promise<NativeProof|null>{return null;}
  close(){}
}
async function fixture(t:any,{close=true}={}){
  const raw=new PGlite();await raw.waitReady;const db=raw as unknown as ProductionDatabase;await migrateProduction(db);
  await new AdminAuth(db).bootstrap('owner',password);const admin=(await db.query<{id:string}>('SELECT id FROM production_admins')).rows[0].id;
  await db.query('UPDATE production_chain_settings SET token_contract=$1 WHERE id=1',[token]);const wallets=new ProductionWallets(db);await wallets.configure(xpub,policy,admin);
  const orders=new ProductionOrders(db,policy),order=await orders.create({kind:'PRODUCT',buyerId:'1001',sellerId:'1002',buyerAddress:buyer,sellerAddress:seller,principal:'100',description:'Isolated automation fixture; no network or funds'},admin);
  await orders.accept(order.id,'1001');await orders.accept(order.id,'1002');await wallets.allocate(order.id,10);await orders.credit(order.id,receipt(depositHash,buyer,child.address,'105'),depositHash);
  await orders.declare(order.id,'1002');const request=await orders.requestRelease(order.id,'1001');
  const rpc=new Rpc(),payouts=new ProductionPayouts(db,'https://fixture.test',()=>rpc),gas=new ProductionGas(db,payouts,'https://fixture.test',()=>rpc);
  const sweeps=new ProductionSweeps(db,'https://fixture.test',()=>rpc),replacements=new ProductionReplacements(db,payouts,'https://fixture.test',()=>rpc);
  const wallet=new HotWallet(),alerts:string[]=[];let monitoring=true;
  const automation=new ProductionAutomation(db,{payouts,gas,sweeps,replacements,wallet,monitoring:()=>monitoring,alert:async(_k,text)=>{alerts.push(text);}});
  if(close)t.after(()=>db.close());
  return {db,admin,orders,order,request,rpc,payouts,wallet,alerts,automation,setMonitoring:(v:boolean)=>{monitoring=v;}};
}
const state=async(db:ProductionDatabase,id:string)=>(await db.query<{status:string}>('SELECT status FROM production_payout_requests WHERE id=$1',[id])).rows[0].status;

test('hot wallet unlocks only the configured root with the right password and network',async()=>{
  const w=new HotWallet(),json=await backup;
  await assert.rejects(w.unlock('{',backupPassword,xpub),/备份文件/);
  await assert.rejects(w.unlock(json,'',xpub),/密码/);
  await assert.rejects(w.unlock(await backupJson(56),backupPassword,xpub),/不属于/);
  await assert.rejects(w.unlock(json,backupPassword,HDNodeWallet.fromSeed(new Uint8Array(32).fill(3)).derivePath(ROOT_PATH).neuter().extendedKey),/不属于/);
  await assert.rejects(w.unlock(json,'wrong-password-123',xpub),/密码不正确/);assert.equal(w.isUnlocked(),false);
  assert.throws(()=>w.signer(0,child.address),/未解锁/);
  await w.unlock(json,backupPassword,xpub);assert.equal(w.signer(0,child.address).address,child.address);
  assert.throws(()=>w.signer(1,child.address),/不一致/);
  w.lock();assert.equal(w.isUnlocked(),false);assert.equal(JSON.stringify(w.status()).includes('0x'),false);
});
test('automation is off by default and only the owner may switch it',async t=>{
  const f=await fixture(t);assert.equal((await f.automation.status()).enabled,false);
  await f.wallet.unlock(await backup,backupPassword,xpub);await f.automation.tick();assert.equal(f.rpc.sends.length,0);assert.equal(await state(f.db,f.request),'PENDING');
  const auth=new AdminAuth(f.db),arb=await auth.create(f.admin,'judge',password,'ARBITRATOR');
  await assert.rejects(f.automation.setEnabled(arb,true),/负责人/);
});
test('locked wallet or stopped monitor: nothing is sent and the owner is alerted',async t=>{
  const f=await fixture(t);await f.automation.setEnabled(f.admin,true);
  await f.automation.tick();assert.equal(f.rpc.sends.length,0);assert.match(f.alerts.join(),/尚未解锁/);
  await f.wallet.unlock(await backup,backupPassword,xpub);f.setMonitoring(false);
  await f.automation.tick();assert.equal(f.rpc.sends.length,0);assert.match(f.alerts.join(),/入金监听/);assert.equal(await state(f.db,f.request),'PENDING');
});
test('release is approved, signed by the order address and broadcast; fee is then collected to the treasury',async t=>{
  const f=await fixture(t);await f.automation.setEnabled(f.admin,true);await f.wallet.unlock(await backup,backupPassword,xpub);
  await f.automation.tick();
  assert.equal(f.rpc.sends.length,1);const tx=Transaction.from(f.rpc.sends[0]);
  assert.equal(tx.from,child.address);assert.equal(tx.to?.toLowerCase(),token);assert.equal(tx.chainId,97n);
  assert.equal((await f.db.query<{status:string}>('SELECT status FROM production_payout_transactions WHERE request_id=$1',[f.request])).rows[0].status,'BROADCAST');
  assert.match(f.alerts.join(),/自动出款已广播/);
  await f.automation.tick();assert.equal(f.rpc.sends.length,1);
  f.rpc.proofs.set(keccak256(f.rpc.sends[0]),receipt(keccak256(f.rpc.sends[0]),child.address,seller,'100',1,60000n));await f.payouts.reconcile(f.request);
  assert.equal((await f.orders.get(f.order.id)).state,'COMPLETED');
  f.rpc.nonce=1;await f.automation.tick();assert.equal(f.rpc.sends.length,2);
  const sweep=Transaction.from(f.rpc.sends[1]);assert.equal(sweep.from,child.address);
  assert.ok(sweep.data.toLowerCase().includes(root.deriveChild(TREASURY_INDEX).address.slice(2).toLowerCase()));
  const actions=(await f.db.query<{action:string}>('SELECT action FROM production_admin_audit')).rows.map(r=>r.action);
  for(const a of ['AUTO_APPROVED','AUTO_PAYOUT_BROADCAST','AUTO_SWEEP'])assert.ok(actions.includes(a),a);
});
test('missing gas is topped up from the gas station first',async t=>{
  const f=await fixture(t);f.rpc.orderNative=0n;await f.automation.setEnabled(f.admin,true);await f.wallet.unlock(await backup,backupPassword,xpub);
  await f.automation.tick();assert.equal(f.rpc.sends.length,1);
  const tx=Transaction.from(f.rpc.sends[0]);assert.equal(tx.from,station.address);assert.equal(tx.to,child.address);assert.equal(tx.value,90000n*GWEI*2n);
  assert.equal((await f.db.query<{n:number}>('SELECT count(*)::int AS n FROM production_payout_transactions')).rows[0].n,0);
});
test('repeated real failures pause automation with a reason; switching on again clears it',async t=>{
  const f=await fixture(t);await f.automation.setEnabled(f.admin,true);await f.wallet.unlock(await backup,backupPassword,xpub);f.rpc.fail='RPC exploded';
  for(let i=0;i<4;i++)await f.automation.tick();assert.equal((await f.automation.status()).enabled,true);
  await f.automation.tick();const s=await f.automation.status();
  assert.equal(s.enabled,false);assert.match(s.pausedReason??'',/RPC exploded/);assert.match(f.alerts.join(),/已自动暂停/);assert.equal(f.rpc.sends.length,0);
  f.rpc.fail='';await f.automation.setEnabled(f.admin,true);assert.equal((await f.automation.status()).pausedReason,null);
  await f.automation.tick();assert.equal(f.rpc.sends.length,1);
});
test('automation and account endpoints: owner only, AUTO confirmation, arbitrators limited to cases',async t=>{
  const f=await fixture(t,{close:false}),app=productionApp(f.db,'fixture');t.after(()=>app.stop());const url=await app.start(0),origin=new URL(url).origin;
  type S={cookie:string;csrf:string};
  const login=async(username:string,pw:string):Promise<S>=>{const r=await fetch(url+'/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username,password:pw})});return {cookie:r.headers.get('set-cookie')!.split(';')[0],csrf:(await r.json()).csrf};};
  const owner=await login('owner',password),post=(s:S,path:string,body:unknown)=>fetch(url+path,{method:'POST',headers:{cookie:s.cookie,origin,'content-type':'application/json','x-csrf-token':s.csrf},body:JSON.stringify(body)});
  assert.equal((await fetch(url+'/api/automation',{headers:{origin}})).status,401);
  assert.equal((await (await fetch(url+'/api/automation',{headers:{cookie:owner.cookie,origin}})).json()).enabled,false);
  assert.equal((await post(owner,'/api/automation/enable',{enabled:true,confirmation:'yes'})).status,400);
  assert.equal((await post(owner,'/api/automation/unlock',{backup:await backup,password:'wrong-password-123'})).status,400);
  const unlocked=await post(owner,'/api/automation/unlock',{backup:await backup,password:backupPassword});assert.equal(unlocked.status,200);assert.equal((await unlocked.json()).unlocked,true);
  assert.equal((await (await post(owner,'/api/automation/enable',{enabled:true,confirmation:'AUTO'})).json()).enabled,true);
  assert.equal((await (await post(owner,'/api/automation/enable',{enabled:false})).json()).enabled,false);
  assert.equal((await (await post(owner,'/api/automation/lock',{})).json()).unlocked,false);
  assert.equal((await post(owner,'/api/admins',{username:'judge',password:'judge-password-123',role:'OWNER'})).status,400);
  const created=await post(owner,'/api/admins',{username:'judge',password:'judge-password-123',role:'ARBITRATOR'});assert.equal(created.status,200);
  const judgeId=(await created.json()).admins.find((a:{username:string})=>a.username==='judge').id;
  const judge=await login('judge','judge-password-123');
  assert.equal((await fetch(url+'/api/automation',{headers:{cookie:judge.cookie,origin}})).status,403);
  assert.equal((await fetch(url+'/api/admins',{headers:{cookie:judge.cookie,origin}})).status,403);
  assert.equal((await post(judge,'/api/platform-settings',{})).status,403);
  assert.equal((await post(judge,`/api/approvals/${f.request}/review`,{approve:true})).status,403);
  assert.equal((await post(judge,'/api/admins/password',{current:'judge-password-123',next:'judge-password-456'})).status,200);
  assert.equal((await post(owner,`/api/admins/${judgeId}/disable`,{})).status,200);
  assert.equal((await fetch(url+'/api/overview',{headers:{cookie:judge.cookie,origin}})).status,401);
});
