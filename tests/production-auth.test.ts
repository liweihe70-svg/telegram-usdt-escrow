import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {AdminAuth,passwordHash,passwordMatches,type AuthDatabase} from '../src/production/admin-auth.js';

const testPassword='local-fixture-password-only';
async function fixture(t:{after(fn:()=>Promise<void>):void}){
  const db=new PGlite();await db.waitReady;
  await db.exec(await readFile(new URL('../../db/production/001_admin.sql',import.meta.url),'utf8'));
  t.after(()=>db.close());
  return {db,auth:new AdminAuth(db as unknown as AuthDatabase)};
}
test('production password hash is salted and rejects malformed hashes',async()=>{
  const first=await passwordHash(testPassword),second=await passwordHash(testPassword);
  assert.notEqual(first,second);assert(!first.includes(testPassword));assert(await passwordMatches(testPassword,first));
  assert(!await passwordMatches('wrong',first));assert(!await passwordMatches(testPassword,'scrypt-v1:bad:bad'));
  await assert.rejects(passwordHash('short'));
});
test('production admin initialization is exclusive; sessions store hashes and enforce CSRF',async t=>{
  const {db,auth}=await fixture(t);
  await auth.bootstrap('owner',testPassword);await assert.rejects(auth.bootstrap('other',testPassword));
  const session=await auth.login('owner',testPassword,'fixture-network-a');
  assert.equal((await auth.authenticate(session.token,session.csrf)).role,'OWNER');
  await assert.rejects(auth.authenticate(session.token,'0'.repeat(64)));
  const stored=(await db.query<{token_hash:string;csrf_hash:string}>('SELECT token_hash,csrf_hash FROM production_sessions')).rows[0];
  assert.notEqual(stored.token_hash,session.token);assert.notEqual(stored.csrf_hash,session.csrf);
  assert.throws(()=>auth.requireApproval('OPERATOR'));auth.requireApproval('APPROVER');
  await auth.logout(session.token);await assert.rejects(auth.authenticate(session.token));
});
test('failed production login persists throttle and expires sessions; disabling an admin revokes access',async t=>{
  const {db,auth}=await fixture(t);await auth.bootstrap('owner',testPassword);
  for(let i=0;i<5;i++)await assert.rejects(auth.login('owner','wrong','fixture-network-b'));
  await assert.rejects(auth.login('owner',testPassword,'fixture-network-b'));
  assert.equal((await db.query<{failed_count:number}>('SELECT failed_count FROM production_auth_throttle')).rows[0].failed_count,5);
  const first=await auth.login('owner',testPassword,'fixture-network-c');
  await db.query("UPDATE production_sessions SET expires_at=now()-interval '1 second'");await assert.rejects(auth.authenticate(first.token));
  const second=await auth.login('owner',testPassword,'fixture-network-c');
  await db.query('UPDATE production_admins SET disabled=true');await assert.rejects(auth.authenticate(second.token));
  await assert.rejects(auth.login('owner',testPassword,'fixture-network-d'));
  await assert.rejects(db.query('DELETE FROM production_admin_audit'));
});
