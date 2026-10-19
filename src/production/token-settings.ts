import {readFile,writeFile,rename,lstat,unlink} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {validateProductionToken} from './telegram-runtime.js';
import {instanceFiles} from './network.js';

export async function saveProductionBotToken(root:string,token:string){
  validateProductionToken(token);await saveProductionField(root,'PRODUCTION_TELEGRAM_BOT_TOKEN',token);
}
export async function saveProductionField(root:string,key:'PRODUCTION_TELEGRAM_BOT_TOKEN'|'BNB_RPC_URL',value:string){
  if(!['PRODUCTION_TELEGRAM_BOT_TOKEN','BNB_RPC_URL'].includes(key)||/[\r\n]/.test(value))throw Error('配置字段无效');
  const file=join(resolve(root),instanceFiles().envFile);let contents='';
  try{const stat=await lstat(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>65536)throw Error('正式配置文件不受支持');contents=await readFile(file,'utf8');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  const line=`${key}=${value}`;
  const field=new RegExp(`^[ \\t]*(?:export[ \\t]+)?${key}[ \\t]*=.*$`,'gm');
  const updated=contents.match(field)?contents.replace(field,()=>line):contents+(contents&&!contents.endsWith('\n')?'\n':'')+line+'\n';
  const temporary=file+`.${randomUUID()}.tmp`;
  try{await writeFile(temporary,updated,{mode:0o600,flag:'wx'});await rename(temporary,file);}catch(error){await unlink(temporary).catch(()=>{});throw error;}
}
