import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {HDNodeWallet,Interface} from 'ethers';
import {migrateProduction,type ProductionDatabase} from '../src/production/database.js';
import {AdminAuth} from '../src/production/admin-auth.js';
import {ProductionOrders} from '../src/production/orders.js';
import {ProductionWallets,publicWallet} from '../src/production/wallets.js';
import {DepositScanner,ProductionDepositMonitor,validateRpc,type DepositReader} from '../src/production/deposit-monitor.js';
import {chainPolicy,type DepositProof} from '../src/production/bep20.js';
import {tokenUnits} from '../src/production/amounts.js';
import {ProductionTelegramController} from '../src/production/telegram-controller.js';
import {productionApp} from '../src/production/http-app.js';
import {saveProductionField} from '../src/production/token-settings.js';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';

// Publicly reproducible, test-only seed. Never used on a network or in real data.
const node=HDNodeWallet.fromSeed(new Uint8Array(32).fill(7)).derivePath("m/44'/60'/0'/0"),xpub=node.neuter().extendedKey;
const token='0x3333333333333333333333333333333333333333',buyer='0x1111111111111111111111111111111111111111',seller='0x2222222222222222222222222222222222222222';
const policy=chainPolicy(97,token),block='0x'+'b'.repeat(64),hash='0x'+'a'.repeat(64),password='test-only-admin-password';
const input=()=>({kind:'PRODUCT' as const,buyerId:'1001',sellerId:'1002',buyerAddress:buyer,sellerAddress:seller,principal:'100',description:'Isolated wallet fixture; no network or funds'});
async function fixture(t:any,close=true){
  const raw=new PGlite();await raw.waitReady;const db=raw as unknown as ProductionDatabase;await migrateProduction(db);
  await new AdminAuth(db).bootstrap('owner',password);const admin=(await db.query<{id:string}>('SELECT id FROM production_admins')).rows[0].id;
  await db.query('UPDATE production_chain_settings SET token_contract=$1 WHERE id=1',[token]);
  const wallets=new ProductionWallets(db);await wallets.configure(xpub,policy,admin);if(close)t.after(()=>db.close());
  return {db,admin,wallets,orders:new ProductionOrders(db,policy)};
}
async function accepted(f:Awaited<ReturnType<typeof fixture>>){const o=await f.orders.create(input(),f.admin);await f.orders.accept(o.id,'1001');await f.orders.accept(o.id,'1002');return o.id;}
function proof(to:string,amount='105',txHash=hash):DepositProof{
  const abi=new Interface(['event Transfer(address indexed from,address indexed to,uint256 value)']),log=abi.encodeEventLog(abi.getEvent('Transfer')!,[buyer,to,tokenUnits(amount)]);
  return {chainId:97,finalizedBlock:10,canonicalBlockHash:block,receipt:{hash:txHash,status:1,blockNumber:10,blockHash:block,logs:[{address:token,index:0,...log}]}};
}
class Reader implements DepositReader{
  policy=policy;head=10;hashes:string[]=[];proof?:DepositProof;badReceipt=false;canonical=block;closed=false;
  async preflight(){return {};}
  async finalizedHead(){return {number:this.head,hash:this.canonical};}
  async blockHash(_number:number){return this.canonical;}
  async transferHashes(from:number,to:number,_address:string){return this.proof&&(this.proof.receipt.blockNumber<from||this.proof.receipt.blockNumber>to)?[]:this.hashes;}
  async depositProof(_hash:string){if(this.badReceipt||!this.proof)throw Error('Unavailable receipt');return this.proof;}
  close(){this.closed=true;}
}
test('wallet public import rejects secrets and wrong derivation depth; RPC rejects env injection',()=>{
  assert.equal(publicWallet(xpub).deriveChild(0).address,node.deriveChild(0).address);
  assert.throws(()=>publicWallet(node.extendedKey));assert.throws(()=>publicWallet('abandon '.repeat(12)));
  assert.throws(()=>publicWallet(HDNodeWallet.fromSeed(new Uint8Array(32).fill(8)).neuter().extendedKey));
  assert.throws(()=>validateRpc('https://example.test/key\nOTHER=secret'));assert.throws(()=>validateRpc('https://user:password@example.test'));validateRpc('https://example.test/api?key=local-only');
});
test('allocation requires both parties, remains stable on retries and never rewinds or rotates the root',async t=>{
  const f=await fixture(t),o=await f.orders.create(input(),f.admin);await assert.rejects(f.wallets.allocate(o.id,10));
  await f.orders.accept(o.id,'1001');await assert.rejects(f.wallets.allocate(o.id,10));await f.orders.accept(o.id,'1002');
  const [a,b]=await Promise.all([f.wallets.allocate(o.id,10),f.wallets.allocate(o.id,10)]);assert.equal(a,b);assert.equal(a,node.deriveChild(0).address);
  const second=await accepted(f);assert.equal(await new ProductionWallets(f.db).allocate(second,12),node.deriveChild(1).address);
  assert.equal((await f.wallets.status()).nextIndex,'2');
  await migrateProduction(f.db);assert.equal((await f.wallets.status()).nextIndex,'2');
  await assert.rejects(f.db.query('UPDATE production_wallet_root SET next_index=0'));
  await assert.rejects(f.db.query('DELETE FROM production_wallet_allocations WHERE order_id=$1',[o.id]));
  await assert.rejects(f.wallets.configure(HDNodeWallet.fromSeed(new Uint8Array(32).fill(8)).derivePath("m/44'/60'/0'/0").neuter().extendedKey,policy,f.admin));
  await assert.rejects(f.wallets.configure(xpub,chainPolicy(56,'0x55d398326f99059fF775485246999027B3197955'),f.admin));
});
test('scanner resumes after credit-before-checkpoint failure without double crediting',async t=>{
  const f=await fixture(t),id=await accepted(f),r=new Reader(),address=await f.wallets.allocate(id,10);r.hashes=[hash];r.proof=proof(address);
  const original=f.db.query.bind(f.db);let fail=true;
  const proxy=new Proxy(f.db,{get(target,key){if(key==='query')return (sql:string,args?:unknown[])=>{if(fail&&sql.startsWith('UPDATE production_wallet_cursors')){fail=false;throw Error('Simulated checkpoint crash');}return original(sql,args);};const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});
  await assert.rejects(new DepositScanner(proxy,r).tick(),/Simulated checkpoint crash/);assert.equal((await f.orders.get(id)).state,'FUNDED');
  assert.equal((await f.db.query<{next_block:string}>('SELECT next_block::text FROM production_wallet_cursors')).rows[0].next_block,'8');
  await new DepositScanner(f.db,r).tick();
  assert.equal((await f.db.query<{n:number}>('SELECT count(*)::int AS n FROM production_deposits')).rows[0].n,1);
  assert.equal((await f.db.query<{n:string}>('SELECT sum(amount)::text AS n FROM production_ledger_entries')).rows[0].n,'0');
  assert.equal((await f.db.query<{next_block:string}>('SELECT next_block::text FROM production_wallet_cursors')).rows[0].next_block,'11');
});
test('missing receipt preserves cursor; a short deposit is credited as partial and the order keeps waiting',async t=>{
  const f=await fixture(t),id=await accepted(f),r=new Reader(),address=await f.wallets.allocate(id,10);r.hashes=[hash];r.badReceipt=true;
  await assert.rejects(new DepositScanner(f.db,r).tick());assert.equal((await f.orders.get(id)).state,'AWAITING_DEPOSIT');
  assert.equal((await f.db.query<{next_block:string}>('SELECT next_block::text FROM production_wallet_cursors')).rows[0].next_block,'8');
  r.badReceipt=false;r.proof=proof(address,'104');await new DepositScanner(f.db,r).tick();assert.equal((await f.orders.get(id)).state,'AWAITING_DEPOSIT');
  assert.equal((await f.db.query<{classification:string}>('SELECT classification FROM production_deposits')).rows[0].classification,'CREDITED');
});
test('finalized checkpoint conflict freezes orders and blocks previously approved payout',async t=>{
  const f=await fixture(t),id=await accepted(f),r=new Reader(),address=await f.wallets.allocate(id,10);r.hashes=[hash];r.proof=proof(address);await new DepositScanner(f.db,r).tick();
  await f.orders.declare(id,'1002');const request=await f.orders.requestRelease(id,'1001');const snap=(await f.db.query<{snapshot_hash:string}>('SELECT snapshot_hash FROM production_payout_requests WHERE id=$1',[request])).rows[0].snapshot_hash;await f.orders.review(request,f.admin,true,snap,'Fixture approval');
  r.canonical='0x'+'c'.repeat(64);await assert.rejects(new DepositScanner(f.db,r).tick());
  assert.equal((await f.orders.get(id)).state,'MANUAL_REVIEW');assert.equal((await f.db.query<{status:string}>('SELECT status FROM production_payout_requests WHERE id=$1',[request])).rows[0].status,'BLOCKED');
});
test('runtime preflight and monitoring are explicit; bot only exposes allocated test address while active',async t=>{
  const f=await fixture(t),id=await accepted(f),r=new Reader(),runtime=new ProductionDepositMonitor(f.db,'https://example.test',()=>r);
  assert.equal((await runtime.status()).state,'stopped');await runtime.start();assert.equal((await runtime.status()).state,'running');
  const address=(await f.orders.get(id)).deposit_address!;const controller=new ProductionTelegramController(f.db,'fixture_bot',()=>runtime.running());
  const view=await controller.orderView(id,'1001');assert.ok(view.text.includes(address));assert.ok(view.text.includes('禁止发送主网'));
  assert.ok(!(await controller.orderView(id,'1002')).text.includes(address));await runtime.stop();assert.ok(!(await controller.orderView(id,'1001')).text.includes(address));assert.equal(r.closed,true);
  await assert.rejects(runtime.configure(xpub,'file:///secret',f.admin,async()=>{}));assert.ok(!JSON.stringify(await runtime.status()).includes('https://example.test'));
});
test('wallet HTTP configuration requires OWNER and CSRF; settings cannot change an imported root',async t=>{
  const f=await fixture(t,false);let saved='';const app=productionApp(f.db,'fixture',{saveRpc:async rpc=>{saved=rpc;}});const url=await app.start(0);t.after(()=>app.stop());
  const login=await fetch(url+'/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'owner',password})}),session=await login.json() as {csrf:string};const cookie=login.headers.get('set-cookie')!.split(';')[0];
  const post=(path:string,payload:unknown,csrf?:string)=>fetch(url+path,{method:'POST',headers:{'content-type':'application/json',cookie,...(csrf?{'x-csrf-token':csrf}:{})},body:JSON.stringify(payload)});
  assert.equal((await post('/api/wallet/configure',{xpub,rpcUrl:'https://example.test/key'})).status,403);
  assert.equal((await post('/api/wallet/configure',{xpub,rpcUrl:'https://example.test/key'},session.csrf)).status,200);assert.equal(saved,'https://example.test/key');
  assert.equal((await post('/api/settings',{chainId:56,tokenContract:'0x55d398326f99059fF775485246999027B3197955'},session.csrf)).status,400);
  const status=await (await fetch(url+'/api/wallet',{headers:{cookie}})).text();assert.ok(!status.includes('/key'));assert.ok(!status.includes(xpub));assert.ok(status.includes('stopped'));
  assert.equal((await fetch(url+'/api/wallet')).status,401);
  await f.db.query("INSERT INTO production_admins(id,username,password_hash,role) SELECT $1,'operator',password_hash,'OPERATOR' FROM production_admins WHERE id=$2",[randomUUID(),f.admin]);
  const op=await new AdminAuth(f.db).login('operator',password,'fixture-operator');
  assert.equal((await fetch(url+'/api/wallet/stop',{method:'POST',headers:{'content-type':'application/json',cookie:'escrow_production='+op.token,'x-csrf-token':op.csrf},body:'{}'})).status,403);
});
test('scanner processes bounded ranges and keeps watching funded addresses for extra transfers',async t=>{
  const f=await fixture(t),id=await accepted(f),r=new Reader(),address=await f.wallets.allocate(id,10);r.head=2010;r.hashes=[hash];r.proof=proof(address);r.proof.finalizedBlock=2010;r.proof.receipt.blockNumber=2008;
  const scanner=new DepositScanner(f.db,r);await scanner.tick();assert.equal((await f.orders.get(id)).state,'AWAITING_DEPOSIT');await scanner.tick();assert.equal((await f.orders.get(id)).state,'AWAITING_DEPOSIT');await scanner.tick();assert.equal((await f.orders.get(id)).state,'FUNDED');
  const extra='0x'+'d'.repeat(64);r.head=2011;r.hashes=[extra];r.proof=proof(address,'1',extra);r.proof.finalizedBlock=2011;r.proof.receipt.blockNumber=2011;
  await new DepositScanner(f.db,r).tick();assert.equal((await f.orders.get(id)).state,'MANUAL_REVIEW');assert.equal((await f.db.query<{n:number}>('SELECT count(*)::int AS n FROM production_deposits')).rows[0].n,2);
});
test('RPC persistence preserves literal replacement characters and unrelated local configuration',async t=>{
  const root=await mkdtemp(join(tmpdir(),'escrow-rpc-fixture-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const path=join(root,'.env.production');await writeFile(path,'OTHER=test-only\nBNB_RPC_URL=https://old.test\n');
  const rpc='https://example.test/key?$&=literal';validateRpc(rpc);await saveProductionField(root,'BNB_RPC_URL',rpc);
  assert.equal(await readFile(path,'utf8'),'OTHER=test-only\nBNB_RPC_URL='+rpc+'\n');
});
