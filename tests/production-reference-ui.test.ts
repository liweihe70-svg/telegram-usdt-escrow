import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {HDNodeWallet,Interface,keccak256} from 'ethers';
import {migrateProduction,type ProductionDatabase} from '../src/production/database.js';
import {AdminAuth} from '../src/production/admin-auth.js';
import {ProductionOrders} from '../src/production/orders.js';
import {ProductionWallets} from '../src/production/wallets.js';
import {ProductionGroups,type GroupInput,type GroupView} from '../src/production/groups.js';
import {ProductionTelegramController} from '../src/production/telegram-controller.js';
import {ProductionPayouts} from '../src/production/payouts.js';
import type {PayoutRpc} from '../src/production/payout-rpc.js';
import {convert,resetPriceCache} from '../src/production/prices.js';
import {chainPolicy,type DepositProof} from '../src/production/bep20.js';
import {groupError} from '../src/production/group-errors.js';
import {createProductionTelegramBot} from '../src/production/telegram-bot.js';
import {tokenUnits} from '../src/production/amounts.js';

const root=HDNodeWallet.fromSeed(new Uint8Array(32).fill(71)).derivePath("m/44'/60'/0'/0"),child=root.deriveChild(0);
const BUYER='0x1111111111111111111111111111111111111111',SELLER='0x2222222222222222222222222222222222222222',token='0x3333333333333333333333333333333333333333',GROUP='-1001234567890';
const policy=chainPolicy(97,token),block='0x'+'b'.repeat(64);
function receipt(hash:string,from:string,to:string,amount:string):DepositProof{
  const abi=new Interface(['event Transfer(address indexed from,address indexed to,uint256 value)']);
  const log=abi.encodeEventLog(abi.getEvent('Transfer')!,[from,to,tokenUnits(amount)]);
  return {chainId:97,finalizedBlock:12,canonicalBlockHash:block,receipt:{hash,status:1,blockNumber:11,blockHash:block,logs:[{address:token,index:0,...log}]}};
}
async function fixture(t:any){
  const raw=new PGlite();await raw.waitReady;const db=raw as unknown as ProductionDatabase;await migrateProduction(db);t.after(()=>db.close());
  await new AdminAuth(db).bootstrap('owner','test-only-reference-ui');const admin=(await db.query<{id:string}>('SELECT id FROM production_admins')).rows[0].id;
  await db.query('UPDATE production_chain_settings SET token_contract=$1 WHERE id=1',[token]);const wallets=new ProductionWallets(db);await wallets.configure(root.neuter().extendedKey,policy,admin);
  await db.query('UPDATE production_trade_settings SET open_trading=true');
  const groups=new ProductionGroups(db,'formal_fixture_bot'),act=(actor:string,input:Partial<GroupInput>)=>groups.handle({chatId:GROUP,actor,status:async()=>'member',botStatus:async()=>'administrator',...input});
  return {db,admin,wallets,act,orders:new ProductionOrders(db,policy)};
}
type F=Awaited<ReturnType<typeof fixture>>;
const cbs=(v:GroupView|null)=>(v?.buttons??[]).flat().map(b=>b.callback_data).filter(Boolean) as string[];
const button=(v:GroupView|null,prefix:string)=>{const found=cbs(v).find(c=>c.startsWith(prefix));assert(found,`missing ${prefix} in ${cbs(v).join(',')}`);return found;};
async function funded(f:F){
  await f.act('1001',{text:`/buyer ${BUYER}`});const v=await f.act('1001',{text:'/terms One synthetic item'});assert.match(v!.text,/One synthetic item/);
  await f.act('1002',{text:`/seller ${SELLER}`});
  const orderId=(await f.db.query<{order_id:string}>("SELECT order_id FROM production_group_deals WHERE state='ORDERED'")).rows[0].order_id;
  await f.wallets.allocate(orderId,10);await f.orders.credit(orderId,receipt('0x'+'a'.repeat(64),BUYER,child.address,'15'),'0x'+'a'.repeat(64));return orderId;
}

test('/menu shows the quick-access grid; grid buttons say the escrow address is not generated before a deal exists',async t=>{
  const f=await fixture(t);const menu=await f.act('1003',{text:'/menu'});assert.equal(menu!.text,'📄 使用下方按钮操作：');
  assert.deepEqual(cbs(menu),['g:i','g:m:pay','g:m:refund','g:m:reset','g:m:balance','g:m:blockchain','g:m:qr','g:m:contact']);
  const required='🚫 托管地址尚未生成。请先确定买家和卖家角色。';
  for(const key of ['g:m:pay','g:m:refund','g:m:qr','g:m:blockchain','g:m:balance','g:m:dispute'])assert.equal((await f.act('1003',{callback:key}))!.text,required,key);
  for(const command of ['/pay_seller','/refund_buyer','/qr','/blockchain','/balance'])assert.equal((await f.act('1003',{text:command}))!.text,required,command);
  assert.equal((await f.act('1003',{callback:'g:m:reset'}))!.text,'✅ 本群的交易已重置！');
  assert.match((await f.act('1003',{callback:'g:m:contact'}))!.text,/\/dispute/);
  assert.match((await f.act('1003',{text:'/create'}))!.text,/已经是担保群/);assert.match((await f.act('1003',{text:'/whatisescrow'}))!.text,/什么是担保/);
});
test('the seller can refund the buyer directly after a confirmation; the payout check accepts a seller-origin refund',async t=>{
  const f=await fixture(t);const orderId=await funded(f);
  await assert.rejects(f.act('1003',{callback:'g:m:refund'}),/买家或卖家/);
  const buyerAsk=await f.act('1001',{callback:'g:m:refund'});assert.equal((await f.orders.get(orderId)).state,'REFUND_REQUESTED');assert.ok(buyerAsk);
  const g=await fixture(t);const second=await funded(g);const confirm=await g.act('1002',{text:'/refund_buyer'});assert.match(confirm!.text,/退还给买家/);
  await assert.rejects(g.act('1001',{callback:button(confirm,'g:x:RB:')}),/卖家/);
  await g.act('1002',{callback:button(confirm,'g:x:RB:')});assert.equal((await g.orders.get(second)).state,'PENDING_APPROVAL');
  const r=(await g.db.query<{id:string;snapshot_hash:string;allocations:{recipient:string;amount:string}[]}>("SELECT id,snapshot_hash,allocations FROM production_payout_requests WHERE kind='REFUND'")).rows[0];
  assert.deepEqual(r.allocations,[{recipient:BUYER,amount:tokenUnits('15').toString()}]);
  await g.orders.review(r.id,g.admin,true,r.snapshot_hash,'Seller refunded');
  const rpc:PayoutRpc={terms:async()=>({nonce:0,gasLimit:'90000',gasPrice:'1000000000'}),known:async()=>false,send:async(raw)=>keccak256(raw),proof:async()=>null,close:()=>{}};
  const plan=await new ProductionPayouts(g.db,'https://fixture.test',()=>rpc).prepare(r.id,g.admin);assert.equal(plan.plan.recipient,BUYER);
});
test('pay seller waits for delivery and then asks the buyer to confirm',async t=>{
  const f=await fixture(t);const orderId=await funded(f);
  assert.match((await f.act('1001',{text:'/pay_seller'}))!.text,/还没有点「已交付」/);await assert.rejects(f.act('1002',{callback:'g:m:pay'}),/只有买家/);
  await f.orders.declare(orderId,'1002');const confirm=await f.act('1001',{callback:'g:m:pay'});assert.ok(cbs(confirm).some(c=>c.startsWith('g:x:RL:')));
});
test('/verify, /qr and /balance work for the group deal',async t=>{
  const f=await fixture(t);const orderId=await funded(f);
  assert.match((await f.act('1003',{text:`/verify ${child.address}`}))!.text,/验证通过/);assert.match((await f.act('1003',{text:`/verify ${SELLER}`}))!.text,/验证失败/);
  const qr=await f.act('1003',{text:'/qr'});assert.ok(qr!.photo&&qr!.photo.length>100);assert.equal(Buffer.from(qr!.photo!).subarray(1,4).toString(),'PNG');assert.match(qr!.text,new RegExp(child.address));
  const balance=await f.act('1003',{callback:'g:m:balance'});assert.match(balance!.text,/余额: 15\.0 USDT \(BEP20\) \[\$15\.0\]/);assert.match(balance!.text,/卖家可得：10 USDT/);
  assert.deepEqual(cbs(balance),[`g:b:${orderId}`]);assert.equal((await f.act('1003',{callback:`g:b:${orderId}`}))!.edit,true);
});
test('/convert gives an estimate from the price feed and explains the format otherwise',async()=>{
  resetPriceCache();const feed=async()=>({binancecoin:{usd:600,cny:4200,eur:550},tether:{usd:1,cny:7,eur:0.92},bitcoin:{usd:60000,cny:420000,eur:55000}});
  assert.match((await convert('/convert 1 bnb usdt',true,feed)).text,/1 BNB ≈ 600\.0000 USDT/);
  assert.match((await convert('/convert 70 cny usd',true,feed)).text,/≈ 10\.0000 USD/);
  assert.match((await convert('/convert lots',true,feed)).text,/INVALID FORMAT/);
  resetPriceCache();assert.match((await convert('/convert 1 btc usd',false,async()=>{throw Error('down');})).text,/暂时不可用/);
});
test('private /create, /instructions, /terms and /rules answer like the reference bot; home pages close with Back',async t=>{
  const f=await fixture(t);const bot=new ProductionTelegramController(f.db,'formal_fixture_bot'),send=(input:{text?:string;callback?:string})=>bot.handle({actor:'1001',chatId:'1001',...input});
  const create=await send({text:'/create'});assert.ok(create.buttons!.flat().some(b=>b.url?.includes('startgroup=deal')));
  assert.match((await send({text:'/rules'})).text,/规则与条件/);
  const back=(v:{buttons?:{callback_data?:string}[][]})=>assert.deepEqual(v.buttons!.flat().map(b=>b.callback_data),['p:del']);
  for(const input of [{text:'/instructions'},{callback:'p:i'}]){
    const instructions=await send(input);assert.match(instructions.text,/使用说明/);assert.equal(instructions.html,true);back(instructions);
    for(const page of ['home','buyer','seller'])assert.match(instructions.text,new RegExp(`https://t\\.me/formal_fixture_bot\\?start=guide_${page}`),page);
  }
  for(const input of [{text:'/terms'},{callback:'p:t'}]){const terms=await send(input);assert.match(terms.text,/服务条款/);back(terms);}
  for(const input of [{text:'/whatisescrow'},{callback:'p:w'}]){const what=await send(input);assert.match(what.text,/什么是担保/);back(what);}
  assert.deepEqual(await send({callback:'p:del'}),{text:'',remove:true});
  assert.equal((await send({text:'/menu'})).text,'🚫 请使用 /start 初始化机器人。');
  const buyerGuide=await send({text:'/start guide_buyer'}),nav=buyerGuide.buttons!.flat().map(b=>b.callback_data);assert.ok(nav.includes('p:h:home')&&!nav.includes('p:h:buyer'),nav.join(','));
  const video=await send({text:'/video'});assert.match(video.text,/暂时没有教程视频/);back(video);
  assert.equal((await bot.handle({actor:'1001',chatId:'1001',text:'/language'})).buttons!.flat().length,2);
});
test('group replies use the reference wording in English',async t=>{
  const f=await fixture(t);await f.db.query("INSERT INTO production_group_settings(chat_id,language) VALUES($1,'en')",[GROUP]);
  const menu=await f.act('1003',{text:'/menu'});assert.equal(menu!.text,'📄 Navigate menu using the buttons below:');
  assert.deepEqual(menu!.buttons!.flat().map(b=>b.text.replace(/^\S+ /,'')),['Instructions','Pay To Seller','Refund To Buyer','Reset Roles','Balance','Blockchain Link','Get QR','Contact']);
  assert.deepEqual(menu!.buttons!.map(row=>row.length),[1,2,1,2,2]);
  const prompt=await f.act('1001',{text:'/buyer'});assert.equal(prompt!.text,'🚫 Please follow the correct format: /buyer ADDRESS\n\n💡 Replace ADDRESS with a valid USDT (BEP20) wallet address.');
  assert.match((await f.act('1002',{text:'/seller'}))!.text,/^🚫 Please follow the correct format: \/seller ADDRESS/);
  assert.equal((await f.act('1001',{text:'/buyer 0x1234'}))!.text,'🚫 Please use a Valid USDT (BEP20) Address');
  assert.match((await f.act('1001',{text:'/terms'}))!.text,/^📝 After payment is deposited, both buyer and seller must clearly submit their terms here/);
  assert.match((await f.act('1001',{text:'/description something'}))!.text,/^💛 Set seller and buyer address first!/);
  assert.equal((await f.act('1001',{text:'/balance'}))!.text,'🚫 Escrow Address not generated. Please determine Buyer and Seller role first.');
  assert.equal((await f.act('1001',{text:'/qr'}))!.text,'🚫 Escrow Address not generated. Please determine Buyer and Seller role first.');
  assert.equal((await f.act('1001',{text:'/reset'}))!.text,'✅ Bot has been restarted for this chat!');
  assert.match((await f.act('1001',{text:'/contact'}))!.text,/To freeze the deal for an arbitrator, send \/dispute REASON/);
  const usage=await f.act('1001',{text:'/convert'});assert.equal(usage!.html,true);
  assert.match(usage!.text,/^━━━━ ⚡️ Escrow ━━━━\n\n❌ <u>INVALID FORMAT<\/u>\n\n📝 FORMAT: \/convert amount from_coin to_coin\n\nEXAMPLES:/);assert.match(usage!.text,/<i>This command is only for obtaining/);
  const card=await f.act('1001',{text:BUYER,actorName:'@alice'});
  assert.equal(card!.text,`Would you like to use this address as buyer or seller?\n\nAddress: ${BUYER}\n[USDT (BEP20)]\nUser: 1001`);
  assert.deepEqual(card!.buttons!.map(row=>row.map(b=>b.text)),[['BUYER','SELLER'],['CANCEL']]);
  const cancel=card!.buttons![1][0].callback_data!;await assert.rejects(f.act('1002',{callback:cancel}));assert.deepEqual(await f.act('1001',{callback:cancel}),{text:'',remove:true});
  const buyer=await f.act('1001',{callback:card!.buttons![0][0].callback_data!,actorUsername:'alice'});assert.equal(buyer!.replace,true);
  assert.equal(buyer!.text,`📍ESCROW ROLE DECLARATION\n\n👤 BUYER @alice | Userid: [1001]\n\n✅ BUYER WALLET\n${BUYER}\n[USDT (BEP20)]`);
  assert.match(buyer!.after!.text,/^💬 Seller, please enter your receiving address using:\n\/seller ADDRESS/);
  assert.equal((await f.act('1001',{text:`/seller ${SELLER}`}))!.text,"🚫 You're already a buyer. If you want to change roles, please use /reset to reset the deal");
  const seller=await f.act('1002',{text:`/seller ${SELLER}`});assert.match(seller!.text,/👤 SELLER @No Username \| Userid: \[1002\]/);
  const chain:string[]=[];for(let v=seller!.after;v;v=v.after)chain.push(v.text);
  assert.equal(chain[0],'ℹ️ USDT (BEP20) has been selected for this escrow');assert.equal(chain[1],'➖➖➖➖');assert.match(chain[2],/^📍 TRANSACTION INFORMATION/);assert.match(chain[2],/@alice \[1001\]/);assert.match(chain[2],/Being generated/);
  assert.equal(chain.length,3);
});
test('errors in a group are shown in the group language; unknown errors never leak details',async t=>{
  assert.equal(groupError('同一个人不能同时是买家和卖家',true),'🚫 The same person cannot be both buyer and seller.');
  assert.equal(groupError('单笔本金超过上限 20 USDT',true),'🚫 The amount is above the per-deal limit of 20 USDT.');
  assert.equal(groupError('some internal stack detail',true),'🚫 Action not completed. Check your role and the current deal, then try again.');
  assert.equal(groupError('同一个人不能同时是买家和卖家',false),'🚫 同一个人不能同时是买家和卖家');
  const f=await fixture(t);await f.db.query("INSERT INTO production_group_settings(chat_id,language) VALUES($1,'en')",[GROUP]);
  const sent:string[]=[],quotes:(boolean|undefined)[]=[],bot=createProductionTelegramBot('123456:synthetic_fixture_token_not_real',new ProductionTelegramController(f.db,'formal_fixture_bot'),undefined,{reply:async(_c,v)=>{sent.push(v.text);quotes.push(v.quote);},acknowledge:async()=>{},memberStatus:async(_c,_chat,user)=>user==='99'?'administrator':'member'},new (await import('../src/production/groups.js')).ProductionGroups(f.db,'formal_fixture_bot'));
  bot.botInfo={id:99,is_bot:true,first_name:'QA',username:'formal_fixture_bot',can_join_groups:true,can_read_all_group_messages:false,supports_inline_queries:false};
  const chat={id:Number(GROUP),type:'supergroup' as const,title:'Deal'};
  await bot.handleUpdate({update_id:1,message:{message_id:1,date:1,chat,from:{id:1001,is_bot:false,first_name:'QA'},text:`/buyer ${BUYER}`}} as never);
  await bot.handleUpdate({update_id:2,message:{message_id:2,date:1,chat,from:{id:1001,is_bot:false,first_name:'QA'},text:`/seller ${SELLER}`}} as never);
  assert.equal(sent.at(-1),"🚫 You're already a buyer. If you want to change roles, please use /reset to reset the deal");
  await bot.handleUpdate({update_id:3,message:{message_id:3,date:1,chat,from:{id:1002,is_bot:false,first_name:'QA'},text:`/buyer ${SELLER}`}} as never);
  assert.equal(sent.at(-1),'🚫 That role is already taken. Use /reset to start over.');assert.equal(quotes.at(-1),false);
  await f.db.query("UPDATE production_group_settings SET language='zh' WHERE chat_id=$1",[GROUP]);
  await bot.handleUpdate({update_id:4,message:{message_id:4,date:1,chat,from:{id:1002,is_bot:false,first_name:'QA'},text:`/buyer ${SELLER}`}} as never);
  assert.equal(sent.at(-1),'🚫 该角色已被另一位成员设置，可用 /reset 重置');
});
test('adding the bot through the create-group link renames the group in the reference format; group replies are not quoted',async t=>{
  const f=await fixture(t);const titles:string[]=[];
  await f.act('1001',{text:'/start@formal_fixture_bot deal',rename:async title=>{titles.push(title);}});assert.match(titles[0],/^Escrow #[a-z0-9]{5}$/);
  await f.act('1001',{text:'/start@formal_fixture_bot',rename:async title=>{titles.push(title);}});assert.equal(titles.length,1);
  const views:{quote?:boolean}[]=[],bot=createProductionTelegramBot('123456:synthetic_fixture_token_not_real',new ProductionTelegramController(f.db,'formal_fixture_bot'),undefined,{reply:async(_c,v)=>{views.push(v);},acknowledge:async()=>{},memberStatus:async()=>'member'},new (await import('../src/production/groups.js')).ProductionGroups(f.db,'formal_fixture_bot'));
  bot.botInfo={id:99,is_bot:true,first_name:'QA',username:'formal_fixture_bot',can_join_groups:true,can_read_all_group_messages:false,supports_inline_queries:false};
  await bot.handleUpdate({update_id:1,message:{message_id:7,date:1,chat:{id:Number(GROUP),type:'supergroup',title:'Deal'},from:{id:1001,is_bot:false,first_name:'QA'},text:'/menu'}} as never);
  assert.equal(views[0].quote,false);
});
test('a configured welcome video is attached to the /start card',async t=>{
  const f=await fixture(t);const {savePlatformSettings}=await import('../src/production/platform-settings.js'),{applyOverrides}=await import('../src/production/network.js');t.after(()=>applyOverrides({}));
  await savePlatformSettings(f.db,f.admin,{brand:'Escrow',supportUsername:'',defaultLanguage:'zh',maxOrder:'none',maxCustody:'none',feeMin:'5',feeBps:500,welcomeMedia:'https://example.com/welcome.mp4',updatesUrl:'https://t.me/example_updates',vouchesUrl:''});
  const home=await new ProductionTelegramController(f.db,'formal_fixture_bot').home('1001');
  assert.deepEqual(home.media,{kind:'video',url:'https://example.com/welcome.mp4'});assert.match(home.text,/<a href="https:\/\/t\.me\/example_updates">UPDATES<\/a>/);
  await assert.rejects(savePlatformSettings(f.db,f.admin,{brand:'Escrow',supportUsername:'',defaultLanguage:'zh',maxOrder:'none',maxCustody:'none',feeMin:'5',feeBps:500,welcomeMedia:'javascript:alert(1)'}),/https/);
});
