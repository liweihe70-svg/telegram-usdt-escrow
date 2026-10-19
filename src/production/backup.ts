import {createCipheriv,createDecipheriv,createHash,randomBytes,randomUUID,scrypt} from 'node:crypto';
import {mkdir,readFile,writeFile,rename,readdir,lstat,rm} from 'node:fs/promises';
import {join,resolve,relative,isAbsolute} from 'node:path';
import {PGlite} from '@electric-sql/pglite';

// Separate format and directories from the simulation backups; the two are never interchangeable.
const FORMAT='escrow-production-backup-v1',MAX_FILE=256*1024*1024;
const validId=(id:string)=>/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id);
export interface ProductionSnapshotSummary{orders:number;payoutTransactions:number;ledgerEntries:number;caseFiles:number;balanced:boolean;digest:string}
interface Payload{format:string;createdAt:string;database:string;configuration:string|null;summary:ProductionSnapshotSummary}
interface Envelope{format:string;salt:string;iv:string;tag:string;ciphertext:string}
export interface ProductionBackupInfo{id:string;createdAt:string;fileName:string;bytes:number;configurationIncluded:boolean;summary:ProductionSnapshotSummary}
function password(value:unknown):asserts value is string{if(typeof value!=='string'||value.trim().length<12||value.length>256)throw Error('备份密码须为12至256个字符，请另行保管');}
const key=(value:string,salt:Buffer)=>new Promise<Buffer>((ok,fail)=>scrypt(value,salt,32,{N:32768,maxmem:64*1024*1024},(error,result)=>error?fail(error):ok(result)));
const sha=(value:Buffer|string)=>createHash('sha256').update(value).digest('hex');
type Queryable={query<T>(sql:string,params?:unknown[]):Promise<{rows:T[]}>};
// Row-level digest of every public table plus ledger balance per journal and overall.
export async function summarizeProduction(db:Queryable):Promise<ProductionSnapshotSummary>{
  const tables=(await db.query<{table_name:string}>("SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY table_name")).rows,hashes:string[]=[];
  for(const {table_name:name} of tables){
    if(!/^[a-z_][a-z0-9_]*$/.test(name))throw Error('数据库表名不受支持');
    const rows=(await db.query<{record:string}>(`SELECT to_jsonb(t)::text AS record FROM "${name}" t`)).rows;
    hashes.push(name+':'+sha(rows.map(r=>r.record).sort().join('\n')));
  }
  const count=async(table:string)=>(await db.query<{n:number}>(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n;
  const balance=(await db.query<{total:string;invalid:number}>('SELECT coalesce(sum(amount),0)::text AS total,(SELECT count(*)::int FROM (SELECT transaction_id FROM production_ledger_entries GROUP BY transaction_id HAVING sum(amount)<>0) q) AS invalid FROM production_ledger_entries')).rows[0];
  return {orders:await count('production_orders'),payoutTransactions:await count('production_payout_transactions'),ledgerEntries:await count('production_ledger_entries'),caseFiles:await count('production_case_files'),balanced:balance.total==='0'&&balance.invalid===0,digest:sha(hashes.join('\n'))};
}
async function inspect(database:Buffer,directory:string){
  const db=new PGlite(directory,{loadDataDir:new Blob([new Uint8Array(database)])});
  try{await db.waitReady;return await summarizeProduction(db as unknown as Queryable);}finally{await db.close();}
}
export class ProductionBackups{
  private root:string;
  constructor(root:string,private dump:()=>Promise<Blob>,private configPath:string,private prefix:'production'|'production-mainnet'='production'){this.root=resolve(root);}
  private async directory(name:'production-backups'|'production-restore-checks'){
    let cursor=this.root;
    for(const part of ['data',name.replace('production',this.prefix)]){cursor=join(cursor,part);await mkdir(cursor,{recursive:true});if((await lstat(cursor)).isSymbolicLink())throw Error('备份目录不能是链接或重解析点');}
    return cursor;
  }
  private confined(path:string){const rel=relative(this.root,resolve(path));if(!rel||rel.startsWith('..')||isAbsolute(rel))throw Error('备份路径越界');return path;}
  async list():Promise<ProductionBackupInfo[]>{
    const dir=await this.directory('production-backups'),result:ProductionBackupInfo[]=[];
    for(const file of await readdir(dir)){
      const match=file.match(/^backup-([a-f0-9-]+)\.json$/);if(!match||!validId(match[1]))continue;
      try{
        const path=this.confined(join(dir,file)),stat=await lstat(path);if(stat.isSymbolicLink()||stat.size>8192)continue;
        const info:ProductionBackupInfo=JSON.parse(await readFile(path,'utf8')),s=info.summary;
        if(info.id===match[1]&&info.fileName===`backup-${info.id}.escrowprod`&&typeof info.createdAt==='string'&&Number.isSafeInteger(info.bytes)&&s&&[s.orders,s.payoutTransactions,s.ledgerEntries,s.caseFiles].every(n=>Number.isSafeInteger(n)&&n>=0)&&typeof s.digest==='string')
          result.push({id:info.id,createdAt:info.createdAt,fileName:info.fileName,bytes:info.bytes,configurationIncluded:info.configurationIncluded===true,summary:s});
      }catch{}
    }
    return result.sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).slice(0,50);
  }
  // The summary is computed from the dumped snapshot itself, so concurrent writes cannot make it disagree,
  // and a snapshot that cannot be reopened is never written as a backup.
  async create(passphrase:unknown,repeat:unknown):Promise<ProductionBackupInfo>{
    password(passphrase);if(passphrase!==repeat)throw Error('两次输入的备份密码不一致');
    const dir=await this.directory('production-backups'),checks=await this.directory('production-restore-checks');
    const database=Buffer.from(await (await this.dump()).arrayBuffer());if(database.length>MAX_FILE/2)throw Error('快照超过当前本地备份大小上限');
    const probe=this.confined(join(checks,'create-'+randomUUID()));let summary;
    try{summary=await inspect(database,probe);}finally{await rm(probe,{recursive:true,force:true});}
    if(!summary.balanced)throw Error('账本不平衡，不能创建已验证备份');
    let configuration:string|null=null;try{configuration=await readFile(this.configPath,'utf8');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    const createdAt=new Date().toISOString(),id=randomUUID(),payload:Payload={format:FORMAT,createdAt,database:database.toString('base64'),configuration,summary};
    const salt=randomBytes(16),iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',await key(passphrase,salt),iv);cipher.setAAD(Buffer.from(FORMAT));
    const ciphertext=Buffer.concat([cipher.update(JSON.stringify(payload),'utf8'),cipher.final()]);
    const contents=JSON.stringify({format:FORMAT,salt:salt.toString('base64'),iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),ciphertext:ciphertext.toString('base64')} satisfies Envelope);
    if(Buffer.byteLength(contents)>MAX_FILE)throw Error('备份超过当前本地大小上限');
    const fileName=`backup-${id}.escrowprod`,file=this.confined(join(dir,fileName));
    await writeFile(file+'.tmp',contents,{mode:0o600,flag:'wx'});await rename(file+'.tmp',file);
    const info:ProductionBackupInfo={id,createdAt,fileName,bytes:Buffer.byteLength(contents),configurationIncluded:configuration!==null,summary};
    await writeFile(this.confined(join(dir,`backup-${id}.json`)),JSON.stringify(info),{mode:0o600,flag:'wx'});return info;
  }
  // Restores into a fresh directory only; the live database is never replaced.
  async verify(id:string,passphrase:unknown){
    password(passphrase);if(!validId(id))throw Error('无效备份编号');
    const dir=await this.directory('production-backups'),file=this.confined(join(dir,`backup-${id}.escrowprod`));let stat;
    try{stat=await lstat(file);}catch{throw Error('备份不存在');}
    if(stat.isSymbolicLink()||!stat.isFile()||stat.size>MAX_FILE)throw Error('备份文件不受支持');
    let payload:Payload;
    try{
      const e:Envelope=JSON.parse(await readFile(file,'utf8'));
      if(e.format!==FORMAT||Buffer.from(e.salt,'base64').length!==16||Buffer.from(e.iv,'base64').length!==12||Buffer.from(e.tag,'base64').length!==16||typeof e.ciphertext!=='string')throw Error();
      const decipher=createDecipheriv('aes-256-gcm',await key(passphrase,Buffer.from(e.salt,'base64')),Buffer.from(e.iv,'base64'));decipher.setAAD(Buffer.from(FORMAT));decipher.setAuthTag(Buffer.from(e.tag,'base64'));
      payload=JSON.parse(Buffer.concat([decipher.update(Buffer.from(e.ciphertext,'base64')),decipher.final()]).toString('utf8'));
      if(payload.format!==FORMAT||typeof payload.database!=='string'||(payload.configuration!==null&&typeof payload.configuration!=='string')||typeof payload.summary?.digest!=='string')throw Error();
    }catch{throw Error('备份密码不正确，或备份文件损坏');}
    const target=this.confined(join(await this.directory('production-restore-checks'),randomUUID()));await mkdir(target);
    const restored=await inspect(Buffer.from(payload.database,'base64'),join(target,'database'));
    if(restored.digest!==payload.summary.digest||!restored.balanced)throw Error('恢复后记录或账本校验不一致');
    if(payload.configuration!==null)await writeFile(join(target,'.env.production.recovered'),payload.configuration,{mode:0o600,flag:'wx'});
    const result={verified:true,backupId:id,createdAt:payload.createdAt,directory:relative(this.root,target).replaceAll('\\','/'),summary:restored,configurationRecovered:payload.configuration!==null};
    await writeFile(join(target,'verification.json'),JSON.stringify(result,null,2),{mode:0o600,flag:'wx'});return result;
  }
}
