import { createCipheriv,createDecipheriv,createHash,randomBytes,randomUUID,scrypt } from 'node:crypto';
import { mkdir,readFile,writeFile,rename,readdir,lstat } from 'node:fs/promises';
import { join,resolve,relative,isAbsolute } from 'node:path';
import { PGlite } from '@electric-sql/pglite';

const FORMAT='escrow-encrypted-backup-v1',MAX_FILE=128*1024*1024;
const validId=(id:string)=>/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id);
export interface SnapshotSummary {orders:number;payouts:number;ledgerEntries:number;balanced:boolean;digest:string}
interface Payload {format:string;createdAt:string;database:string;configuration:string|null;summary:SnapshotSummary}
interface Envelope {format:string;salt:string;iv:string;tag:string;ciphertext:string}
export interface BackupInfo {id:string;createdAt:string;fileName:string;bytes:number;configurationIncluded:boolean;summary:SnapshotSummary}
function password(value:string){if(typeof value!=='string' || value.trim().length<12 || value.length>256)throw new Error('备份密码须为12至256个字符，请保管好恢复密码');}
async function key(value:string,salt:Buffer){return new Promise<Buffer>((resolve,reject)=>scrypt(value,salt,32,{N:32768,maxmem:64*1024*1024},(error,result)=>error?reject(error):resolve(result)));}
function sha(value:Buffer|string){return createHash('sha256').update(value).digest('hex');}
export async function summarize(db:PGlite):Promise<SnapshotSummary>{
  const tables=(await db.query<{table_name:string}>("SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY table_name")).rows;
  const hashes=[];
  for(const {table_name:name} of tables){
    if(!/^[a-z_][a-z0-9_]*$/.test(name))throw new Error('数据库表名不受支持');
    const rows=(await db.query<{record:string}>(`SELECT to_jsonb(t)::text AS record FROM "${name}" t`)).rows;
    hashes.push(name+':'+sha(rows.map(r=>r.record).sort().join('\n')));
  }
  const count=async(table:string)=>Number((await db.query<{n:number}>(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n);
  const balance=(await db.query<{balance:string;invalid:number}>(`SELECT coalesce(sum(amount),0)::text AS balance,
    (SELECT count(*)::int FROM (SELECT transaction_id FROM ledger_entries GROUP BY transaction_id HAVING sum(amount)<>0) q) AS invalid FROM ledger_entries`)).rows[0];
  return {orders:await count('orders'),payouts:await count('payouts'),ledgerEntries:await count('ledger_entries'),balanced:balance.balance==='0' && balance.invalid===0,digest:sha(hashes.join('\n'))};
}
export class Backups {
  private root:string;
  constructor(root:string,private db:PGlite,private settingsPath:string){this.root=resolve(root);}
  private async directory(name:'backups'|'restore-checks'){
    let cursor=this.root;
    for(const part of ['data',name]){
      cursor=join(cursor,part);await mkdir(cursor,{recursive:true});
      if((await lstat(cursor)).isSymbolicLink())throw new Error('备份目录不能是链接或重解析点');
    }
    return cursor;
  }
  private confined(path:string){const rel=relative(this.root,resolve(path));if(!rel || rel.startsWith('..') || isAbsolute(rel))throw new Error('备份路径越界');return path;}
  async list():Promise<BackupInfo[]>{
    const dir=await this.directory('backups'),result:BackupInfo[]=[];
    for(const file of await readdir(dir)){
      const match=file.match(/^backup-([a-f0-9-]+)\.json$/);if(!match || !validId(match[1]))continue;
      try{
        const path=this.confined(join(dir,file)),stat=await lstat(path);if(stat.isSymbolicLink() || stat.size>8192)continue;
        const info:BackupInfo=JSON.parse(await readFile(path,'utf8')),s=info.summary;
        if(info.id===match[1] && info.fileName===`backup-${info.id}.escrowbak` && typeof info.createdAt==='string' && Number.isSafeInteger(info.bytes) && s && [s.orders,s.payouts,s.ledgerEntries].every(n=>Number.isSafeInteger(n)&&n>=0) && typeof s.digest==='string')result.push({id:info.id,createdAt:info.createdAt,fileName:info.fileName,bytes:info.bytes,configurationIncluded:info.configurationIncluded===true,summary:{orders:s.orders,payouts:s.payouts,ledgerEntries:s.ledgerEntries,balanced:s.balanced===true,digest:s.digest}});
      }catch{}
    }
    return result.sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).slice(0,50);
  }
  async create(passphrase:string):Promise<BackupInfo>{
    password(passphrase);const dir=await this.directory('backups');
    // The caller must quiesce application writers before requesting a snapshot.
    const summary=await summarize(this.db);if(!summary.balanced)throw new Error('账本不平衡，不能创建已验证备份');
    const blob=await this.db.dumpDataDir('gzip'),database=Buffer.from(await blob.arrayBuffer());
    if(database.length>MAX_FILE/2)throw new Error('快照超过当前本地备份大小上限');
    let configuration:string|null=null;
    try{configuration=await readFile(this.settingsPath,'utf8');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    const createdAt=new Date().toISOString(),id=randomUUID(),payload:Payload={format:FORMAT,createdAt,database:database.toString('base64'),configuration,summary};
    const salt=randomBytes(16),iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',await key(passphrase,salt),iv);
    cipher.setAAD(Buffer.from(FORMAT));
    const ciphertext=Buffer.concat([cipher.update(JSON.stringify(payload),'utf8'),cipher.final()]);
    const envelope:Envelope={format:FORMAT,salt:salt.toString('base64'),iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),ciphertext:ciphertext.toString('base64')};
    const fileName=`backup-${id}.escrowbak`,file=this.confined(join(dir,fileName)),contents=JSON.stringify(envelope);
    if(Buffer.byteLength(contents)>MAX_FILE)throw new Error('备份超过当前本地大小上限');
    await writeFile(file+'.tmp',contents,{mode:0o600,flag:'wx'});await rename(file+'.tmp',file);
    const info:BackupInfo={id,createdAt,fileName,bytes:Buffer.byteLength(contents),configurationIncluded:configuration!==null,summary};
    await writeFile(this.confined(join(dir,`backup-${id}.json`)),JSON.stringify(info),{mode:0o600,flag:'wx'});
    return info;
  }
  async verify(id:string,passphrase:string){
    password(passphrase);if(!validId(id))throw new Error('无效备份编号');
    const dir=await this.directory('backups'),file=this.confined(join(dir,`backup-${id}.escrowbak`)),stat=await lstat(file);
    if(stat.isSymbolicLink() || !stat.isFile() || stat.size>MAX_FILE)throw new Error('备份文件不受支持');
    let payload:Payload;
    try{
      const e:Envelope=JSON.parse(await readFile(file,'utf8'));
      if(e.format!==FORMAT || Buffer.from(e.salt,'base64').length!==16 || Buffer.from(e.iv,'base64').length!==12 || Buffer.from(e.tag,'base64').length!==16 || typeof e.ciphertext!=='string')throw new Error('format');
      const decipher=createDecipheriv('aes-256-gcm',await key(passphrase,Buffer.from(e.salt,'base64')),Buffer.from(e.iv,'base64'));
      decipher.setAAD(Buffer.from(FORMAT));decipher.setAuthTag(Buffer.from(e.tag,'base64'));
      payload=JSON.parse(Buffer.concat([decipher.update(Buffer.from(e.ciphertext,'base64')),decipher.final()]).toString('utf8'));
      if(payload.format!==FORMAT || typeof payload.database!=='string' || (payload.configuration!==null && typeof payload.configuration!=='string') || typeof payload.summary?.digest!=='string')throw new Error('format');
    }catch{throw new Error('恢复密码不正确，或备份文件损坏');}
    const base=await this.directory('restore-checks'),target=this.confined(join(base,randomUUID()));await mkdir(target);
    const db=new PGlite(join(target,'database'),{loadDataDir:new Blob([Buffer.from(payload.database,'base64')])});
    try{
      await db.waitReady;const restored=await summarize(db);
      if(restored.digest!==payload.summary.digest || !restored.balanced)throw new Error('恢复后记录或账本校验不一致');
      if(payload.configuration!==null)await writeFile(join(target,'.env.recovered'),payload.configuration,{mode:0o600,flag:'wx'});
      const result={verified:true,backupId:id,directory:relative(this.root,target).replaceAll('\\','/'),summary:restored,configurationRecovered:payload.configuration!==null};
      await writeFile(join(target,'verification.json'),JSON.stringify(result,null,2),{mode:0o600,flag:'wx'});
      return result;
    }finally{await db.close();}
  }
}
