import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {HDNodeWallet,Interface} from 'ethers';
import {migrateProduction,type ProductionDatabase} from '../src/production/database.js';
import {AdminAuth} from '../src/production/admin-auth.js';
import {ProductionOrders} from '../src/production/orders.js';
import {ProductionWallets} from '../src/production/wallets.js';
import {ProductionCases} from '../src/production/cases.js';
import {ProductionCaseFiles,classify,parseFileCaption,type CaseUpload} from '../src/production/case-files.js';
import {ProductionTelegramController,type ProductionView} from '../src/production/telegram-controller.js';
import {createProductionTelegramBot} from '../src/production/telegram-bot.js';
import {chainPolicy,type DepositProof} from '../src/production/bep20.js';
import {tokenUnits} from '../src/production/amounts.js';
import {productionApp} from '../src/production/http-app.js';

const root=HDNodeWallet.fromSeed(new Uint8Array(32).fill(43)).derivePath("m/44'/60'/0'/0"),child=root.deriveChild(0);
const buyer='0x1111111111111111111111111111111111111111',seller='0x2222222222222222222222222222222222222222',token='0x3333333333333333333333333333333333333333';
const policy=chainPolicy(97,token),block='0x'+'b'.repeat(64),password='test-only-files-password';
const PNG=Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),Buffer.from('synthetic png body')]),TXT=Buffer.from('Delivery chat log, synthetic fixture.\n','utf8');
function receipt(hash:string):DepositProof{
  const abi=new Interface(['event Transfer(address indexed from,address indexed to,uint256 value)']);
  const log=abi.encodeEventLog(abi.getEvent('Transfer')!,[buyer,child.address,tokenUnits('105')]);
  return {chainId:97,finalizedBlock:12,canonicalBlockHash:block,receipt:{hash,status:1,blockNumber:11,blockHash:block,logs:[{address:token,index:0,...log}]}};
}
async function fixture(t:any,{dispute=true,close=true}={}){
  const raw=new PGlite();await raw.waitReady;const db=raw as unknown as ProductionDatabase;await migrateProduction(db);
  await new AdminAuth(db).bootstrap('owner',password);const admin=(await db.query<{id:string}>('SELECT id FROM production_admins')).rows[0].id;
  await db.query('UPDATE production_chain_settings SET token_contract=$1 WHERE id=1',[token]);const wallets=new ProductionWallets(db);await wallets.configure(root.neuter().extendedKey,policy,admin);
  const orders=new ProductionOrders(db,policy),order=await orders.create({kind:'PRODUCT',buyerId:'1001',sellerId:'1002',buyerAddress:buyer,sellerAddress:seller,principal:'100',description:'Isolated attachment fixture; no network or funds'},admin);
  await orders.accept(order.id,'1001');await orders.accept(order.id,'1002');await wallets.allocate(order.id,10);await orders.credit(order.id,receipt('0x'+'a'.repeat(64)),'0x'+'a'.repeat(64));
  if(dispute)await new ProductionCases(db).dispute(order.id,'1001','Item not delivered as described',(await orders.get(order.id)).revision);
  if(close)t.after(()=>db.close());return {db,admin,orders,order,files:new ProductionCaseFiles(db)};
}
const upload=(bytes:Buffer,filename:string,uniqueId:string,onLoad=()=>{}):CaseUpload&{loads:number}=>{const u={filename,uniqueId,size:bytes.length,loads:0,load:async()=>{u.loads++;onLoad();return bytes;}};return u;};

test('format checks follow file content, not only the extension; captions need a full order ID',()=>{
  assert.equal(classify(PNG,'a.png'),'image/png');assert.equal(classify(TXT,'a.txt'),'text/plain');assert.equal(classify(Buffer.from('%PDF-1.7'),'a.pdf'),'application/pdf');
  assert.throws(()=>classify(TXT,'a.png'),/仅支持/);assert.throws(()=>classify(Buffer.from([0,1,2]),'a.txt'),/仅支持/);assert.throws(()=>classify(Buffer.from('MZ'),'a.exe'),/仅支持/);
  assert.throws(()=>classify(Buffer.alloc(5*1024*1024+1),'a.txt'),/5MB/);
  const id='0e6c0b4e-58a3-4d3e-9b39-3b1f1c4c9d55';assert.deepEqual(parseFileCaption(`/file_evidence ${id} photo of the box`),{orderId:id,note:'photo of the box'});
  assert.throws(()=>parseFileCaption('/file_evidence 0e6c0b4e note'),/完整订单编号/);assert.throws(()=>parseFileCaption(undefined),/完整订单编号/);
});
test('only parties of a disputed order can submit; nothing is downloaded before those checks',async t=>{
  const f=await fixture(t);const outsider=upload(PNG,'a.png','u1');await assert.rejects(f.files.submit('1003',f.order.id,'',outsider),/参与者/);assert.equal(outsider.loads,0);
  const g=await fixture(t,{dispute:false});const early=upload(PNG,'a.png','u1');await assert.rejects(g.files.submit('1001',g.order.id,'',early),/争议/);assert.equal(early.loads,0);
  const wrong=upload(TXT,'a.png','u2');await assert.rejects(f.files.submit('1001',f.order.id,'',wrong),/仅支持/);
  assert.equal((await f.db.query<{n:number}>('SELECT count(*)::int AS n FROM production_case_files')).rows[0].n,0);
});
test('a stored file is logged in the case history once; a replayed upload is not stored or downloaded again',async t=>{
  const f=await fixture(t);const first=upload(PNG,'../../box.png','tg-unique-1'),saved=await f.files.submit('1001',f.order.id,'Box photo',first);assert.equal(saved.duplicate,false);
  const replay=upload(PNG,'box.png','tg-unique-1'),again=await f.files.submit('1001',f.order.id,'Box photo',replay);assert.equal(again.duplicate,true);assert.equal(again.id,saved.id);assert.equal(replay.loads,0);
  const [file]=await f.files.list(f.order.id,'1002');assert.equal(file.filename,'box.png');assert.equal(file.mime,'image/png');assert.equal(file.size,PNG.length);assert.equal(file.note,'Box photo');
  const events=(await f.db.query<{action:string;message:string}>("SELECT action,message FROM production_case_events WHERE action='PARTY_FILE'")).rows;assert.equal(events.length,1);assert.match(events[0].message,/box\.png/);
  assert.deepEqual(Buffer.from((await f.files.read(saved.id,'1002')).bytes),PNG);await assert.rejects(f.files.read(saved.id,'1003'),/参与者/);assert.ok(await f.files.read(saved.id));
  await assert.rejects(f.db.query("UPDATE production_case_files SET note='edited'"));await assert.rejects(f.db.query('DELETE FROM production_case_files'));
});
test('per-party quota is enforced and a state change during download blocks storage',async t=>{
  const f=await fixture(t);for(let i=0;i<5;i++)await f.files.submit('1002',f.order.id,'',upload(TXT,`log${i}.txt`,`q${i}`));
  await assert.rejects(f.files.submit('1002',f.order.id,'',upload(TXT,'log5.txt','q5')),/额度/);await f.files.submit('1001',f.order.id,'',upload(TXT,'buyer.txt','b0'));
  const racing=upload(TXT,'late.txt','late',()=>{void f.db.query("UPDATE production_orders SET state='MANUAL_REVIEW',revision=revision+1 WHERE id=$1",[f.order.id]);});
  await assert.rejects(f.files.submit('1001',f.order.id,'',racing),/不在争议/);
});
test('Telegram attachment with caption is saved, listed and returned only to the parties',async t=>{
  const f=await fixture(t);const router=new ProductionTelegramController(f.db,'formal_fixture_bot'),sent:ProductionView[]=[],documents:{filename:string;bytes:Uint8Array}[]=[];let downloads=0;
  const bot=createProductionTelegramBot('123456:synthetic_fixture_token_not_real',router,undefined,{reply:async(_c,v)=>{sent.push(v);},acknowledge:async()=>{},document:async(_c,filename,bytes)=>{documents.push({filename,bytes});},download:async()=>{downloads++;return TXT;}});
  bot.botInfo={id:99,is_bot:true,first_name:'QA',username:'formal_fixture_bot',can_join_groups:false,can_read_all_group_messages:false,supports_inline_queries:false};
  const from=(id:number)=>({id,is_bot:false,first_name:'QA'}),chat=(id:number)=>({id,type:'private' as const,first_name:'QA'});
  const doc={file_id:'file-1',file_unique_id:'unique-1',file_name:'chat.txt',file_size:TXT.length};
  await bot.handleUpdate({update_id:1,message:{message_id:1,date:1,from:from(1003),chat:chat(1003),document:doc,caption:`/file_evidence ${f.order.id} not mine`}} as never);assert.equal(downloads,0);assert.match(sent.at(-1)!.text,/附件未保存/);
  await bot.handleUpdate({update_id:2,message:{message_id:2,date:1,from:from(1002),chat:chat(1002),document:doc,caption:`/file_evidence ${f.order.id} Seller chat log`}} as never);assert.equal(downloads,1);assert.match(sent.at(-1)!.text,/附件已保存/);
  await bot.handleUpdate({update_id:3,message:{message_id:3,date:1,from:from(1002),chat:chat(1002),document:doc,caption:`/file_evidence ${f.order.id} Seller chat log`}} as never);assert.equal(downloads,1);assert.match(sent.at(-1)!.text,/未重复/);
  await bot.handleUpdate({update_id:4,message:{message_id:4,date:1,from:from(1001),chat:chat(1001),text:`/evidences ${f.order.id}`}} as never);
  const button=sent.at(-1)!.buttons!.flat().find(b=>b.callback_data?.startsWith('pf:'))!;assert.match(sent.at(-1)!.text,/chat\.txt/);
  await bot.handleUpdate({update_id:5,callback_query:{id:'cb',from:from(1001),chat_instance:'x',message:{message_id:5,date:1,chat:chat(1001),text:'list'},data:button.callback_data}} as never);
  assert.equal(documents.length,1);assert.equal(documents[0].filename,'chat.txt');assert.deepEqual(Buffer.from(documents[0].bytes),TXT);
  await bot.handleUpdate({update_id:6,callback_query:{id:'cb2',from:from(1003),chat_instance:'x',message:{message_id:6,date:1,chat:chat(1003),text:'list'},data:button.callback_data}} as never);assert.equal(documents.length,1);assert.match(sent.at(-1)!.text,/无法取回/);
  const card=await router.orderView(f.order.id,'1001');assert.ok(card.buttons!.flat().some(b=>b.callback_data===`p:ev:${f.order.id}`));
});
test('panel download needs a login and never serves uploads as a page',async t=>{
  const f=await fixture(t,{close:false});const saved=await f.files.submit('1001',f.order.id,'',upload(PNG,'box.png','p1')),txt=await f.files.submit('1001',f.order.id,'',upload(TXT,'note.txt','p2'));
  const app=productionApp(f.db,'fixture');t.after(()=>app.stop());const url=await app.start(0);
  assert.equal((await fetch(url+'/api/case-files/'+saved.id)).status,401);
  const login=await fetch(url+'/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'owner',password})}),cookie=login.headers.get('set-cookie')!.split(';')[0];
  const image=await fetch(url+'/api/case-files/'+saved.id+'?inline=1',{headers:{cookie}});assert.equal(image.headers.get('content-type'),'image/png');assert.match(image.headers.get('content-disposition')!,/^inline/);assert.deepEqual(Buffer.from(await image.arrayBuffer()),PNG);
  const text=await fetch(url+'/api/case-files/'+txt.id+'?inline=1',{headers:{cookie}});assert.match(text.headers.get('content-disposition')!,/^attachment/);assert.match(text.headers.get('content-security-policy')!,/sandbox/);assert.equal(text.headers.get('x-content-type-options'),'nosniff');
  const detail=await (await fetch(url+'/api/orders/'+f.order.id,{headers:{cookie}})).json();assert.equal(detail.files.length,2);assert.equal(detail.files[0].bytes,undefined);
});
