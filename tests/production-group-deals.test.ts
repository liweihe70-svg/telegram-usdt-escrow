import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {HDNodeWallet,Interface} from 'ethers';
import {migrateProduction,type ProductionDatabase} from '../src/production/database.js';
import {AdminAuth} from '../src/production/admin-auth.js';
import {ProductionOrders} from '../src/production/orders.js';
import {ProductionWallets} from '../src/production/wallets.js';
import {ProductionGroups,type GroupInput,type GroupView} from '../src/production/groups.js';
import {chainPolicy,type DepositProof} from '../src/production/bep20.js';
import {tokenUnits} from '../src/production/amounts.js';
import {productionApp} from '../src/production/http-app.js';
import {ProductionTelegramController} from '../src/production/telegram-controller.js';
import {createProductionTelegramBot} from '../src/production/telegram-bot.js';

const root=HDNodeWallet.fromSeed(new Uint8Array(32).fill(59)).derivePath("m/44'/60'/0'/0"),child=root.deriveChild(0);
const BUYER_ADDR='0x1111111111111111111111111111111111111111',SELLER_ADDR='0x2222222222222222222222222222222222222222',token='0x3333333333333333333333333333333333333333';
const policy=chainPolicy(97,token),block='0x'+'b'.repeat(64),password='test-only-group-deals',GROUP='-1001234567890';
function receipt(hash:string,amount:string):DepositProof{
  const abi=new Interface(['event Transfer(address indexed from,address indexed to,uint256 value)']);
  const log=abi.encodeEventLog(abi.getEvent('Transfer')!,[BUYER_ADDR,child.address,tokenUnits(amount)]);
  return {chainId:97,finalizedBlock:12,canonicalBlockHash:block,receipt:{hash,status:1,blockNumber:11,blockHash:block,logs:[{address:token,index:0,...log}]}};
}
async function fixture(t:any,close=true){
  const raw=new PGlite();await raw.waitReady;const db=raw as unknown as ProductionDatabase;await migrateProduction(db);
  await new AdminAuth(db).bootstrap('owner',password);const admin=(await db.query<{id:string}>('SELECT id FROM production_admins')).rows[0].id;
  await db.query('UPDATE production_chain_settings SET token_contract=$1 WHERE id=1',[token]);const wallets=new ProductionWallets(db);await wallets.configure(root.neuter().extendedKey,policy,admin);
  for(const id of ['1001','1002'])await db.query('INSERT INTO production_allowlist(user_id,added_by) VALUES($1,$2)',[id,admin]);
  const groups=new ProductionGroups(db,'formal_fixture_bot'),statuses=new Map([['1001','member'],['1002','member'],['1003','member'],['bot','administrator']]);
  const act=(actor:string,input:Partial<GroupInput>)=>groups.handle({chatId:GROUP,actor,status:async id=>statuses.get(id)??'left',botStatus:async()=>statuses.get('bot')!,...input});
  if(close)t.after(()=>db.close());return {db,admin,wallets,groups,statuses,act,orders:new ProductionOrders(db,policy)};
}
type F=Awaited<ReturnType<typeof fixture>>;
const cbs=(v:GroupView|null)=>(v?.buttons??[]).flat().map(b=>b.callback_data).filter(Boolean) as string[];
// Text of a reply and every message that follows it (view.after chain).
const all=(v:GroupView|null|undefined):string=>v?[v.text,all(v.after)].filter(Boolean).join('\n'):'';
const button=(v:GroupView|null,prefix:string)=>{const found=cbs(v).find(c=>c.startsWith(prefix));assert(found,`missing ${prefix} in ${cbs(v).join(',')}`);return found;};
const deal=async(f:F)=>(await f.db.query<{state:string;order_id:string|null;version:number}>('SELECT state,order_id,version FROM production_group_deals ORDER BY created_at DESC LIMIT 1')).rows[0];
async function ordered(f:F){
  await f.act('1001',{text:`/buyer ${BUYER_ADDR}`});const done=await f.act('1002',{text:`/seller ${SELLER_ADDR}`});return {view:done,orderId:(await deal(f)).order_id!};
}
async function funded(f:F){const r=await ordered(f);await f.wallets.allocate(r.orderId,10);await f.orders.credit(r.orderId,receipt('0x'+'a'.repeat(64),'15'),'0x'+'a'.repeat(64));return r.orderId;}

test('only allowlisted members can take a role; one person cannot be both; a taken role needs /reset',async t=>{
  const f=await fixture(t);
  await assert.rejects(f.act('1003',{text:`/buyer ${BUYER_ADDR}`}),/白名单/);assert.equal(await f.act('1003',{text:BUYER_ADDR}),null);
  assert.match((await f.act('1001',{text:'/buyer not-an-address'}))!.text,/请使用有效的 USDT \(BEP20\) 地址/);
  assert.match((await f.act('1001',{text:'/buyer'}))!.text,/请按正确格式发送：\/buyer 地址/);
  f.statuses.set('bot','member');await assert.rejects(f.act('1001',{text:`/buyer ${BUYER_ADDR}`}),/管理员/);f.statuses.set('bot','administrator');
  const v=await f.act('1001',{text:`/buyer ${BUYER_ADDR}`});assert.match(v!.text,/托管角色声明/);assert.match(v!.text,/1001/);assert.match(v!.after!.text,/卖家，请用以下格式发送你的收款地址/);
  assert.match((await f.act('1001',{text:`/seller ${SELLER_ADDR}`}))!.text,/你已经是买家。如需更换角色，请使用 \/reset/);
  assert.equal((await f.db.query<{seller_id:string|null}>("SELECT seller_id::text FROM production_group_deals WHERE state='DRAFT'")).rows[0].seller_id,null);await assert.rejects(f.act('1002',{text:`/buyer ${SELLER_ADDR}`}),/reset/);
  await assert.rejects(f.act('1002',{text:'/reset'}),/买家或卖家/);await f.act('1001',{text:'/reset'});assert.equal((await deal(f)).state,'CANCELLED');await f.act('1002',{text:`/buyer ${SELLER_ADDR}`});
});
test('a pasted address offers role buttons that only its sender can use',async t=>{
  const f=await fixture(t);const choice=await f.act('1002',{text:SELLER_ADDR}),seller=button(choice,'g:r:S:1002:');
  await assert.rejects(f.act('1001',{callback:seller}),/自己/);const v=await f.act('1002',{callback:seller});assert.match(v!.text,new RegExp(SELLER_ADDR));assert.equal(v!.replace,true);
});
test('the order and binding are created once both roles are set; there is no amount; /terms only notes the deal before that',async t=>{
  const f=await fixture(t);await f.act('1001',{text:`/buyer ${BUYER_ADDR}`});
  await assert.rejects(f.act('1003',{text:'/terms item'}),/买家或卖家/);
  let v=await f.act('1001',{text:'/terms One synthetic item'});assert.match(v!.text,/卖家，请发送收款地址/);
  v=await f.act('1002',{text:`/seller ${SELLER_ADDR}`});
  const d=await deal(f),o=await f.orders.get(d.order_id!);assert.equal(d.state,'ORDERED');assert.equal(o.state,'AWAITING_DEPOSIT');assert.equal(o.open_amount,true);assert.equal(o.principal,'0');
  assert.equal(o.description,'One synthetic item');assert.equal(o.seller_address,SELLER_ADDR);
  assert.match(v!.text,/托管角色声明/);assert.match(all(v),/本次担保已选择 USDT \(BEP20\)/);assert.match(all(v),/交易信息/);assert.match(all(v),/生成中/);assert.ok(!/应付/.test(all(v)));
  assert.equal((await f.db.query<{state:string}>('SELECT state FROM production_group_bindings')).rows[0].state,'ACTIVE');
  assert.equal((await f.db.query<{n:number}>("SELECT count(*)::int AS n FROM production_notifications WHERE event='GROUP_BOUND'")).rows[0].n,1);
  await f.wallets.allocate(o.id,10);v=await f.act('1003',{text:'/deal'});assert.match(v!.text,new RegExp((await f.orders.get(o.id)).deposit_address!));assert.match(v!.text,/\/verify/);
  await assert.rejects(f.act('1001',{text:`/buyer ${BUYER_ADDR}`}),/进行中的订单/);assert.match((await f.act('1001',{text:'/terms changed'}))!.text,/条款已提交 · 买家/);await assert.rejects(f.act('1003',{text:'/terms mine'}),/只有本单买家或卖家/);
  assert.equal((await f.db.query<{text:string}>('SELECT text FROM production_deal_terms')).rows[0].text,'changed');assert.match((await f.act('1001',{text:'/terms'}))!.text,/付款入金后/);
});
test('a pasted address always shows the role picker; choosing the remaining role creates the deal; cancel removes the picker',async t=>{
  const f=await fixture(t);await f.act('1002',{text:`/seller ${SELLER_ADDR}`});
  assert.ok(cbs(await f.act('1002',{text:SELLER_ADDR})).some(c=>c.startsWith('g:r:')));
  const picker=await f.act('1001',{text:BUYER_ADDR});assert.match(picker!.text,/你要把这个地址用作买家还是卖家/);assert.equal((await deal(f)).order_id,null);
  assert.deepEqual(await f.act('1001',{callback:button(picker,'g:r:X:1001')}),{text:'',remove:true});await assert.rejects(f.act('1002',{callback:button(picker,'g:r:X:1001')}),/自己/);
  const v=await f.act('1001',{callback:button(picker,'g:r:B:1001:')});assert.equal(v!.replace,true);assert.match(v!.text,/买家/);assert.match(all(v),/交易信息/);
  const o=await f.orders.get((await deal(f)).order_id!);assert.equal(o.buyer_id,'1001');assert.equal(o.buyer_address,BUYER_ADDR);
});
test('open amount: deposits add up until release is requested; the fee follows the current rule; later funds go to manual review',async t=>{
  const f=await fixture(t);const {orderId}=await ordered(f);await f.wallets.allocate(orderId,10);
  const pay=(n:number,amount:string)=>f.orders.credit(orderId,receipt('0x'+n.toString(16).padStart(64,'0'),amount),'0x'+n.toString(16).padStart(64,'0'));
  await pay(1,'3');let o=await f.orders.get(orderId);assert.equal(o.state,'AWAITING_DEPOSIT');assert.equal(o.principal,'0');assert.equal(o.expected_deposit,tokenUnits('3').toString());
  assert.match((await f.act('1003',{text:'/balance'}))!.text,/最低手续费/);
  await pay(2,'12');o=await f.orders.get(orderId);assert.equal(o.state,'FUNDED');assert.equal(o.principal,tokenUnits('10').toString());assert.equal(o.fee,tokenUnits('5').toString());
  await pay(3,'185');o=await f.orders.get(orderId);assert.equal(o.state,'FUNDED');assert.equal(o.expected_deposit,tokenUnits('200').toString());
  assert.equal(BigInt(o.principal)+BigInt(o.fee),tokenUnits('200'));assert.equal(o.fee,(tokenUnits('200')-BigInt(o.principal)).toString());assert.ok(BigInt(o.fee)>=tokenUnits('200')*5n/105n);
  const balance=(await f.act('1003',{text:'/balance'}))!.text;assert.match(balance,/200\.0 USDT \(BEP20\) \[\$200\.0\]/);assert.match(balance,/卖家可得/);
  await f.orders.declare(orderId,'1002');await pay(4,'10');o=await f.orders.get(orderId);assert.equal(o.state,'AWAITING_CONFIRMATION');assert.equal(o.expected_deposit,tokenUnits('210').toString());
  const request=await f.orders.requestRelease(orderId,'1001');
  assert.equal((await f.db.query<{amount:string}>("SELECT allocations->0->>'amount' AS amount FROM production_payout_requests WHERE id=$1",[request])).rows[0].amount,o.principal);
  await pay(5,'1');o=await f.orders.get(orderId);assert.equal(o.state,'MANUAL_REVIEW');assert.equal(o.expected_deposit,tokenUnits('210').toString());
});
test('in-group delivery and release are role-checked, revision-bound and end in an administrator payout request',async t=>{
  const f=await fixture(t);const orderId=await funded(f);let v=await f.act('1003',{text:'/deal'});
  const deliver=button(v,'g:x:dl:');await assert.rejects(f.act('1003',{callback:deliver}),/买家或卖家/);await assert.rejects(f.act('1001',{callback:deliver}),/卖家/);
  v=await f.act('1002',{callback:deliver});assert.equal((await f.orders.get(orderId)).state,'AWAITING_CONFIRMATION');await assert.rejects(f.act('1002',{callback:deliver}),/已变化/);
  const release=button(v,'g:x:rl:');await assert.rejects(f.act('1002',{callback:release}),/买家/);
  const confirm=await f.act('1001',{callback:release});assert.match(confirm!.text,new RegExp(SELLER_ADDR));assert.equal((await f.orders.get(orderId)).state,'AWAITING_CONFIRMATION');
  v=await f.act('1001',{callback:button(confirm,'g:x:RL:')});assert.equal((await f.orders.get(orderId)).state,'PENDING_APPROVAL');assert.match(v!.text,/管理员审核/);
  assert.equal((await f.db.query<{kind:string}>('SELECT kind FROM production_payout_requests')).rows[0].kind,'RELEASE');
  await assert.rejects(f.act('1001',{callback:`g:x:dl:${'0'.repeat(8)}-0000-4000-8000-${'0'.repeat(12)}:1`}),/不属于/);
});
test('in-group refund needs the other party; balance, links and /dispute work on the bound order',async t=>{
  const f=await fixture(t);const orderId=await funded(f);
  const bal=await f.act('1003',{text:'/balance'});assert.match(bal!.text,/托管钱包/);assert.match(bal!.text,/15\.0 USDT \(BEP20\) \[\$15\.0\]/);
  const refreshed=await f.act('1003',{callback:button(bal,`g:b:${orderId}`)});assert.equal(refreshed!.edit,true);assert.match(refreshed!.text,/15\.0 USDT/);
  await assert.rejects(f.act('1003',{callback:`g:b:${'0'.repeat(8)}-0000-4000-8000-${'0'.repeat(12)}`}),/不属于/);assert.match((await f.act('1003',{text:'/blockchain'}))!.text,/testnet\.bscscan\.com\/tx\/0xaaaa/);
  let v=await f.act('1001',{callback:button(await f.act('1001',{text:'/deal'}),'g:x:rf:')});assert.equal((await f.orders.get(orderId)).state,'REFUND_REQUESTED');
  await assert.rejects(f.act('1001',{callback:button(v,'g:x:ra:')}),/另一方/);
  v=await f.act('1002',{callback:button(v,'g:x:ra:')});assert.equal((await f.db.query<{kind:string}>('SELECT kind FROM production_payout_requests')).rows[0].kind,'REFUND');
  const g=await fixture(t);const second=await funded(g);await g.act('1002',{text:'/dispute Buyer stopped replying'});assert.equal((await g.orders.get(second)).state,'DISPUTED');
});
test('a finished order frees the group for the next deal',async t=>{
  const f=await fixture(t);const {orderId}=await ordered(f);await f.db.query("UPDATE production_orders SET state='CLOSED',revision=revision+1 WHERE id=$1",[orderId]);
  await f.act('1001',{text:`/buyer ${BUYER_ADDR}`});assert.equal((await f.db.query<{state:string}>('SELECT state FROM production_group_bindings')).rows[0].state,'REVOKED');assert.equal((await deal(f)).state,'DRAFT');
});
test('allowlist endpoints need the owner and CSRF',async t=>{
  const f=await fixture(t,false),app=productionApp(f.db,'pglite-local');t.after(()=>app.stop());const url=await app.start(0);
  assert.equal((await fetch(url+'/api/allowlist')).status,401);
  const login=await fetch(url+'/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'owner',password})}),cookie=login.headers.get('set-cookie')!.split(';')[0],{csrf}=await login.json();
  assert.equal((await fetch(url+'/api/allowlist',{method:'POST',headers:{cookie,'content-type':'application/json'},body:JSON.stringify({userId:'1003'})})).status,403);
  const added=await (await fetch(url+'/api/allowlist',{method:'POST',headers:{cookie,'content-type':'application/json','x-csrf-token':csrf},body:JSON.stringify({userId:'1003',note:'friend'})})).json();
  assert.deepEqual(added.users.map((u:{user_id:string})=>u.user_id),['1001','1002','1003']);
  const removed=await (await fetch(url+'/api/allowlist/remove',{method:'POST',headers:{cookie,'content-type':'application/json','x-csrf-token':csrf},body:JSON.stringify({userId:'1001'})})).json();
  assert.deepEqual(removed.users.map((u:{user_id:string})=>u.user_id),['1002','1003']);
  assert.equal((await fetch(url+'/api/allowlist',{method:'POST',headers:{cookie,'content-type':'application/json','x-csrf-token':csrf},body:JSON.stringify({userId:'abc'})})).status,400);
});
test('open trading lets anyone deal, still limited by unfinished orders per person',async t=>{
  const f=await fixture(t);await assert.rejects(f.act('1003',{text:`/buyer ${BUYER_ADDR}`}),/白名单/);
  await f.db.query('UPDATE production_trade_settings SET open_trading=true,max_open_orders_per_user=1');
  await f.act('1003',{text:`/buyer ${BUYER_ADDR}`});await f.act('1002',{text:`/seller ${SELLER_ADDR}`});assert.equal((await deal(f)).state,'ORDERED');
  const other=new ProductionGroups(f.db,'formal_fixture_bot'),inOther=(actor:string,text:string)=>other.handle({chatId:'-1009999999999',actor,text,status:async()=>'member',botStatus:async()=>'administrator'});
  await assert.rejects(inOther('1003',`/buyer ${BUYER_ADDR}`),/最多 1 笔/);
});
test('the add-to-group /start posts an approval invite link; join requests admit only the parties or one allowed counterparty',async t=>{
  const f=await fixture(t);f.statuses.set('bot','member');assert.match((await f.act('1001',{text:'/start@formal_fixture_bot deal'}))!.text,/设为本群管理员/);
  f.statuses.set('bot','administrator');const titles:string[]=[],welcome=await f.act('1001',{text:'/start@formal_fixture_bot deal',invite:async()=>'https://t.me/+fixtureInvite',rename:async title=>{titles.push(title);}});
  assert.equal(titles.length,1);assert.ok(welcome!.after!.after!.text.startsWith(`已创建担保群 #${titles[0].replace('Escrow #','')}\n`));
  assert.match(welcome!.text,/\/buyer/);assert.match(welcome!.after!.text,/担保群只用于入金和放款/);assert.match(welcome!.after!.after!.text,/已创建担保群 #[a-z0-9]{5}\n群链接：https:\/\/t\.me\/\+fixtureInvite/);
  assert.equal(await f.groups.joinDecision(GROUP,'1003',2),false);assert.equal(await f.groups.joinDecision(GROUP,'1002',2),true);assert.equal(await f.groups.joinDecision(GROUP,'1002',3),false);
  await f.act('1002',{text:`/seller ${SELLER_ADDR}`});assert.equal(await f.groups.joinDecision(GROUP,'1002',5),true);
  const router=new ProductionTelegramController(f.db,'formal_fixture_bot'),joins:{user:number;ok:boolean}[]=[];
  const bot=createProductionTelegramBot('123456:synthetic_fixture_token_not_real',router,undefined,{reply:async()=>{},acknowledge:async()=>{},memberCount:async()=>2,join:async(_c,user,ok)=>{joins.push({user,ok});}},f.groups);
  bot.botInfo={id:99,is_bot:true,first_name:'QA',username:'formal_fixture_bot',can_join_groups:true,can_read_all_group_messages:false,supports_inline_queries:false};
  for(const [n,id] of [[1,1001],[2,1003]] as const)await bot.handleUpdate({update_id:n,chat_join_request:{chat:{id:Number(GROUP),type:'supergroup',title:'Deal'},from:{id,is_bot:false,first_name:'QA'},user_chat_id:id,date:1}} as never);
  assert.deepEqual(joins,[{user:1001,ok:true},{user:1003,ok:false}]);
});
test('the private home is a welcome card with real statistics and the four main buttons',async t=>{
  const f=await fixture(t);const home=await new ProductionTelegramController(f.db,'formal_fixture_bot').home('1001');
  assert.match(home.text,/已完成交易：0/);assert.match(home.text,/已解决争议：0/);assert.match(home.text,/担保手续费：/);assert.equal(home.html,true);assert.match(home.after!.text,/\/create/);
  assert.deepEqual(home.buttons!.map(row=>row.length),[1,1,1,1]);
  assert.deepEqual(home.buttons!.slice(0,3).map(r=>r[0].callback_data),['p:w','p:i','p:t']);
  assert.match(home.buttons![3][0].url!,/startgroup=deal/);
});
test('trade settings need the owner, CSRF and a sane per-person limit',async t=>{
  const f=await fixture(t,false),app=productionApp(f.db,'pglite-local');t.after(()=>app.stop());const url=await app.start(0);
  const login=await fetch(url+'/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'owner',password})}),cookie=login.headers.get('set-cookie')!.split(';')[0],{csrf}=await login.json();
  const post=(body:unknown,withCsrf=true)=>fetch(url+'/api/trade-settings',{method:'POST',headers:{cookie,'content-type':'application/json',...(withCsrf?{'x-csrf-token':csrf}:{})},body:JSON.stringify(body)});
  assert.equal((await post({open:true,maxPerUser:2},false)).status,403);assert.equal((await post({open:true,maxPerUser:0})).status,400);
  assert.equal((await post({open:true,maxPerUser:3})).status,200);
  const s=(await (await fetch(url+'/api/allowlist',{headers:{cookie}})).json()).settings;assert.equal(s.open_trading,true);assert.equal(s.max_open_orders_per_user,3);
});
test('group language can be switched before any order exists and carries over to the order',async t=>{
  // Whoever adds the bot through the one-tap link owns the group.
  const f=await fixture(t);f.statuses.set('1001','creator');const welcome=await f.act('1001',{text:'/start deal'});
  assert.ok(!cbs(welcome).some(c=>c.startsWith('g:l:')));
  const english=await f.act('1001',{text:'/language en'});assert.match(english!.text,/No deal in this group/);
  await assert.rejects(f.act('1003',{text:'/language zh'}),/群管理员/);await assert.rejects(f.act('1003',{callback:'g:l:zh'}),/群管理员/);
  const {view}=await ordered(f);assert.match(view!.text,/ESCROW ROLE DECLARATION/);assert.match(all(view),/TRANSACTION INFORMATION/);
  assert.equal((await f.db.query<{language:string}>('SELECT language FROM production_group_bindings')).rows[0].language,'en');
  assert.match((await f.act('1002',{text:'/language zh'}))!.text,/交易信息/);
});
