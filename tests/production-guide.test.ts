import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {migrateProduction,type ProductionDatabase} from '../src/production/database.js';
import {guideView,GUIDE_PAGES} from '../src/production/guide.js';
import {ProductionTelegramController} from '../src/production/telegram-controller.js';
import {ProductionGroups} from '../src/production/groups.js';
import {productionCommands,groupCommands} from '../src/production/telegram-bot.js';
import {productionApp} from '../src/production/http-app.js';

test('every guide page fits one Telegram message and links to all other pages',()=>{
  for(const en of [false,true])for(const scope of ['p','g'] as const)for(const page of GUIDE_PAGES){
    const v=guideView(page,en,scope,'formal_fixture_bot');assert.ok(v.text.length<4000,`${page} ${en} too long: ${v.text.length}`);
    const links=v.buttons.flat().map(b=>b.callback_data).filter(Boolean);
    assert.deepEqual(links.sort(),GUIDE_PAGES.filter(x=>x!==page).map(x=>`${scope}:h:${x}`).sort());
    assert.ok(v.text.includes('@formal_fixture_bot')||!['home','safety'].includes(page));
  }
  assert.equal(guideView('nonsense',false,'p','b').text,guideView('home',false,'p','b').text);
});
test('the fee example uses the real pricing of this instance',()=>{
  // Testnet defaults: 5% with a 5 USDT minimum, so 100 USDT received pays the seller 95.
  assert.match(guideView('fees',false,'p','b').text,/卖家收到 95 USDT/);assert.match(guideView('fees',true,'p','b').text,/the seller gets 95 USDT/);
  assert.match(guideView('buyer',false,'p','b').text,/BEP20/);
});
test('the guide opens from /guide, the home button and group commands, and is in both menus',async t=>{
  const raw=new PGlite();await raw.waitReady;const db=raw as unknown as ProductionDatabase;await migrateProduction(db);t.after(()=>db.close());
  const bot=new ProductionTelegramController(db,'formal_fixture_bot');
  const home=await bot.handle({actor:'1001',chatId:'1001',text:'/start'});assert.ok(home.buttons!.flat().some(b=>b.callback_data==='p:i'));
  assert.match((await bot.handle({actor:'1001',chatId:'1001',text:'/guide'})).text,/交易说明/);
  assert.match((await bot.handle({actor:'1001',chatId:'1001',callback:'p:h:safety'})).text,/防骗/);
  assert.match((await bot.handle({actor:'1001',chatId:'1001',text:'/start guide'})).text,/6 步/);
  const groups=new ProductionGroups(db,'formal_fixture_bot'),ask=(input:{text?:string;callback?:string})=>groups.handle({chatId:'-1001234567890',actor:'1003',status:async()=>'member',botStatus:async()=>'administrator',...input});
  assert.match((await ask({text:'/guide'}))!.text,/交易说明/);assert.match((await ask({callback:'g:h:seller'}))!.text,/卖家必读/);
  assert.ok((await ask({text:'/menu'}))!.buttons!.flat().some(b=>b.callback_data==='g:i'));
  for(const list of [productionCommands.zh,productionCommands.en,groupCommands.zh,groupCommands.en])assert.ok(list.some(c=>c.command==='guide'));
});
test('the panel serves the administrator guide with all sections in both languages and links it in the menu',async t=>{
  const raw=new PGlite();await raw.waitReady;const db=raw as unknown as ProductionDatabase;await migrateProduction(db);
  const app=productionApp(db,'pglite-local');t.after(()=>app.stop());const url=await app.start(0);
  const res=await fetch(url+'/admin-guide.js');assert.equal(res.status,200);assert.match(res.headers.get('content-type')!,/javascript/);
  const body=await res.text(),[zh,en]=body.split('const en=');
  for(const part of [zh,en])for(let n=1;n<=13;n++)assert.ok(part.includes(`id="g${n}"`),`section ${n} missing`);
  for(const word of ['APPROVE','RESOLVE','CONTINUE','REFUND','CLOSE','RESUME','MAINNET'])assert.ok(zh.includes(word),word);
  assert.match(await (await fetch(url+'/')).text(),/data-page="guide"/);assert.match(await (await fetch(url+'/app.js')).text(),/admin-guide\.js/);
});
