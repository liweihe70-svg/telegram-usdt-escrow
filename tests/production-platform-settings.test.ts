import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {migrateProduction,type ProductionDatabase} from '../src/production/database.js';
import {AdminAuth} from '../src/production/admin-auth.js';
import {ProductionOrders} from '../src/production/orders.js';
import {ProductionTelegramController} from '../src/production/telegram-controller.js';
import {loadPlatformSettings,savePlatformSettings} from '../src/production/platform-settings.js';
import {applyOverrides,brand,defaultLanguage,limits} from '../src/production/network.js';
import {guideView} from '../src/production/guide.js';
import {chainPolicy} from '../src/production/bep20.js';
import {tokenUnits} from '../src/production/amounts.js';
import {productionApp} from '../src/production/http-app.js';

const token='0x3333333333333333333333333333333333333333',password='test-only-platform-settings';
const valid={brand:'Lucky Escrow',supportUsername:'@lucky_support',defaultLanguage:'en',maxOrder:'none',maxCustody:'none',feeMin:'2',feeBps:200};
async function fixture(t:any,close=true){
  const raw=new PGlite();await raw.waitReady;const db=raw as unknown as ProductionDatabase;await migrateProduction(db);
  t.after(async()=>{applyOverrides({});if(close)await db.close();});
  await new AdminAuth(db).bootstrap('owner',password);const admin=(await db.query<{id:string}>('SELECT id FROM production_admins')).rows[0].id;
  await db.query('UPDATE production_chain_settings SET token_contract=$1 WHERE id=1',[token]);return {db,admin};
}

test('saved settings change the welcome card, the guide, new-order fees and the default language at once',async t=>{
  const f=await fixture(t);const before=await loadPlatformSettings(f.db);assert.equal(before.brand,'Escrow');assert.equal(before.feeBps,500);
  const saved=await savePlatformSettings(f.db,f.admin,valid);assert.equal(saved.supportUsername,'lucky_support');assert.equal(brand(),'Lucky Escrow');assert.equal(defaultLanguage(),'en');
  const home=await new ProductionTelegramController(f.db,'formal_fixture_bot').handle({actor:'1001',chatId:'1001',text:'/start'});
  assert.match(home.text,/Welcome to Lucky Escrow/);assert.match(home.text,/2% for amounts over \$100\n\$2 for amounts under \$100/);
  const terms=await new ProductionTelegramController(f.db,'formal_fixture_bot').handle({actor:'1001',chatId:'1001',callback:'p:t'});
  assert.match(terms.text,/- 2% fee for transactions over \$100/);assert.match(terms.text,/Need Support\? Contact @lucky_support/);
  assert.match(guideView('fees',true,'p','b').text,/2%, minimum 2 USDT/);
  const order=await new ProductionOrders(f.db,chainPolicy(97,token)).create({kind:'PRODUCT',buyerId:'1001',sellerId:'1002',buyerAddress:'0x1111111111111111111111111111111111111111',sellerAddress:'0x2222222222222222222222222222222222222222',principal:'100',description:'Fee check'},f.admin);
  assert.equal(order.fee,tokenUnits('2').toString());
  applyOverrides({});assert.equal(brand(),'Escrow');await loadPlatformSettings(f.db);assert.equal(brand(),'Lucky Escrow');
});
test('invalid settings are rejected and nothing changes',async t=>{
  const f=await fixture(t);await loadPlatformSettings(f.db);
  for(const [field,value,message] of [['brand','',/品牌名/],['supportUsername','ab',/客服用户名/],['defaultLanguage','fr',/默认语言/],['maxOrder','-3',/单笔上限/],['feeMin','x',/最低手续费/],['feeBps',20000,/手续费率/]] as const)
    await assert.rejects(savePlatformSettings(f.db,f.admin,{...valid,[field]:value}),message);
  assert.equal(brand(),'Escrow');assert.equal(limits().feeBps,500);
});
test('the settings endpoint is owner-only with CSRF and reports the effective values',async t=>{
  const f=await fixture(t,false),app=productionApp(f.db,'pglite-local');t.after(()=>app.stop());const url=await app.start(0);
  assert.equal((await fetch(url+'/api/platform-settings')).status,401);
  const login=await fetch(url+'/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'owner',password})}),cookie=login.headers.get('set-cookie')!.split(';')[0],{csrf}=await login.json();
  assert.equal((await (await fetch(url+'/api/platform-settings',{headers:{cookie}})).json()).brand,'Escrow');
  assert.equal((await fetch(url+'/api/platform-settings',{method:'POST',headers:{cookie,'content-type':'application/json'},body:JSON.stringify(valid)})).status,403);
  const saved=await (await fetch(url+'/api/platform-settings',{method:'POST',headers:{cookie,'content-type':'application/json','x-csrf-token':csrf},body:JSON.stringify(valid)})).json();
  assert.equal(saved.brand,'Lucky Escrow');assert.equal(saved.capsApply,false);
});
