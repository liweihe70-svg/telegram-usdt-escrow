import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {migrateProduction,type ProductionDatabase} from '../src/production/database.js';
import {ProductionTelegramController} from '../src/production/telegram-controller.js';
import {createProductionTelegramBot,productionCommands,groupCommands} from '../src/production/telegram-bot.js';
import {ProductionGroups} from '../src/production/groups.js';

test('switching language in the bot sets that chat menu to the chosen language',async t=>{
  const raw=new PGlite();await raw.waitReady;const db=raw as unknown as ProductionDatabase;await migrateProduction(db);t.after(()=>db.close());
  const menus:{chat:number;language:string}[]=[],replies:string[]=[];
  const bot=createProductionTelegramBot('123456:synthetic_fixture_token_not_real',new ProductionTelegramController(db,'formal_fixture_bot'),undefined,{reply:async(_c,v)=>{replies.push(v.text);},acknowledge:async()=>{},menu:async(ctx,language)=>{menus.push({chat:ctx.chat!.id,language});}});
  bot.botInfo={id:99,is_bot:true,first_name:'QA',username:'formal_fixture_bot',can_join_groups:false,can_read_all_group_messages:false,supports_inline_queries:false};
  const from={id:1001,is_bot:false,first_name:'QA'},chat={id:1001,type:'private' as const,first_name:'QA'};
  await bot.handleUpdate({update_id:1,message:{message_id:1,date:1,from,chat,text:'/start'}} as never);assert.equal(menus.length,0);
  await bot.handleUpdate({update_id:2,callback_query:{id:'c',from,chat_instance:'x',message:{message_id:2,date:1,chat,text:'home'},data:'p:lang:en'}} as never);
  assert.deepEqual(menus,[{chat:1001,language:'en'}]);assert.match(replies.at(-1)!,/Welcome to/);
  await bot.handleUpdate({update_id:3,message:{message_id:3,date:1,from,chat,text:'/language zh'}} as never);assert.deepEqual(menus.at(-1),{chat:1001,language:'zh'});
  assert.deepEqual(productionCommands.en.map(c=>c.command),productionCommands.zh.map(c=>c.command));
});
test('switching the group language sets the command list of that group to the same language',async t=>{
  const raw=new PGlite();await raw.waitReady;const db=raw as unknown as ProductionDatabase;await migrateProduction(db);t.after(()=>db.close());
  const menus:{chat:number;language:string}[]=[];
  const bot=createProductionTelegramBot('123456:synthetic_fixture_token_not_real',new ProductionTelegramController(db,'formal_fixture_bot'),undefined,{reply:async()=>{},acknowledge:async()=>{},memberStatus:async()=>'administrator',groupMenu:async(ctx,language)=>{menus.push({chat:ctx.chat!.id,language});}},new ProductionGroups(db,'formal_fixture_bot'));
  bot.botInfo={id:99,is_bot:true,first_name:'QA',username:'formal_fixture_bot',can_join_groups:true,can_read_all_group_messages:false,supports_inline_queries:false};
  const chat={id:-1001234567890,type:'supergroup' as const,title:'Deal'},from={id:1001,is_bot:false,first_name:'QA'};
  await bot.handleUpdate({update_id:1,message:{message_id:1,date:1,chat,from,text:'/menu'}} as never);assert.equal(menus.length,0);
  await bot.handleUpdate({update_id:2,message:{message_id:2,date:1,chat,from,text:'/language en'}} as never);assert.deepEqual(menus,[{chat:-1001234567890,language:'en'}]);
  assert.deepEqual(groupCommands.en.map(c=>c.command),groupCommands.zh.map(c=>c.command));assert.ok(groupCommands.zh.some(c=>c.command==='menu'));
});
