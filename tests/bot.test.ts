import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { Escrow, TEST_NETWORK } from '../src/escrow.js';
import { BotController } from '../src/bot-controller.js';
import { BotNotifications } from '../src/bot-notifications.js';
import { createBot } from '../src/telegram-bot.js';
import { SimulationWorker } from '../src/simulation-worker.js';
import { orderView, type View } from '../src/bot-ui.js';
import { DEMO_PEER } from '../src/bot-admin.js';

let e:Escrow,c:BotController;
before(async()=>{e=await Escrow.open(undefined,['9001']);c=new BotController(e,{username:'EscrowDemo_bot',brand:'测试担保',minimumFee:'5',feeBps:500});});
after(async()=>{await e.db.close();});
const input=(actor:string,text:string)=>c.handle({actor,chatId:actor,text});
const click=(actor:string,callback:string)=>c.handle({actor,chatId:actor,callback});

async function demo(kind='PRODUCT',role='BUYER'){
  const actor='9001',start=await input(actor,'/demo'),id=find(start,'type:').split(':')[2];
  await click(actor,`type:${kind}:${id}`);
  const amountPrompt=await click(actor,`role:${role}:${id}`);assert.match(amountPrompt.text,/交易本金/);
  await input(actor,'100');const review=await input(actor,'仅模拟演练，三天内交付并核对。');
  assert.match(review.text,/系统模拟身份/);await click(actor,find(review,'create:'));
  return {id,actor};
}
async function simulate(actor:string,id:string,action:string){
  const prompt=await click(actor,`demo:${action}:${id}`);assert.match(prompt.text,/确认执行单账号演练步骤/);
  await click(actor,find(prompt,'democ:'));
}
test('单账号演练覆盖商品与P2P双方角色，后台结算不重复出款',async()=>{
  for(const kind of ['PRODUCT','P2P'])for(const role of ['BUYER','SELLER']){
    const {id,actor}=await demo(kind,role);
    const initial=await c.view(id,actor);assert.match(initial.text,/对方为系统模拟身份/);
    assert.equal(initial.buttons?.flat().some(b=>b.url),false);
    await click(actor,`accept:1:${id}`);
    const accepted=await c.view(id,actor);assert.equal(accepted.buttons?.flat().some(b=>b.callback_data?.startsWith('accept:')),false);
    await simulate(actor,id,'ACCEPT');await simulate(actor,id,'DEPOSIT');
    const ownPays=(kind==='PRODUCT' && role==='BUYER') || (kind==='P2P' && role==='SELLER');
    if(ownPays)await simulate(actor,id,'DECLARE');else await click(actor,`act:DECLARE:${id}`);
    if(ownPays){const confirm=await click(actor,`act:RELEASE:${id}`);await click(actor,find(confirm,'execute:'));}
    else await simulate(actor,id,'RELEASE');
    await new SimulationWorker(e).tick();await new SimulationWorker(e).tick();
    assert.equal((await e.get(id)).state,'COMPLETED');
    const payouts=await e.payouts(id);assert.equal(payouts.length,1);assert.equal(payouts[0].amount,'100000000');assert.equal(payouts[0].status,'CONFIRMED');
    for(const b of (await c.view(id,actor)).buttons!.flat())if(b.callback_data)assert.ok(Buffer.byteLength(b.callback_data)<=64);
    await assert.rejects(click(actor,`democ:RELEASE:${id}`),/当前状态/);
  }
});
test('演练不能冒充普通交易参与者，非管理员和其他管理员均不能操作',async()=>{
  await assert.rejects(input('8401','/demo'),/仅限/);
  await assert.rejects(input(DEMO_PEER,'/start'),/私聊/);
  const {id}=await demo();await assert.rejects(click('8401',`democ:ACCEPT:${id}`),/仅限/);
  e.setAdmins(['9001','9002']);
  try{
    await assert.rejects(click('9002',`democ:ACCEPT:${id}`),/自己创建/);
    const ordinary=await draft('9001','8402');await click('9001',ordinary.create);
    await assert.rejects(click('9001',`democ:ACCEPT:${ordinary.id}`),/自己创建/);
  }finally{e.setAdmins(['9001']);}
  await assert.rejects(click('9001',`democ:RELEASE:${id}`),/当前状态/);
});
test('演练退款可拒绝再同意，退还入金方本金及费用',async()=>{
  const {id,actor}=await demo('P2P','BUYER');await click(actor,`accept:1:${id}`);
  await simulate(actor,id,'ACCEPT');await simulate(actor,id,'DEPOSIT');
  await click(actor,`act:REQUEST_REFUND:${id}`);await simulate(actor,id,'REJECT_REFUND');
  assert.equal((await e.get(id)).state,'FUNDED');
  await click(actor,`act:REQUEST_REFUND:${id}`);await simulate(actor,id,'AGREE_REFUND');
  await new SimulationWorker(e).tick();assert.equal((await e.get(id)).state,'REFUNDED');
  const payouts=await e.payouts(id);assert.equal(payouts[0].recipient,`sim:demo_${actor}`);assert.equal(payouts[0].amount,'105000000');
});
test('机器人仲裁需要管理员权限、有效金额和二次确认，重复确认不多出款',async()=>{
  const o=await funded('8501','8502');await e.act(o.id,'8501','DISPUTE');
  await assert.rejects(input('8501','/disputes'),/仅限/);
  await assert.rejects(input('8501',`/arbitrate ${o.id} 55 50 测试`),/仅限/);
  assert.match((await input('9001','/admin')).text,/模拟内测管理/);
  assert.ok((await input('9001','/disputes')).buttons?.flat().some(b=>b.callback_data===`admin:order:${o.id}`));
  assert.match((await click('9001',`admin:order:${o.id}`)).text,/可分配：105/);
  await assert.rejects(input('9001',`/arbitrate ${o.id} 50 50 金额不足`),/合计/);
  const proposal=await input('9001',`/arbitrate ${o.id} 55 50 按交付约定分配`),confirm=find(proposal,'arb:');
  assert.equal((await e.get(o.id)).state,'DISPUTED');
  await assert.rejects(click('8501',confirm),/仅限/);
  await click('9001',confirm);assert.equal((await e.get(o.id)).state,'SETTLING');
  await assert.rejects(click('9001',confirm),/失效/);
  await new SimulationWorker(e).tick();assert.equal((await e.get(o.id)).state,'ARBITRATED');assert.equal((await e.payouts(o.id)).length,2);
});
test('仲裁方案持久化且可取消，旧方案和过期方案不能执行',async()=>{
  const o=await funded('8511','8512');await e.act(o.id,'8511','DISPUTE');
  const first=await input('9001',`/arbitrate ${o.id} 105 0 待核对`);
  const next=await input('9001',`/arbitrate ${o.id} 0 105 已更新`);
  await assert.rejects(click('9001',find(first,'arb:')),/失效/);
  const restarted=new BotController(e,c.config);
  await restarted.handle({actor:'9001',chatId:'9001',callback:find(next,'arb_cancel:')});
  assert.equal((await e.get(o.id)).state,'DISPUTED');assert.equal((await e.payouts(o.id)).length,0);
  await assert.rejects(click('9001',find(next,'arb:')),/失效/);
  const expired=await input('9001',`/arbitrate ${o.id} 0 105 等待核对`);
  await e.db.query("UPDATE bot_admin_proposals SET expires_at=now()-interval '1 second' WHERE order_id=$1",[o.id]);
  await assert.rejects(click('9001',find(expired,'arb:')),/失效/);
});

test('说明类命令及角色指南可用，不改变创建草稿或资金账本',async()=>{
  const d=await click('8101','menu:create');const draftId=find(d,'type:').split(':')[2];
  const before=(await e.db.query('SELECT count(*)::int AS n FROM ledger_entries')).rows[0];
  const help=await input('8101','/instructions');assert.match(help.text,/使用说明/);
  assert.ok(help.buttons?.flat().some(b=>b.callback_data==='help:buyer'));
  assert.match((await click('8101','help:buyer')).text,/保存验收记录/);
  assert.match((await click('8101','help:seller')).text,/不能凭买家截图/);
  assert.match((await input('8101','/rules')).text,/没有自动按超时裁决/);
  assert.match((await input('8101','/whatisescrow')).text,/卖家入金/);
  assert.match((await input('8101','/video')).text,/没有配置教程视频/);
  assert.match((await input('8101','/instructions@EscrowDemo_bot')).text,/使用说明/);
  await assert.rejects(click('8101','help:not-existing'),/未知帮助页面/);
  const resumed=await click('8101',`type:PRODUCT:${draftId}`);assert.match(resumed.text,/哪一方/);
  assert.deepEqual((await e.db.query('SELECT count(*)::int AS n FROM ledger_entries')).rows[0],before);
});
function find(v:View,prefix:string):string{
  const found=v.buttons?.flat().find(b=>b.callback_data?.startsWith(prefix));assert.ok(found?.callback_data);return found.callback_data;
}
async function draft(actor:string,other:string,kind='PRODUCT',role='BUYER'){
  const start=await click(actor,'menu:create');const id=find(start,'type:').split(':')[2];
  await click(actor,`type:${kind}:${id}`);await click(actor,`role:${role}:${id}`);
  await input(actor,other);await input(actor,'100');const review=await input(actor,'测试交付约定：三天内交付并验收。');
  return {id,review,create:find(review,'create:')};
}
async function funded(actor:string,other:string,kind='PRODUCT'){
  const d=await draft(actor,other,kind);await click(actor,d.create);await input(other,`/start order_${d.id}`);
  await click(actor,`accept:1:${d.id}`);await click(other,`accept:1:${d.id}`);
  const o=await e.get(d.id);
  await e.deposit(o.id,{network:TEST_NETWORK,token:'SIM_USDT',txHash:`simtx:${o.id}`,eventIndex:0,amount:'105',confirmed:true,success:true,to:o.deposit_address});
  return e.get(o.id);
}

test('首页声明模拟内测，按钮不超过 Telegram 64 字节限制',async()=>{
  const v=await input('201','/start');assert.match(v.text,/模拟内测/);assert.match(v.text,/不接收真实资金/);
  for(const b of v.buttons!.flat())if(b.callback_data)assert.ok(Buffer.byteLength(b.callback_data)<=64);
});

test('订单查询命令校验身份，区分托管余额与异常款，结算后余额为零',async()=>{
  const o=await funded('8201','8202');
  assert.match((await input('8201','/buyer')).text,/双方身份固定/);
  assert.match((await input('8201','/seller')).text,/不接收真实钱包地址/);
  assert.match((await input('8201','/description')).text,/完整订单编号/);
  assert.match((await input('8201',`/terms ${o.id}`)).text,/三天内交付/);
  assert.match((await input('8201',`/balance ${o.id}`)).text,/待结算托管余额：105 USDT/);
  await assert.rejects(input('8299',`/balance ${o.id}`),/无权查看/);
  await assert.rejects(input('8299',`/terms ${o.id}`),/无权查看/);
  await assert.rejects(input('8299',`/description ${o.id}`),/无权查看/);
  await assert.rejects(input('8299',`/qr ${o.id}`),/无权查看/);
  await assert.rejects(input('8201','/balance not-an-id'),/完整订单编号/);
  await e.deposit(o.id,{network:TEST_NETWORK,token:'SIM_USDT',txHash:`simtx:extra_${o.id}`,eventIndex:0,amount:'3',confirmed:true,success:true,to:o.deposit_address});
  assert.match((await input('8201',`/balance ${o.id}`)).text,/待处理异常款：3 USDT/);
  await e.act(o.id,'8202','DECLARE');await e.act(o.id,'8201','RELEASE');
  await new SimulationWorker(e).tick();
  const done=await input('8201',`/balance ${o.id}`);assert.match(done.text,/待结算托管余额：0 USDT/);assert.match(done.text,/待处理异常款：3 USDT/);
});

test('快捷菜单和订单记录按钮遵循参与方权限，不生成伪区块浏览器链接',async()=>{
  const d=await draft('8301','8302');await click('8301',d.create);
  const menu=await input('8301','/menu');assert.ok(menu.buttons?.flat().some(b=>b.callback_data==='menu:orders'));
  const card=await c.view(d.id,'8301');assert.equal(find(card,'blockchain:'),`blockchain:${d.id}`);
  assert.match((await click('8301',`blockchain:${d.id}`)).text,/还没有出入金记录/);
  assert.match((await click('8301',`terms:${d.id}`)).text,/三天内交付/);
  assert.match((await click('8301',`balance:${d.id}`)).text,/余额：0 USDT/);
  await assert.rejects(click('8399',`blockchain:${d.id}`),/无权查看/);
  await assert.rejects(click('8399',`terms:${d.id}`),/无权查看/);
  await assert.rejects(click('8399',`balance:${d.id}`),/无权查看/);
  await click('8301',`accept:1:${d.id}`);await click('8302',`accept:1:${d.id}`);
  await input('9001',`/simulate_deposit ${d.id}`);
  const records=await input('8301',`/blockchain ${d.id}`);assert.match(records.text,/入金 105 USDT/);assert.match(records.text,/不是真实链上交易/);
  assert.equal(records.buttons?.flat().some(b=>b.url),false);
});
test('订单向导持久化，收费准确，重复创建返回同一订单',async()=>{
  const d=await draft('211','212');assert.match(d.review.text,/105 USDT/);
  const restarted=new BotController(e,c.config);await restarted.handle({actor:'211',chatId:'211',callback:d.create});
  await click('211',d.create);const n=await e.db.query<{n:number}>('SELECT count(*)::int AS n FROM orders WHERE buyer_id=211 AND seller_id=212');assert.equal(n.rows[0].n,1);
  assert.equal(c.quote('99'),'5');assert.equal(c.quote('100'),'5');assert.equal(c.quote('100.000001'),'5.000001');
});
test('旧向导按钮和过期会话被拒绝',async()=>{
  const old=await click('221','menu:create');const oldButton=find(old,'type:');await click('221','menu:create');
  await assert.rejects(click('221',oldButton));
  await e.db.query("UPDATE bot_sessions SET expires_at=now()-interval '1 second' WHERE user_id=221");
  await assert.rejects(click('221',oldButton));
});
test('拒绝自己的 ID、用户名和无效金额',async()=>{
  const start=await click('231','menu:create'),id=find(start,'type:').split(':')[2];
  await click('231',`type:PRODUCT:${id}`);await click('231',`role:BUYER:${id}`);
  await assert.rejects(input('231','231'));await assert.rejects(input('231','@someone'));await input('231','232');
  await assert.rejects(input('231','-1'));await assert.rejects(input('231','0'));await assert.rejects(input('231','1.0000001'));
});
test('邀请只允许指定对方查看订单，外人不能确认或注入 actor',async()=>{
  const d=await draft('241','242');await click('241',d.create);
  assert.match((await input('242',`/start order_${d.id}`)).text,/担保订单/);
  await assert.rejects(input('243',`/start order_${d.id}`));await assert.rejects(click('243',`accept:1:${d.id}`));
  await assert.rejects(c.handle({actor:'241',chatId:'243',callback:`accept:1:${d.id}`}));
});
test('商品订单放款二次确认，错误角色即使伪造回调也不能出款',async()=>{
  const o=await funded('251','252');await click('252',`act:DECLARE:${o.id}`);
  const prompt=await click('251',`act:RELEASE:${o.id}`);assert.match(prompt.text,/请再次确认/);
  assert.equal((await e.get(o.id)).state,'AWAITING_CONFIRMATION');
  await assert.rejects(click('252',`execute:RELEASE:${o.id}`));await click('251',find(prompt,'execute:'));
  assert.equal((await e.get(o.id)).state,'SETTLING');await assert.rejects(click('251',find(prompt,'execute:')));
});
test('退款需要另一方确认，普通机器人回调不能模拟入金或仲裁',async()=>{
  const o=await funded('261','262');await click('261',`act:REQUEST_REFUND:${o.id}`);
  await assert.rejects(click('261',`execute:AGREE_REFUND:${o.id}`));
  const v=await click('262',`act:AGREE_REFUND:${o.id}`);await click('262',find(v,'execute:'));
  assert.equal((await e.get(o.id)).state,'SETTLING');
  await assert.rejects(click('261',`execute:DEPOSIT:${o.id}`));await assert.rejects(click('261',`execute:ARBITRATE:${o.id}`));
});
test('P2P 买家声明法币付款，卖家才能确认放币',async()=>{
  const o=await funded('271','272','P2P');
  const buyer=await c.view(o.id,'271'),seller=await c.view(o.id,'272');
  assert.ok(find(buyer,'act:DECLARE:'));assert.equal(seller.buttons!.flat().some(b=>b.callback_data?.startsWith('act:DECLARE:')),false);
  await click('271',`act:DECLARE:${o.id}`);const ready=await c.view(o.id,'272');assert.ok(find(ready,'act:RELEASE:'));
  await assert.rejects(click('271',`execute:RELEASE:${o.id}`));
});
test('订单卡不包含真实付款按钮，争议状态没有普通结算按钮',async()=>{
  const o=await funded('281','282');const prompt=await input('281',`/dispute ${o.id} 测试交付不符合约定`);await click('281',find(prompt,'dispute:'));
  const v=orderView(await e.get(o.id),'281',c.config.username);
  assert.equal(v.buttons!.flat().some(b=>b.callback_data?.startsWith('act:')),false);
  assert.match(v.text,/争议处理中/);assert.match(v.text,/不接收真实资金/);
  for(const b of v.buttons!.flat())if(b.callback_data)assert.ok(Buffer.byteLength(b.callback_data)<=64);
});

test('争议理由二次确认、申请取消和证据权限不允许跨订单冒充',async()=>{
  const o=await funded('8601','8602');
  const cancelled=await input('8601',`/dispute ${o.id} 需要核对交付`);
  await click('8601',find(cancelled,'dispute_cancel:'));assert.equal((await e.get(o.id)).state,'FUNDED');
  await assert.rejects(click('8601',find(cancelled,'dispute:')),/失效/);
  const request=await input('8601',`/dispute ${o.id} 未按三天内交付的约定交付`);
  await assert.rejects(click('8602',find(request,'dispute:')),/无权/);
  await assert.rejects(input('8699',`/dispute ${o.id} 外人尝试`),/无权/);
  await assert.rejects(click('8601',`execute:DISPUTE:${o.id}`),/争议理由/);
  const restarted=new BotController(e,c.config);
  await restarted.handle({actor:'8601',chatId:'8601',callback:find(request,'dispute:')});
  assert.equal((await e.get(o.id)).state,'DISPUTED');
  await input('8601',`/evidence ${o.id} 第三天仍未收到交付，已联系对方。`);
  await input('8602',`/evidence ${o.id} 交付已发送，请核对约定渠道。`);
  assert.match((await input('9001',`/evidences ${o.id}`)).text,/未按三天内/);
  assert.match((await input('8602',`/evidences ${o.id}`)).text,/第三天仍未/);
  await assert.rejects(input('8699',`/evidence ${o.id} 外人提交`),/无权/);
  await assert.rejects(input('8699',`/evidences ${o.id}`),/无权/);
  await assert.rejects(input('9001',`/evidence ${o.id} 管理员不能替参与方提交`),/无权/);
});

test('证据文字有条数限制并分页，仲裁之后拒绝追加',async()=>{
  const o=await funded('8611','8612');await e.act(o.id,'8611','DISPUTE','交付待核对');
  for(let index=0;index<10;index++)await input('8611',`/evidence ${o.id} 记录${index}：${'核对'.repeat(400)}`);
  await assert.rejects(input('8611',`/evidence ${o.id} 第11条`),/最多10条/);
  const first=await input('8612',`/evidences ${o.id}`);assert.ok(first.text.length<4096);
  const second=await click('8612',find(first,'evidence:'));assert.match(second.text,/第2页/);
  await assert.rejects(click('8612',`evidence:${o.id}:100`),/无效证据页码/);
  await e.arbitrate(o.id,'9001','105','0','依据约定分配');
  await assert.rejects(input('8611',`/evidence ${o.id} 结算后提交`),/仅争议/);
});
test('通知部分失败后只重试未成功收件人',async()=>{
  await e.db.query('UPDATE outbox_jobs SET delivered_at=now()');
  await input('291','/start');await input('292','/start');const d=await draft('291','292');await click('291',d.create);
  let fail=true;const sent:string[]=[];
  const worker=new BotNotifications(c,async chat=>{if(chat==='292' && fail)throw new Error('模拟网络失败');sent.push(chat);});
  await worker.flush();assert.deepEqual(sent,['291']);fail=false;await worker.flush();assert.deepEqual(sent,['291']);await e.db.query('UPDATE outbox_jobs SET retry_at=now()');await worker.flush();assert.deepEqual(sent,['291','292']);
  await worker.flush();assert.deepEqual(sent,['291','292']);
});
test('Telegraf 适配器从真实 update.from 取身份，忽略回调中的身份冒充',async()=>{
  const views:View[]=[];let ack=0;
  const bot=createBot('123456:offline_test_only',c,{reply:async(_ctx,v)=>{views.push(v);},acknowledge:async()=>{ack++;}});
  bot.botInfo={id:99,is_bot:true,first_name:'测试',username:c.config.username,can_join_groups:true,can_read_all_group_messages:false,supports_inline_queries:false};
  await bot.handleUpdate({update_id:1,message:{message_id:1,date:0,from:{id:301,is_bot:false,first_name:'买家'},chat:{id:301,type:'private',first_name:'买家'},text:'/id'}});
  assert.match(views[0].text,/301/);
  await bot.handleUpdate({update_id:2,callback_query:{id:'offline-callback',from:{id:302,is_bot:false,first_name:'外人'},chat_instance:'offline',data:'menu:id',message:{message_id:2,date:0,chat:{id:302,type:'private',first_name:'外人'},text:'首页'}}});
  assert.equal(ack,1);assert.match(views[1].text,/302/);
  await bot.handleUpdate({update_id:3,message:{message_id:3,date:0,from:{id:301,is_bot:false,first_name:'买家'},chat:{id:-10099,type:'supergroup',title:'测试群'},text:'/create'}});
  assert.match(views[2].text,/私聊/);
});
test('Telegram 重复文本更新不会被当作向导的下一步',async()=>{
  const start=await click('311','menu:create'),id=find(start,'type:').split(':')[2];await click('311',`type:PRODUCT:${id}`);await click('311',`role:BUYER:${id}`);
  const event={actor:'311',chatId:'311',text:'312',updateId:90001};
  const first=await c.handle(event),again=await c.handle(event);assert.deepEqual(first,again);
  const state=(await e.db.query<{draft:{step:string}}> ('SELECT draft FROM bot_sessions WHERE user_id=311')).rows[0].draft;assert.equal(state.step,'AMOUNT');
  await e.db.query('INSERT INTO bot_processed_updates(bot_username,update_id,actor) VALUES($1,$2,$3)',[c.config.username,90002,'311']);
  const uncertain=await c.handle({...event,updateId:90002,text:'100'});assert.match(uncertain.text,/需要核对/);
});
test('管理员可注入模拟入金，确认放款后模拟 worker 自动完成结算',async()=>{
  const d=await draft('321','322');await click('321',d.create);
  await assert.rejects(input('9001',`/simulate_deposit ${d.id}`),/双方条款确认/);
  assert.equal((await e.db.query('SELECT id FROM deposits WHERE order_id=$1',[d.id])).rows.length,0);
  await click('321',`accept:1:${d.id}`);await click('322',`accept:1:${d.id}`);
  await assert.rejects(input('321',`/simulate_deposit ${d.id}`));await input('9001',`/simulate_deposit ${d.id}`);
  assert.equal((await e.get(d.id)).state,'FUNDED');await click('322',`act:DECLARE:${d.id}`);await click('321',`execute:RELEASE:${d.id}`);
  const worker=new SimulationWorker(e);await worker.tick();assert.equal((await e.get(d.id)).state,'COMPLETED');await worker.tick();
  assert.equal((await e.payouts(d.id)).length,1);
});
