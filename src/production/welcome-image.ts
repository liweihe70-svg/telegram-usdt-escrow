import {randomUUID} from 'node:crypto';
import type {AuthDatabase} from './admin-auth.js';

export const WELCOME_IMAGE_MAX=5*1024*1024;
// Kept in memory so every /start does not read the database; refreshed on load, save and removal.
let current:{mime:string;bytes:Uint8Array}|null=null;
export const welcomeImage=()=>current;
// PNG or JPEG only, recognised by the file signature rather than the name or the declared type.
export function imageType(bytes:Uint8Array){
  if(bytes.length>8&&[0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a].every((b,i)=>bytes[i]===b))return 'image/png';
  if(bytes.length>3&&bytes[0]===0xff&&bytes[1]===0xd8&&bytes[2]===0xff)return 'image/jpeg';
  return null;
}
export async function loadWelcomeImage(db:AuthDatabase){
  const row=(await db.query<{mime:string;bytes:Uint8Array}>('SELECT mime,bytes FROM production_welcome_image WHERE id=1')).rows[0];
  current=row?{mime:row.mime,bytes:new Uint8Array(row.bytes)}:null;return current;
}
export async function saveWelcomeImage(db:AuthDatabase,adminId:string,bytes:Uint8Array|null){
  const mime=bytes?imageType(bytes):null;
  if(bytes&&(!mime||bytes.length>WELCOME_IMAGE_MAX))throw Error('图片须为 PNG 或 JPG，且不超过 5 MB');
  await db.transaction(async tx=>{
    if(!(await tx.query("SELECT id FROM production_admins WHERE id=$1 AND role='OWNER' AND disabled=false",[adminId])).rows.length)throw Error('仅负责人可修改欢迎图片');
    if(bytes)await tx.query('INSERT INTO production_welcome_image(id,mime,bytes) VALUES(1,$1,$2) ON CONFLICT(id) DO UPDATE SET mime=excluded.mime,bytes=excluded.bytes,updated_at=now()',[mime,bytes]);
    else await tx.query('DELETE FROM production_welcome_image WHERE id=1');
    await tx.query('INSERT INTO production_admin_audit(id,actor_id,action) VALUES($1,$2,$3)',[randomUUID(),adminId,bytes?'WELCOME_IMAGE_SAVED':'WELCOME_IMAGE_REMOVED']);
  });
  return loadWelcomeImage(db);
}
