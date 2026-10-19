import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {migrateProduction,type ProductionDatabase} from '../src/production/database.js';
import {AdminAuth} from '../src/production/admin-auth.js';
import {ProductionTelegramController} from '../src/production/telegram-controller.js';
import {loadWelcomeImage,saveWelcomeImage,imageType} from '../src/production/welcome-image.js';
import {productionApp} from '../src/production/http-app.js';

const password='test-only-welcome-image';
const png=new Uint8Array([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,0,0,0,13,1,2,3]),jpg=new Uint8Array([0xff,0xd8,0xff,0xe0,1,2,3]);
async function fixture(t:any,close=true){
  const raw=new PGlite();await raw.waitReady;const db=raw as unknown as ProductionDatabase;await migrateProduction(db);
  t.after(async()=>{await loadWelcomeImage(db).catch(()=>{});if(close)await db.close();});
  await new AdminAuth(db).bootstrap('owner',password);const admin=(await db.query<{id:string}>('SELECT id FROM production_admins')).rows[0].id;
  return {db,admin};
}
test('only PNG or JPEG signatures are accepted; the uploaded picture becomes the /start photo and can be removed',async t=>{
  const f=await fixture(t);assert.equal(imageType(png),'image/png');assert.equal(imageType(jpg),'image/jpeg');assert.equal(imageType(new TextEncoder().encode('<svg>')),null);
  await assert.rejects(saveWelcomeImage(f.db,f.admin,new TextEncoder().encode('<html>')),/PNG 或 JPG/);
  const arb=await new AdminAuth(f.db).create(f.admin,'judge',password,'ARBITRATOR');await assert.rejects(saveWelcomeImage(f.db,arb,png),/负责人/);
  await saveWelcomeImage(f.db,f.admin,png);const home=await new ProductionTelegramController(f.db,'formal_fixture_bot').home('1001');
  assert.equal(home.media?.kind,'photo');assert.deepEqual([...home.media!.bytes!],[...png]);assert.ok(home.text.length<=1024);
  await saveWelcomeImage(f.db,f.admin,null);assert.equal((await new ProductionTelegramController(f.db,'formal_fixture_bot').home('1001')).media,undefined);
});
test('upload endpoint: owner only, CSRF, raw image body, preview and removal',async t=>{
  const f=await fixture(t,false),app=productionApp(f.db,'fixture');t.after(()=>app.stop());const url=await app.start(0);
  const login=await fetch(url+'/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'owner',password})}),cookie=login.headers.get('set-cookie')!.split(';')[0],{csrf}=await login.json();
  assert.equal((await fetch(url+'/api/welcome-image',{headers:{cookie}})).status,404);
  assert.equal((await fetch(url+'/api/welcome-image',{method:'POST',headers:{cookie,'content-type':'image/png'},body:png})).status,403);
  assert.equal((await fetch(url+'/api/welcome-image',{method:'POST',headers:{cookie,'content-type':'image/gif','x-csrf-token':csrf},body:png})).status,415);
  assert.equal((await fetch(url+'/api/welcome-image',{method:'POST',headers:{cookie,'content-type':'image/png','x-csrf-token':csrf},body:new TextEncoder().encode('not an image')})).status,400);
  assert.equal((await fetch(url+'/api/welcome-image',{method:'POST',headers:{cookie,'content-type':'image/jpeg','x-csrf-token':csrf},body:jpg})).status,200);
  const preview=await fetch(url+'/api/welcome-image',{headers:{cookie}});assert.equal(preview.headers.get('content-type'),'image/jpeg');assert.deepEqual([...new Uint8Array(await preview.arrayBuffer())],[...jpg]);
  assert.equal((await fetch(url+'/api/welcome-image/remove',{method:'POST',headers:{cookie,'content-type':'application/json','x-csrf-token':csrf},body:'{}'})).status,200);
  assert.equal((await fetch(url+'/api/welcome-image',{headers:{cookie}})).status,404);
});
