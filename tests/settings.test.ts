import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { LocalSettings } from '../src/local-settings.js';

test('配置保存保留已有 Token 和额外字段，对外不返回凭据，非法输入不写入文件',async()=>{
  const root=resolve(tmpdir()),dir=await mkdtemp(join(root,'escrow-settings-'));
  try{
    const path=join(dir,'.env'), token='123456:abcdefghijklmnopqrstuvwxyz';
    await writeFile(path,`TELEGRAM_BOT_TOKEN=${token}\nEXTRA=value\n`);
    const s=new LocalSettings(path);
    const input={brand:'测试担保',minimumFee:'5',feeBps:500,admins:['123','123']};
    const result=await s.save(input);
    assert.equal(result.tokenConfigured,true);assert.equal(JSON.stringify(result).includes(token),false);
    assert.equal((await s.load()).token,token);assert.deepEqual(result.admins,['123']);
    const saved=await readFile(path,'utf8');assert.match(saved,/EXTRA="value"/);
    await assert.rejects(s.save({...input,brand:'bad\nNEW=secret'}));
    await assert.rejects(s.save({...input,minimumFee:'-1'}));
    await assert.rejects(s.save({...input,feeBps:10001}));
    await assert.rejects(s.save({...input,admins:['9007199254740992']}));
    assert.equal(await readFile(path,'utf8'),saved);
    await s.save({...input,clearToken:true});assert.equal((await s.public()).tokenConfigured,false);
  }finally{
    const checked=resolve(dir);if(!checked.startsWith(root+sep)||!checked.split(sep).at(-1)?.startsWith('escrow-settings-'))throw new Error('Unsafe cleanup');
    await rm(checked,{recursive:true,force:true});
  }
});
