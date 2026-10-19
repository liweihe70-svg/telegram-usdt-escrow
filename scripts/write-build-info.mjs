import { createHash } from 'node:crypto';
import { readdir,readFile,writeFile,mkdir,stat } from 'node:fs/promises';
import { join } from 'node:path';
const hash=createHash('sha256');
async function walk(dir){for(const name of (await readdir(dir)).sort()){
 const path=join(dir,name);
 if((await stat(path)).isDirectory())await walk(path);
 else{hash.update(path.replaceAll('\\','/'));hash.update(await readFile(path));}
}}
for(const dir of ['src','db','public','scripts'])await walk(dir);
const pkg=JSON.parse(await readFile('package.json','utf8'));
await mkdir('dist',{recursive:true});await writeFile('dist/build-info.json',JSON.stringify({application:'telegram-usdt-escrow',version:pkg.version,buildId:hash.digest('hex').slice(0,12),builtAt:new Date().toISOString()}));
