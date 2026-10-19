import { EvidenceFiles } from '../src/evidence-files.js';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,relative,isAbsolute} from 'node:path';
import {Escrow,TEST_NETWORK} from '../src/escrow.js';
import {Backups,summarize} from '../src/backup.js';
test('加密备份恢复完整记录和配置，密码错误或篡改失败且不影响原数据',async()=>{
 const root=await mkdtemp(join(tmpdir(),'escrow-backup-')),e=await Escrow.open(join(root,'live'));
 try{
  const secret='fixture-secret-never-returned',configuration='BOT_BRAND="backup fixture"\nSECRET="'+secret+'"\n';
  await writeFile(join(root,'.env'),configuration);
  const o=await e.create({kind:'PRODUCT',buyerId:'1001',sellerId:'1002',principal:'100',fee:'5',buyerAddress:'sim:b',sellerAddress:'sim:s',description:'备份验证'});
  await e.accept(o.id,'1001',1);await e.accept(o.id,'1002',1);
  await e.deposit(o.id,{network:TEST_NETWORK,token:'SIM_USDT',txHash:'simtx:backup',eventIndex:0,amount:'105',confirmed:true,success:true,to:o.deposit_address});
  await e.act(o.id,'1001','DISPUTE','backup attachment');
  await new EvidenceFiles(e).submit('1001','/file_evidence '+o.id+' attachment fixture',{filename:'proof.txt',load:async()=>Buffer.from('exact backed-up evidence bytes')});
  const b=new Backups(root,e.db,join(root,'.env')),before=await summarize(e.db);
  await assert.rejects(b.create('short'),/12/);
  const info=await b.create('fixture-password-123');assert.equal(info.summary.balanced,true);
  const file=join(root,'data/backups',info.fileName),contents=await readFile(file,'utf8');
  assert.equal(contents.includes(secret),false);assert.equal(JSON.stringify(await b.list()).includes(secret),false);
  await assert.rejects(b.verify(info.id,'wrong-password-123'),/密码/);
  await assert.rejects(b.verify('../escape','fixture-password-123'),/编号/);
  const restored=await b.verify(info.id,'fixture-password-123');assert.deepEqual(restored.summary,before);
  assert.equal(await readFile(join(root,restored.directory,'.env.recovered'),'utf8'),configuration);
  const envelope=JSON.parse(contents);envelope.ciphertext=(envelope.ciphertext[0]==='A'?'B':'A')+envelope.ciphertext.slice(1);await writeFile(file,JSON.stringify(envelope));
  await assert.rejects(b.verify(info.id,'fixture-password-123'),/损坏/);
  assert.deepEqual(await summarize(e.db),before);
 }finally{await e.db.close();const rel=relative(resolve(tmpdir()),resolve(root));assert(!rel.startsWith('..')&&!isAbsolute(rel)&&rel.startsWith('escrow-backup-'));await rm(root,{recursive:true,force:true});}
});
