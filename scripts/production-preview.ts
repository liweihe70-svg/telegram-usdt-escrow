import {PGlite} from '@electric-sql/pglite';
import {Interface} from 'ethers';
import {writeFile} from 'node:fs/promises';
import {migrateProduction,type ProductionDatabase} from '../src/production/database.js';
import {AdminAuth} from '../src/production/admin-auth.js';
import {ProductionOrders} from '../src/production/orders.js';
import {productionApp} from '../src/production/http-app.js';
import {chainPolicy} from '../src/production/bep20.js';
import {tokenUnits} from '../src/production/amounts.js';

// Ephemeral fixtures only. No .env, RPC, signer, real account or persistent wallet.
const raw=new PGlite();await raw.waitReady;const db=raw as unknown as ProductionDatabase;await migrateProduction(db);
const auth=new AdminAuth(db);await auth.bootstrap('qa_owner','qa-only-fixture-password');
const admin=(await db.query<{id:string}>('SELECT id FROM production_admins')).rows[0].id;
const token='0x3333333333333333333333333333333333333333',buyer='0x1111111111111111111111111111111111111111',seller='0x2222222222222222222222222222222222222222';
await db.query('UPDATE production_chain_settings SET token_contract=$1',[token]);const orders=new ProductionOrders(db,chainPolicy(97,token));
const abi=new Interface(['event Transfer(address indexed from,address indexed to,uint256 value)']);
for(let index=0;index<2;index++){
  const order=await orders.create({kind:'PRODUCT',buyerId:'1001',sellerId:'1002',buyerAddress:buyer,sellerAddress:seller,principal:'100',description:`QA ${index+1} · Synthetic fixture; no actual funds`},admin);
  await orders.accept(order.id,'1001');await orders.accept(order.id,'1002');
  const deposit='0x'+String(index+4).repeat(40),hash='0x'+String(index+6).repeat(64),block='0x'+'b'.repeat(64);
  await orders.assignDepositAddress(order.id,deposit);
  const log=abi.encodeEventLog(abi.getEvent('Transfer')!,[buyer,deposit,tokenUnits('105')]);
  await orders.credit(order.id,{chainId:97,finalizedBlock:11,canonicalBlockHash:block,receipt:{hash,status:1,blockNumber:10,blockHash:block,logs:[{address:token,index:0,...log}]}},hash);
  await orders.declare(order.id,'1002');await orders.requestRelease(order.id,'1001');
}
const app=productionApp(db,'ephemeral-qa');const url=await app.start(0);await writeFile('data/production-preview-status.json',JSON.stringify({url,username:'qa_owner',fixtureOnly:true}));console.log(JSON.stringify({url,fixtureOnly:true}));
process.once('SIGINT',()=>void app.stop());process.once('SIGTERM',()=>void app.stop());
