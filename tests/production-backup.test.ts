import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PGlite} from '@electric-sql/pglite';
import {HDNodeWallet,Interface} from 'ethers';
import {migrateProduction,type ProductionDatabase} from '../src/production/database.js';
import {AdminAuth} from '../src/production/admin-auth.js';
import {ProductionOrders} from '../src/production/orders.js';
import {ProductionWallets} from '../src/production/wallets.js';
import {ProductionCases} from '../src/production/cases.js';
import {ProductionCaseFiles} from '../src/production/case-files.js';
import {ProductionBackups,summarizeProduction} from '../src/production/backup.js';
import {chainPolicy,type DepositProof} from '../src/production/bep20.js';
import {tokenUnits} from '../src/production/amounts.js';
import {productionApp} from '../src/production/http-app.js';

const root=HDNodeWallet.fromSeed(new Uint8Array(32).fill(47)).derivePath("m/44'/60'/0'/0"),child=root.deriveChild(0);
const buyer='0x1111111111111111111111111111111111111111',seller='0x2222222222222222222222222222222222222222',token='0x3333333333333333333333333333333333333333';
const policy=chainPolicy(97,token),block='0x'+'b'.repeat(64),password='test-only-backup-admin',backupPassword='synthetic backup passphrase 2026';
const CONFIG='PRODUCTION_TELEGRAM_BOT_TOKEN=123456:synthetic_fixture_token_not_real\nBNB_RPC_URL=https://fixture.test\n',SECRET_NOTE='unique-description-marker-7f3a';
function receipt(hash:string):DepositProof{
  const abi=new Interface(['event Transfer(address indexed from,address indexed to,uint256 value)']);
  const log=abi.encodeEventLog(abi.getEvent('Transfer')!,[buyer,child.address,tokenUnits('105')]);
  return {chainId:97,finalizedBlock:12,canonicalBlockHash:block,receipt:{hash,status:1,blockNumber:11,blockHash:block,logs:[{address:token,index:0,...log}]}};
}
async function fixture(t:any,close=true){
  const raw=new PGlite();await raw.waitReady;const db=raw as unknown as ProductionDatabase;await migrateProduction(db);
  await new AdminAuth(db).bootstrap('owner',password);const admin=(await db.query<{id:string}>('SELECT id FROM production_admins')).rows[0].id;
  await db.query('UPDATE production_chain_settings SET token_contract=$1 WHERE id=1',[token]);const wallets=new ProductionWallets(db);await wallets.configure(root.neuter().extendedKey,policy,admin);
  const orders=new ProductionOrders(db,policy),order=await orders.create({kind:'PRODUCT',buyerId:'1001',sellerId:'1002',buyerAddress:buyer,sellerAddress:seller,principal:'100',description:SECRET_NOTE},admin);
  await orders.accept(order.id,'1001');await orders.accept(order.id,'1002');await wallets.allocate(order.id,10);await orders.credit(order.id,receipt('0x'+'a'.repeat(64)),'0x'+'a'.repeat(64));
  await new ProductionCases(db).dispute(order.id,'1001','Backup fixture dispute',(await orders.get(order.id)).revision);
  await new ProductionCaseFiles(db).submit('1001',order.id,'note',{filename:'log.txt',uniqueId:'u1',load:async()=>Buffer.from('synthetic attachment\n')});
  const dir=await mkdtemp(join(tmpdir(),'escrow-prod-backup-'));await writeFile(join(dir,'.env.production'),CONFIG);
  t.after(async()=>{if(close)await db.close();await rm(dir,{recursive:true,force:true});});
  return {db,raw,admin,order,dir,backups:new ProductionBackups(dir,()=>raw.dumpDataDir('gzip') as Promise<Blob>,join(dir,'.env.production'))};
}

test('backup is encrypted, includes config, and its summary matches the live database',async t=>{
  const f=await fixture(t);await assert.rejects(f.backups.create('short','short'),/12至256/);await assert.rejects(f.backups.create(backupPassword,backupPassword+'x'),/不一致/);
  const info=await f.backups.create(backupPassword,backupPassword),live=await summarizeProduction(f.db);
  assert.deepEqual(info.summary,live);assert.equal(info.summary.orders,1);assert.equal(info.summary.caseFiles,1);assert.equal(info.summary.balanced,true);assert.equal(info.configurationIncluded,true);
  const contents=await readFile(join(f.dir,'data','production-backups',info.fileName),'utf8');
  for(const secret of ['synthetic_fixture_token_not_real',SECRET_NOTE,'synthetic attachment',backupPassword])assert.ok(!contents.includes(secret));
  assert.deepEqual((await f.backups.list()).map(b=>b.id),[info.id]);
  assert.deepEqual(await readdir(join(f.dir,'data','production-restore-checks')),[]);
});
test('restore check rebuilds a separate copy with identical records and recovered config; the live database is untouched',async t=>{
  const f=await fixture(t);const info=await f.backups.create(backupPassword,backupPassword);
  await assert.rejects(f.backups.verify(info.id,'wrong password value'),/密码不正确/);await assert.rejects(f.backups.verify('not-an-id',backupPassword),/无效/);
  const result=await f.backups.verify(info.id,backupPassword);assert.equal(result.verified,true);assert.equal(result.summary.digest,info.summary.digest);
  assert.equal(await readFile(join(f.dir,result.directory,'.env.production.recovered'),'utf8'),CONFIG);
  const copy=new PGlite(join(f.dir,result.directory,'database'));await copy.waitReady;
  try{assert.equal((await copy.query<{description:string}>('SELECT description FROM production_orders')).rows[0].description,SECRET_NOTE);
    assert.equal(Buffer.from((await copy.query<{bytes:Uint8Array}>('SELECT bytes FROM production_case_files')).rows[0].bytes).toString(),'synthetic attachment\n');}finally{await copy.close();}
  await f.db.query("UPDATE production_orders SET state='MANUAL_REVIEW',revision=revision+1");assert.notEqual((await summarizeProduction(f.db)).digest,info.summary.digest);
  assert.equal((await f.backups.verify(info.id,backupPassword)).summary.digest,info.summary.digest);
});
test('a tampered backup file is rejected',async t=>{
  const f=await fixture(t);const info=await f.backups.create(backupPassword,backupPassword),file=join(f.dir,'data','production-backups',info.fileName);
  const envelope=JSON.parse(await readFile(file,'utf8')),bytes=Buffer.from(envelope.ciphertext,'base64');bytes[10]^=1;envelope.ciphertext=bytes.toString('base64');await writeFile(file,JSON.stringify(envelope));
  await assert.rejects(f.backups.verify(info.id,backupPassword),/损坏/);
});
test('backup endpoints are owner-only with CSRF, and are disabled for PostgreSQL',async t=>{
  const f=await fixture(t,false),app=productionApp(f.db,'pglite-local',{backupRoot:f.dir});t.after(()=>app.stop());const url=await app.start(0);
  assert.equal((await fetch(url+'/api/backups')).status,401);
  const login=await fetch(url+'/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'owner',password})}),cookie=login.headers.get('set-cookie')!.split(';')[0],{csrf}=await login.json();
  assert.equal((await fetch(url+'/api/backups',{method:'POST',headers:{cookie,'content-type':'application/json'},body:JSON.stringify({password:backupPassword,repeat:backupPassword})})).status,403);
  const created=await fetch(url+'/api/backups',{method:'POST',headers:{cookie,'content-type':'application/json','x-csrf-token':csrf},body:JSON.stringify({password:backupPassword,repeat:backupPassword})});assert.equal(created.status,201);const info=await created.json();
  assert.equal((await (await fetch(url+'/api/backups',{headers:{cookie}})).json()).backups[0].id,info.id);
  const verified=await fetch(url+'/api/backups/'+info.id+'/verify',{method:'POST',headers:{cookie,'content-type':'application/json','x-csrf-token':csrf},body:JSON.stringify({password:backupPassword})});assert.equal(verified.status,200);assert.equal((await verified.json()).verified,true);
  const raw=new PGlite();await raw.waitReady;await migrateProduction(raw as unknown as ProductionDatabase);await new AdminAuth(raw as unknown as ProductionDatabase).bootstrap('owner',password);
  const pg=productionApp(raw as unknown as ProductionDatabase,'postgresql',{backupRoot:f.dir});t.after(()=>pg.stop());const pgUrl=await pg.start(0);
  const pgCookie=(await fetch(pgUrl+'/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'owner',password})})).headers.get('set-cookie')!.split(';')[0];
  const refused=await fetch(pgUrl+'/api/backups',{headers:{cookie:pgCookie}});assert.equal(refused.status,400);assert.match((await refused.json()).error,/PostgreSQL/);
});
