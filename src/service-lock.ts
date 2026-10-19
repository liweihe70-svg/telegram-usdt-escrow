import { readFile,writeFile,unlink,mkdir,lstat } from 'node:fs/promises';
import { resolve,join } from 'node:path';
export async function claimService(root:string,instanceId:string){
  const dir=resolve(root,'data');await mkdir(dir,{recursive:true});
  if((await lstat(dir)).isSymbolicLink())throw new Error('服务数据目录不能是链接');
  const file=join(dir,'panel-live.lock');
  const write=()=>writeFile(file,JSON.stringify({pid:process.pid,instanceId}),{flag:'wx',mode:0o600});
  try{await write();}catch(error){
    if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;
    if((await lstat(file)).isSymbolicLink())throw new Error('服务锁文件不受支持');
    let prior:{pid:number;instanceId:string};
    try{prior=JSON.parse(await readFile(file,'utf8'));}catch{throw new Error('服务锁需要人工核对');}
    if(!Number.isSafeInteger(prior.pid) || prior.pid<=0)throw new Error('服务锁需要人工核对');
    let alive=true;try{process.kill(prior.pid,0);}catch(e){if((e as NodeJS.ErrnoException).code==='ESRCH')alive=false;}
    if(alive)throw new Error('本项目已有服务进程，不能重复打开数据库');
    await unlink(file);await write();
  }
  return async()=>{
    const saved=JSON.parse(await readFile(file,'utf8'));
    if(saved.instanceId===instanceId && saved.pid===process.pid)await unlink(file);
  };
}
