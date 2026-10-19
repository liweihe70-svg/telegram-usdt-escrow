import test from 'node:test';
import assert from 'node:assert/strict';
import {Interface} from 'ethers';
import {quote,tokenAmount,tokenUnits,UINT256_MAX} from '../src/production/amounts.js';
import {BNB_USDT_CONTRACT,chainPolicy,verifiedTransfers,walletAddress,type DepositProof} from '../src/production/bep20.js';
import {PostgresDatabase,type ConnectionPool,type TransactionConnection} from '../src/production/postgres.js';

const to='0x1111111111111111111111111111111111111111',from='0x2222222222222222222222222222222222222222';
const txHash='0x'+'a'.repeat(64),blockHash='0x'+'b'.repeat(64);
const policy=chainPolicy(56,BNB_USDT_CONTRACT);
function proof():DepositProof{
  const abi=new Interface(['event Transfer(address indexed from,address indexed to,uint256 value)']);
  const log=abi.encodeEventLog(abi.getEvent('Transfer')!,[from,to,tokenUnits('105')]);
  return {chainId:56,finalizedBlock:101,canonicalBlockHash:blockHash,receipt:{hash:txHash,status:1,blockNumber:100,blockHash,logs:[{address:policy.tokenContract,index:2,...log}]}};
}
test('BEP20 18-place amounts retain exact smallest units and large integers',()=>{
  for(const amount of ['0','105','0.000000000000000001','12345678901234567890.123456789012345678'])assert.equal(tokenAmount(tokenUnits(amount)),amount);
  assert.equal(tokenUnits('105').toString(),'105000000000000000000');
  assert.equal(tokenAmount(tokenUnits(UINT256_MAX.toString(),0),0),UINT256_MAX.toString());
  for(const amount of ['-1','NaN','1e9','1.0000000000000000001',(UINT256_MAX+1n).toString()])assert.throws(()=>tokenUnits(amount));
});
test('BEP20 fee quote uses integer arithmetic and rejects overflow',()=>{
  assert.deepEqual(quote('100','5',500),{principal:tokenUnits('100').toString(),fee:tokenUnits('5').toString(),total:tokenUnits('105').toString()});
  assert.equal(quote('0.000000000000000001','0',1).fee,'1');
  assert.throws(()=>quote('0','5',500));assert.throws(()=>quote('1','0',0.5));
});
test('asset allowlist rejects another chain, zero address and fake mainnet token',()=>{
  assert.throws(()=>chainPolicy(1,BNB_USDT_CONTRACT));assert.throws(()=>chainPolicy(56,to));
  assert.throws(()=>walletAddress('sim:wallet'));assert.throws(()=>walletAddress('0x'+'0'.repeat(40)));
  assert.equal(chainPolicy(97,to).tokenContract,to);
});
test('verified BEP20 proof returns exact amount, hash and event identity',()=>{
  const transfers=verifiedTransfers(policy,proof(),txHash,to);
  assert.equal(transfers.length,1);assert.equal(transfers[0].amount,tokenUnits('105').toString());
  assert.equal(transfers[0].eventIndex,2);assert.equal(transfers[0].txHash,txHash);
});
test('deposit proof rejects reverted, unfinalized, reorganized or wrong-chain transactions',()=>{
  const changes=[(p:DepositProof)=>p.receipt.status=0,(p:DepositProof)=>p.finalizedBlock=99,(p:DepositProof)=>p.chainId=97,(p:DepositProof)=>p.canonicalBlockHash='0x'+'c'.repeat(64)];
  for(const change of changes){const p=proof();change(p);assert.throws(()=>verifiedTransfers(policy,p,txHash,to));}
  assert.throws(()=>verifiedTransfers(policy,proof(),'0x'+'c'.repeat(64),to));
});
test('transfer filtering ignores other assets and destinations; rejects removed/duplicate logs',()=>{
  let p=proof();p.receipt.logs[0].address=from;assert.deepEqual(verifiedTransfers(policy,p,txHash,to),[]);
  assert.deepEqual(verifiedTransfers(policy,proof(),txHash,from),[]);
  p=proof();p.receipt.logs[0].removed=true;assert.throws(()=>verifiedTransfers(policy,p,txHash,to));
  p=proof();p.receipt.logs=[...p.receipt.logs,p.receipt.logs[0]];assert.throws(()=>verifiedTransfers(policy,p,txHash,to));
});
function database(failAt?:string){
  const queries:string[]=[],releases:boolean[]=[];
  const client:TransactionConnection={async query<Row>(sql:string){queries.push(sql);if(sql===failAt)throw Error('controlled failure');return {rows:[] as Row[]};},release(destroy=false){releases.push(destroy);}};
  const pool:ConnectionPool={async connect(){return client;},async query<Row>(){throw Error('transaction must not use pool.query');return {rows:[] as Row[]};},async end(){}};
  return {db:new PostgresDatabase(pool),queries,releases};
}
test('PostgreSQL transaction pins one client and commits before release',async()=>{
  const {db,queries,releases}=database();assert.equal(await db.transaction(async tx=>{await tx.query('operation');return 42;}),42);
  assert.equal(queries[0],'BEGIN');assert.deepEqual(queries.slice(-2),['operation','COMMIT']);assert.deepEqual(releases,[false]);
});
test('PostgreSQL failed operation rolls back without commit',async()=>{
  const {db,queries,releases}=database('operation');await assert.rejects(db.transaction(tx=>tx.query('operation')));
  assert.equal(queries.at(-1),'ROLLBACK');assert(!queries.includes('COMMIT'));assert.deepEqual(releases,[false]);
});
test('PostgreSQL deferred commit failure rolls back; broken rollback destroys client',async()=>{
  let fixture=database('COMMIT');await assert.rejects(fixture.db.transaction(async()=>{}));assert.equal(fixture.queries.at(-1),'ROLLBACK');
  fixture=database('ROLLBACK');await assert.rejects(fixture.db.transaction(async()=>{throw Error('abort');}));assert.deepEqual(fixture.releases,[true]);
  await fixture.db.close();await assert.rejects(fixture.db.query('SELECT 1'));await assert.rejects(fixture.db.transaction(async()=>{}));
});
