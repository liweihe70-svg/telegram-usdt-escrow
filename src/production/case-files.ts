import {createHash,randomUUID} from 'node:crypto';
import type {AuthDatabase} from './admin-auth.js';

export const FILE_LIMIT=5*1024*1024;
const PARTY_FILES=5,ORDER_BYTES=20*1024*1024,TOTAL_BYTES=100*1024*1024;
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export interface CaseUpload{filename:string;size?:number;uniqueId:string;load:()=>Promise<Uint8Array>}
export interface CaseFile{id:string;case_id:string;user_id:string;filename:string;mime:string;note:string;size:number;sha256:string;created_at:string}
// Accept only a small set of formats whose content matches the extension; this is not malware scanning.
export function classify(bytes:Uint8Array,name:string){
  const b=Buffer.from(bytes),ext=name.toLowerCase().split('.').pop();
  if(b.length===0||b.length>FILE_LIMIT)throw Error('附件须为1字节至5MB');
  if(ext==='png'&&b.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex')))return 'image/png';
  if(['jpg','jpeg'].includes(ext??'')&&b.subarray(0,3).equals(Buffer.from('ffd8ff','hex')))return 'image/jpeg';
  if(ext==='pdf'&&b.subarray(0,5).toString()==='%PDF-')return 'application/pdf';
  if(ext==='txt'){try{const s=new TextDecoder('utf-8',{fatal:true}).decode(b);if(!s.includes('\0'))return 'text/plain';}catch{}}
  throw Error('仅支持内容匹配的 JPG、PNG、PDF、UTF-8 TXT 文件');
}
export const cleanFilename=(name:string)=>(name.split(/[\\/]/).pop()??'').replace(/[\x00-\x1f\x7f‪-‮⁦-⁩]/g,'').slice(0,120)||'evidence';
export function parseFileCaption(caption:string|undefined){
  const m=(caption??'').trim().match(/^\/file_evidence(?:@[a-zA-Z0-9_]+)?\s+([a-f0-9-]{36})(?:\s+([\s\S]*))?$/);
  if(!m||!uuid.test(m[1])||(m[2]?.length??0)>1000)throw Error('请在附件说明填写：/file_evidence 完整订单编号 证据说明（最多1000字）');
  return {orderId:m[1],note:(m[2]??'').trim()};
}
export class ProductionCaseFiles{
  constructor(private db:AuthDatabase){}
  private async party(orderId:string,actor:string){
    if(!uuid.test(orderId))throw Error('无效订单编号');
    const o=(await this.db.query<{buyer_id:string;seller_id:string}>('SELECT buyer_id::text,seller_id::text FROM production_orders WHERE id=$1',[orderId])).rows[0];
    if(!o)throw Error('订单不存在');if(actor!==o.buyer_id&&actor!==o.seller_id)throw Error('不是订单参与者');
  }
  private async disputed(orderId:string){return (await this.db.query<{id:string}>("SELECT c.id FROM production_cases c JOIN production_orders o ON o.id=c.order_id WHERE c.order_id=$1 AND c.status='DISPUTED' AND o.state='DISPUTED'",[orderId])).rows[0];}
  // Identity and state are checked before anything is downloaded, and again under lock before storing.
  async submit(actor:string,orderId:string,note:string,upload:CaseUpload){
    await this.party(orderId,actor);if(typeof note!=='string'||note.length>1000)throw Error('证据说明最多1000字');
    if(!(await this.disputed(orderId)))throw Error('仅争议处理中的订单可提交附件');
    if(typeof upload.uniqueId!=='string'||!upload.uniqueId||upload.uniqueId.length>128)throw Error('附件标识无效');
    if(upload.size!==undefined&&(!Number.isSafeInteger(upload.size)||upload.size<1||upload.size>FILE_LIMIT))throw Error('附件须为1字节至5MB');
    const existing=(await this.db.query<{id:string}>('SELECT f.id FROM production_case_files f JOIN production_cases c ON c.id=f.case_id WHERE c.order_id=$1 AND f.user_id=$2 AND f.telegram_unique_id=$3',[orderId,actor,upload.uniqueId])).rows[0];
    if(existing)return {id:existing.id,duplicate:true};
    const filename=cleanFilename(upload.filename),bytes=await upload.load(),mime=classify(bytes,filename),id=randomUUID();
    await this.db.transaction(async tx=>{
      await tx.query('SELECT id FROM production_case_file_quota WHERE id=1 FOR UPDATE');
      const c=(await tx.query<{id:string}>("SELECT c.id FROM production_cases c JOIN production_orders o ON o.id=c.order_id WHERE c.order_id=$1 AND c.status='DISPUTED' AND o.state='DISPUTED' FOR UPDATE OF c,o",[orderId])).rows[0];
      if(!c)throw Error('订单已不在争议中');
      const q=(await tx.query<{party:number;order_size:string;total:string}>('SELECT count(*) FILTER(WHERE order_id=$1 AND user_id=$2)::int AS party,coalesce(sum(size) FILTER(WHERE order_id=$1),0)::text AS order_size,coalesce(sum(size),0)::text AS total FROM production_case_files',[orderId,actor])).rows[0];
      if(q.party>=PARTY_FILES||Number(q.order_size)+bytes.length>ORDER_BYTES||Number(q.total)+bytes.length>TOTAL_BYTES)throw Error('附件额度已满：每方每单5份、每单20MB、后台合计100MB');
      const sha=createHash('sha256').update(bytes).digest('hex');
      await tx.query('INSERT INTO production_case_files(id,case_id,order_id,user_id,filename,mime,note,bytes,size,sha256,telegram_unique_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',[id,c.id,orderId,actor,filename,mime,note,bytes,bytes.length,sha,upload.uniqueId]);
      await tx.query('INSERT INTO production_case_events(id,case_id,user_id,action,message) VALUES($1,$2,$3,$4,$5)',[randomUUID(),c.id,actor,'PARTY_FILE',`${filename} · ${bytes.length} B · SHA-256 ${sha}${note?`\n${note}`:''}`]);
      await tx.query("INSERT INTO production_notifications(id,order_id,event,order_revision) SELECT $1,id,'CASE_STATEMENT',revision FROM production_orders WHERE id=$2",[randomUUID(),orderId]);
    });
    return {id,duplicate:false};
  }
  async list(orderId:string,actor?:string){
    if(actor!==undefined)await this.party(orderId,actor);
    return (await this.db.query<CaseFile>('SELECT id,case_id,user_id::text,filename,mime,note,size,sha256,created_at::text FROM production_case_files WHERE order_id=$1 ORDER BY created_at,id',[orderId])).rows;
  }
  // actor undefined means an authenticated administrator session.
  async read(fileId:string,actor?:string){
    if(!uuid.test(fileId))throw Error('无效附件编号');
    const row=(await this.db.query<{order_id:string;filename:string;mime:string;bytes:Uint8Array}>('SELECT order_id,filename,mime,bytes FROM production_case_files WHERE id=$1',[fileId])).rows[0];
    if(!row)throw Error('附件不存在');if(actor!==undefined)await this.party(row.order_id,actor);return row;
  }
}
export async function boundedDownload(url:URL){
  if(url.origin!=='https://api.telegram.org'||!url.pathname.startsWith('/file/bot'))throw Error('附件下载失败，请重新提交');
  try{
    const response=await fetch(url,{signal:AbortSignal.timeout(30000),redirect:'error'});
    if(!response.ok||!response.body)throw Error();
    const reader=response.body.getReader(),chunks:Uint8Array[]=[];let size=0;
    try{while(true){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>FILE_LIMIT)throw Error();chunks.push(part.value);}}finally{await reader.cancel().catch(()=>{});}
    return Buffer.concat(chunks);
  }catch{throw Error('附件下载失败或超过5MB，请重新提交');}
}
