import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,relative,resolve,isAbsolute} from 'node:path';
import {claimService} from '../src/service-lock.js';
test('同一工作区拒绝重复打开数据库，正常释放后可重新启动',async()=>{
 const root=await mkdtemp(join(tmpdir(),'escrow-lock-'));
 try{const release=await claimService(root,'first');await assert.rejects(claimService(root,'second'),/不能重复/);await release();const again=await claimService(root,'second');await again();}
 finally{const rel=relative(resolve(tmpdir()),resolve(root));assert(!isAbsolute(rel)&&!rel.startsWith('..')&&rel.startsWith('escrow-lock-'));await rm(root,{recursive:true,force:true});}
});
