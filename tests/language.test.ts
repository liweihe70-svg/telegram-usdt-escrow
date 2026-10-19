import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import { Escrow } from '../src/escrow.js';
import { BotController } from '../src/bot-controller.js';
import { BotNotifications } from '../src/bot-notifications.js';
import { BOT_COMMANDS,BOT_COMMANDS_EN } from '../src/bot-commands.js';
import { english } from '../src/bot-english.js';
import { createBot } from '../src/telegram-bot.js';
import type { View } from '../src/bot-ui.js';

let e:Escrow,c:BotController;
const config={username:'LanguageTest_bot',brand:'Escrow Test',minimumFee:'5',feeBps:500};
before(async()=>{e=await Escrow.open(undefined,['9001']);c=new BotController(e,config);});
after(async()=>{await e.db.close();});
const input=(actor:string,text:string)=>c.handle({actor,chatId:actor,text});
const click=(actor:string,callback:string)=>c.handle({actor,chatId:actor,callback});
function find(v:View,prefix:string){const result=v.buttons?.flat().find(b=>b.callback_data?.startsWith(prefix));assert.ok(result?.callback_data);return result.callback_data;}
async function order(actor:string,other:string,description:string,kind='PRODUCT'){
  const start=await input(actor,'/create'),id=find(start,'type:').split(':')[2];
  await click(actor,`type:${kind}:${id}`);await click(actor,`role:BUYER:${id}`);
  await input(actor,other);await input(actor,'100');const review=await input(actor,description);
  const card=await click(actor,find(review,'create:'));return {id,card,review};
}

test('语言入口中英可见，偏好独立持久保存，切回中文不残留英文按钮',async()=>{
  const home=await input('701','/start');assert.equal(find(home,'menu:language'),'menu:language');
  const picker=await input('701','/language');assert.ok(picker.buttons?.flat().some(b=>b.text==='English'));
  const en=await click('701','lang:en');assert.match(en.text,/Language set to English/);assert.match(en.text,/Telegram escrow/);assert.equal(en.language,'en');
  assert.equal((await new BotController(e,config).handle({actor:'701',chatId:'701',text:'/start'})).language,'en');
  assert.match((await input('702','/start')).text,/模拟内测/);
  const zh=await click('701','lang:zh');assert.match(zh.text,/已切换为中文/);assert.equal(zh.language,'zh');
  assert.ok(zh.buttons?.flat().some(b=>b.text==='创建担保交易'));
  await assert.rejects(input('701','/language fr'),/zh or en/);assert.equal(await c.language('701'),'zh');
});

test('填写中切换语言不丢草稿、金额或回调编号，语言菜单返回可继续向导',async()=>{
  const first=await input('711','/create'),id=find(first,'type:').split(':')[2];
  await click('711',`type:PRODUCT:${id}`);await click('711',`role:BUYER:${id}`);await input('711','712');
  const before=(await e.db.query('SELECT draft,expires_at FROM bot_sessions WHERE user_id=711')).rows[0];
  const en=await input('711','/language en');assert.match(en.text,/Enter the principal/);
  assert.deepEqual((await e.db.query('SELECT draft,expires_at FROM bot_sessions WHERE user_id=711')).rows[0],before);
  await input('711','100');await click('711','menu:language');const resumed=await click('711','language:resume');assert.match(resumed.text,/Enter the goods/);
  const review=await input('711','Keep this contract exactly as written.');assert.match(review.text,/Review before creation/);assert.equal(find(review,'create:'),`create:${id}`);
  const switched=await input('711','/language zh');assert.match(switched.text,/本金：100 USDT/);assert.equal(find(switched,'create:'),`create:${id}`);
});

test('英文订单、查询、状态和错误提示保留用户中文约定及业务数据',async()=>{
  await input('721','/language en');const text='待双方确认\n本金：5 USDT\n订单有更新，请以当前状态为准。';
  const o=await order('721','722',text);
  assert.ok(o.card.text.includes(text));assert.ok(o.review.text.includes(text));assert.match(o.card.text,/Awaiting both parties/);
  assert.match(o.card.text,/Principal: 100 USDT/);assert.match(o.card.text,/Total deposit: 105 USDT/);assert.ok(o.card.text.includes(o.id));
  const terms=await input('721',`/terms ${o.id}`);assert.ok(terms.text.includes(text));assert.match(terms.text,/Transaction terms/);
  assert.equal(terms.buttons![0][0].text,'Back to order');
  await assert.rejects(input('721','/balance invalid'),/full order ID/);
  await assert.rejects(click('721',`execute:RELEASE:${o.id}`),/not allowed in the current state/);
  await input('723','/language en');await assert.rejects(input('723',`/terms ${o.id}`),/not allowed to view/);
  await click('721',`accept:1:${o.id}`);const card=await c.view(o.id,'721');assert.match(card.text,/Buyer accepted · Seller not accepted/);
  for(const b of card.buttons!.flat())if(b.callback_data)assert.ok(Buffer.byteLength(b.callback_data)<=64);
});

test('并发用户的语言互不串用，通知按各收件人的语言生成',async()=>{
  await input('731','/language en');await input('732','/start');
  const [en,zh]=await Promise.all([input('731','/instructions'),input('732','/instructions')]);
  assert.match(en.text,/Instructions · Simulation/);assert.match(zh.text,/使用说明/);
  assert.doesNotMatch(en.text,/[\u4e00-\u9fff]/);
  for(const section of ['/rules','/buyer','/seller','/whatisescrow','/video'])assert.doesNotMatch((await input('731',section)).text,/[\u4e00-\u9fff]/);
  await e.db.query('UPDATE outbox_jobs SET delivered_at=now()');
  const o=await order('731','732','English test contract');const notices:Record<string,View>={};
  const worker=new BotNotifications(c,async(chat,view)=>{notices[chat]=view;});await worker.flush();
  assert.match(notices['731'].text,/Order updated/);assert.match(notices['731'].text,/Escrow order/);
  assert.match(notices['732'].text,/订单有更新/);assert.match(notices['732'].text,/担保订单/);
  assert.ok(notices['731'].text.includes(o.id));assert.ok(notices['732'].text.includes(o.id));
});

test('英文管理员演练、争议、证据和裁决可操作且保留用户原文',async()=>{
  await input('9001','/language en');const first=await input('9001','/demo'),id=find(first,'type:').split(':')[2];
  assert.match(first.text,/No second account/);await click('9001',`type:P2P:${id}`);await click('9001',`role:BUYER:${id}`);
  await input('9001','100');const review=await input('9001','Demo terms');await click('9001',find(review,'create:'));
  await click('9001',`accept:1:${id}`);
  let prompt=await click('9001',`demo:ACCEPT:${id}`);assert.match(prompt.text,/Confirm single-account/);await click('9001',find(prompt,'democ:'));
  prompt=await click('9001',`demo:DEPOSIT:${id}`);await click('9001',find(prompt,'democ:'));
  const reason='买家已确认';const request=await input('9001',`/dispute ${id} ${reason}`);assert.match(request.text,/Confirm opening/);assert.ok(request.text.includes(reason));await click('9001',find(request,'dispute:'));
  const evidence='交易条款';assert.match((await input('9001',`/evidence ${id} ${evidence}`)).text,/Evidence note saved/);
  const records=await input('9001',`/evidences ${id}`);assert.ok(records.text.includes(evidence));assert.ok(records.text.includes(reason));
  assert.match((await input('9001','/admin')).text,/Simulation admin/);
  const proposal=await input('9001',`/arbitrate ${id} 55 50 保留此裁决理由`);assert.match(proposal.text,/Review simulated arbitration/);assert.ok(proposal.text.includes('保留此裁决理由'));
  await click('9001',find(proposal,'arb:'));assert.equal((await e.get(id)).state,'SETTLING');
});

test('Telegram语言切换更新个人命令菜单，错误回复也使用英文',async()=>{
  const replies:View[]=[],commands:string[]=[];
  const bot=createBot('123456:offline_test_only',c,{reply:async(_ctx,v)=>{replies.push(v);},acknowledge:async()=>{}});
  bot.botInfo={id:99,is_bot:true,first_name:'Test',username:config.username,can_join_groups:true,can_read_all_group_messages:false,supports_inline_queries:false};
  bot.telegram.setMyCommands=async(list)=>{commands.push(list[0].description);return true;};
  const chat={id:741,type:'private' as const,first_name:'Test'},from={id:741,is_bot:false,first_name:'Test'};
  await bot.handleUpdate({update_id:1001,callback_query:{id:'language',from,chat_instance:'test',data:'lang:en',message:{message_id:1,date:0,chat,text:'Language'}}});
  assert.match(replies[0].text,/Language set to English/);assert.equal(commands[0],BOT_COMMANDS_EN[0].description);
  await bot.handleUpdate({update_id:1002,message:{message_id:2,date:0,from,chat,text:'/balance invalid'}});
  assert.match(replies[1].text,/full order ID/);assert.equal(replies[1].buttons![0][0].text,'Home');
});

test('所有系统翻译键有英文文本，命令菜单包含语言入口',async()=>{
  for(const name of ['bot-controller','bot-ui','bot-help','bot-admin','bot-disputes','bot-groups']){
    const path=new URL(`../../src/${name}.ts`,import.meta.url),src=ts.createSourceFile(name,await readFile(path,'utf8'),ts.ScriptTarget.Latest,true);
    function check(node:ts.Node){
      if(ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text==='t' && ts.isStringLiteral(node.arguments[0])){
        const key=node.arguments[0].text;if(/[\u4e00-\u9fff]/.test(key))assert.ok(english[key],`Missing English system text: ${key}`);
      }ts.forEachChild(node,check);
    }check(src);
  }
  assert.equal(BOT_COMMANDS.length,BOT_COMMANDS_EN.length);
  assert.ok(BOT_COMMANDS_EN.some(c=>c.command==='language'));assert.ok(BOT_COMMANDS_EN.every(c=>typeof c.description==='string' && c.description.length>0));
});
