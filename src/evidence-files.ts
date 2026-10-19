import { randomUUID,createHash } from 'node:crypto';
import { Escrow } from './escrow.js';
import { t } from './bot-language.js';
export const FILE_LIMIT=5*1024*1024;
export interface EvidenceUpload {filename:string;size?:number;load:()=>Promise<Uint8Array>}
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export function classify(bytes:Uint8Array,name:string){
 const b=Buffer.from(bytes),ext=name.toLowerCase().split('.').pop();
 if(b.length===0||b.length>FILE_LIMIT)throw Error(t('附件须为1字节至5MB'));
 if(ext==='png'&&b.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex')))return 'image/png';
 if(['jpg','jpeg'].includes(ext??'')&&b.subarray(0,3).equals(Buffer.from('ffd8ff','hex')))return 'image/jpeg';
 if(ext==='pdf'&&b.subarray(0,5).toString()==='%PDF-')return 'application/pdf';
 if(ext==='txt'){try{const s=new TextDecoder('utf-8',{fatal:true}).decode(b);if(!s.includes('\0'))return 'text/plain';}catch{}}
 throw Error(t('仅支持内容匹配的 JPG、PNG、PDF、UTF-8 TXT 文件'));
}
export class EvidenceFiles {
 constructor(private escrow:Escrow){}
 async authorize(orderId:string,actor:string,write=false){
  if(!uuid.test(orderId))throw Error(t('请提供完整订单编号'));
  const o=await this.escrow.get(orderId);
  if(actor!==o.buyer_id&&actor!==o.seller_id&&(!this.escrow.isAdmin(actor)||write))throw Error(t('无权查看此订单'));
  if(write&&o.state!=='DISPUTED')throw Error(t('仅争议中的订单可提交附件'));
 }
 async submit(actor:string,text:string,upload:EvidenceUpload){
  const m=text.trim().match(/^\/file_evidence(?:@[a-zA-Z0-9_]+)?\s+([^\s]+)(?:\s+([\s\S]*))?$/);
  if(!m|| (m[2]?.length??0)>1000)throw Error(t('请在附件说明填写：/file_evidence 完整订单编号 证据说明（最多1000字）'));
  const [,id,note='']=m;await this.authorize(id,actor,true);
  if(upload.size!==undefined&&(!Number.isSafeInteger(upload.size)||upload.size<1||upload.size>FILE_LIMIT))throw Error(t('附件须为1字节至5MB'));
  const filename=upload.filename.split(/[\\/]/).pop()!.replace(/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g,'').slice(0,120);
  // No download before identity/state validation. A second state check under lock protects arbitration races.
  const bytes=await upload.load(),mime=classify(bytes,filename),fileId=randomUUID();
  await this.escrow.db.transaction(async tx=>{
   await tx.query('SELECT id FROM bot_evidence_quota WHERE id=1 FOR UPDATE');
   const o=(await tx.query<{state:string}>('SELECT state FROM orders WHERE id=$1 FOR UPDATE',[id])).rows[0];
   if(o.state!=='DISPUTED')throw Error(t('订单已不在争议中'));
   const q=(await tx.query<{party:number;order_size:number;total:number}>(`SELECT count(*) FILTER(WHERE order_id=$1 AND user_id=$2)::int AS party,coalesce(sum(size) FILTER(WHERE order_id=$1),0)::int AS order_size,coalesce(sum(size),0)::int AS total FROM bot_evidence_files`,[id,actor])).rows[0];
   if(q.party>=5||q.order_size+bytes.length>20*1024*1024||q.total+bytes.length>50*1024*1024)throw Error(t('附件额度已满：每方5份、每单20MB、本地合计50MB'));
   await tx.query('INSERT INTO bot_evidence_files(id,order_id,user_id,filename,mime,note,bytes,size,sha256) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[fileId,id,actor,filename,mime,note,bytes,bytes.length,createHash('sha256').update(bytes).digest('hex')]);
  });return id;
 }
 async list(id:string){return (await this.escrow.db.query<{id:string;filename:string;mime:string;size:number;note:string;user_id:string;created_at:string}>('SELECT id,filename,mime,size,note,user_id::text,created_at::text FROM bot_evidence_files WHERE order_id=$1 ORDER BY created_at,id',[id])).rows;}
 async read(id:string,actor:string){
  if(!uuid.test(id))throw Error(t('无效附件编号'));
  const row=(await this.escrow.db.query<{order_id:string;filename:string;mime:string;bytes:Uint8Array}>('SELECT order_id,filename,mime,bytes FROM bot_evidence_files WHERE id=$1',[id])).rows[0];
  if(!row)throw Error(t('附件不存在'));await this.authorize(row.order_id,actor);return row;
 }
}
export async function boundedDownload(url:URL){
 if(url.origin!=='https://api.telegram.org'||!url.pathname.startsWith('/file/bot'))throw Error(t('附件下载失败，请重新提交'));
 try{
  const response=await fetch(url,{signal:AbortSignal.timeout(30000),redirect:'error'});
  if(!response.ok||!response.body)throw Error();
  const reader=response.body.getReader(),chunks:Uint8Array[]=[];let size=0;
  try{while(true){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>FILE_LIMIT)throw Error();chunks.push(part.value);}}finally{await reader.cancel().catch(()=>{});}
  return Buffer.concat(chunks);
 }catch{throw Error(t('附件下载失败或超过5MB，请重新提交'));}
}
