import {createHash,randomBytes,randomUUID,scrypt,timingSafeEqual} from 'node:crypto';
import type {QueryClient,TransactionClient} from './postgres.js';

export interface AuthDatabase extends QueryClient {transaction<T>(work:(client:TransactionClient)=>Promise<T>):Promise<T>}
type Role='OWNER'|'APPROVER'|'OPERATOR'|'ARBITRATOR';
interface Admin {id:string;username:string;role:Role;password_hash:string;disabled:boolean}
const digest=(value:string)=>createHash('sha256').update(value).digest('hex');
const derive=(value:string,salt:Buffer)=>new Promise<Buffer>((resolve,reject)=>scrypt(value,salt,32,{N:32768,r:8,p:1,maxmem:64*1024*1024},(error,key)=>error?reject(error):resolve(key)));
export async function passwordHash(password:string){
  if(typeof password!=='string'||password.length<12||password.length>256)throw Error('Password must contain 12 to 256 characters');
  const salt=randomBytes(16),key=await derive(password,salt);
  return `scrypt-v1:${salt.toString('hex')}:${key.toString('hex')}`;
}
export async function passwordMatches(password:string,encoded:string){
  if(typeof password!=='string'||password.length>256)return false;
  const parts=encoded.split(':');
  if(parts.length!==3||parts[0]!=='scrypt-v1'||!/^[a-f0-9]{32}$/.test(parts[1])||!/^[a-f0-9]{64}$/.test(parts[2]))return false;
  return timingSafeEqual(await derive(password,Buffer.from(parts[1],'hex')),Buffer.from(parts[2],'hex'));
}
export class AdminAuth {
  private readonly dummyHash=passwordHash(randomBytes(24).toString('hex'));
  constructor(private db:AuthDatabase){}
  async bootstrap(username:string,password:string){
    if(!/^[a-zA-Z0-9_]{3,32}$/.test(username))throw Error('Invalid administrator name');
    const encoded=await passwordHash(password);
    await this.db.transaction(async tx=>{
      // Locks the initialization race even across independent server processes.
      await tx.query('LOCK TABLE production_admins IN EXCLUSIVE MODE');
      if((await tx.query('SELECT id FROM production_admins LIMIT 1')).rows.length)throw Error('Administrator already initialized');
      const id=randomUUID();
      await tx.query('INSERT INTO production_admins(id,username,password_hash,role) VALUES($1,$2,$3,$4)',[id,username,encoded,'OWNER']);
      await tx.query('INSERT INTO production_admin_audit(id,actor_id,action) VALUES($1,$2,$3)',[randomUUID(),id,'ADMIN_INITIALIZED']);
    });
  }
  async login(username:string,password:string,remoteIdentity:string){
    if(typeof username!=='string'||username.length>32||typeof password!=='string'||password.length>256)throw Error('Login failed');
    const identity=digest(remoteIdentity);
    // Serialize attempts per network identity; no raw IP or password in the audit.
    const result=await this.db.transaction(async tx=>{
      await tx.query('INSERT INTO production_auth_throttle(identity_hash) VALUES($1) ON CONFLICT DO NOTHING',[identity]);
      const row=(await tx.query<{blocked_until:Date|null;failed_count:number;window_start:Date}>('SELECT * FROM production_auth_throttle WHERE identity_hash=$1 FOR UPDATE',[identity])).rows[0];
      if(row.blocked_until&&new Date(row.blocked_until).getTime()>Date.now())return null;
      const admin=(await tx.query<Admin>('SELECT * FROM production_admins WHERE username=$1',[username])).rows[0];
      const valid=await passwordMatches(password,admin?.password_hash??await this.dummyHash);
      if(!admin||admin.disabled||!valid){
        const count=Date.now()-new Date(row.window_start).getTime()>15*60*1000?1:row.failed_count+1;
        await tx.query("UPDATE production_auth_throttle SET failed_count=$2,window_start=CASE WHEN $2=1 THEN now() ELSE window_start END,blocked_until=CASE WHEN $2>=5 THEN now()+interval '15 minutes' ELSE NULL END WHERE identity_hash=$1",[identity,count]);
        return null;
      }
      await tx.query('DELETE FROM production_auth_throttle WHERE identity_hash=$1',[identity]);
      const token=randomBytes(32).toString('hex'),csrf=randomBytes(32).toString('hex');
      await tx.query("INSERT INTO production_sessions(token_hash,csrf_hash,admin_id,expires_at) VALUES($1,$2,$3,now()+interval '8 hours')",[digest(token),digest(csrf),admin.id]);
      await tx.query('INSERT INTO production_admin_audit(id,actor_id,action) VALUES($1,$2,$3)',[randomUUID(),admin.id,'LOGIN']);
      return {token,csrf,admin:{id:admin.id,username:admin.username,role:admin.role}};
    });
    if(!result)throw Error('Login failed or temporarily locked');
    return result;
  }
  async authenticate(token:string,csrf?:string){
    if(!/^[a-f0-9]{64}$/.test(token))throw Error('Authentication required');
    const row=(await this.db.query<{id:string;username:string;role:Role;csrf_hash:string}>(`SELECT a.id,a.username,a.role,s.csrf_hash FROM production_sessions s JOIN production_admins a ON a.id=s.admin_id WHERE s.token_hash=$1 AND s.expires_at>now() AND a.disabled=false`,[digest(token)])).rows[0];
    if(!row)throw Error('Authentication required');
    if(csrf!==undefined&&(!/^[a-f0-9]{64}$/.test(csrf)||!timingSafeEqual(Buffer.from(digest(csrf),'hex'),Buffer.from(row.csrf_hash,'hex'))))throw Error('Invalid request session');
    return {id:row.id,username:row.username,role:row.role};
  }
  async list(){return (await this.db.query<{id:string;username:string;role:Role;disabled:boolean;created_at:string}>('SELECT id,username,role,disabled,created_at FROM production_admins ORDER BY created_at')).rows;}
  private async requireOwner(tx:TransactionClient,id:string){if(!(await tx.query("SELECT id FROM production_admins WHERE id=$1 AND role='OWNER' AND disabled=false",[id])).rows.length)throw Error('仅负责人可管理账号');}
  async create(ownerId:string,username:string,password:string,role:string){
    if(!/^[a-zA-Z0-9_]{3,32}$/.test(username))throw Error('账号名须为3至32位字母、数字或下划线');
    if(role!=='APPROVER'&&role!=='ARBITRATOR')throw Error('只能创建审核员或仲裁员');
    const encoded=await passwordHash(password).catch(()=>{throw Error('密码须为12至256个字符');});
    return this.db.transaction(async tx=>{
      await this.requireOwner(tx,ownerId);if((await tx.query('SELECT 1 FROM production_admins WHERE lower(username)=lower($1)',[username])).rows.length)throw Error('账号名已存在');
      const id=randomUUID();await tx.query('INSERT INTO production_admins(id,username,password_hash,role) VALUES($1,$2,$3,$4)',[id,username,encoded,role]);
      await tx.query('INSERT INTO production_admin_audit(id,actor_id,action,target_id) VALUES($1,$2,$3,$4)',[randomUUID(),ownerId,'ADMIN_CREATED',`${username}:${role}`]);return id;
    });
  }
  // Disabling also ends that account's sessions; the owner cannot be disabled here.
  async setDisabled(ownerId:string,id:string,disabled:boolean){
    await this.db.transaction(async tx=>{
      await this.requireOwner(tx,ownerId);const target=(await tx.query<{role:string}>('SELECT role FROM production_admins WHERE id=$1',[id])).rows[0];
      if(!target)throw Error('账号不存在');if(target.role==='OWNER')throw Error('不能停用负责人账号');
      await tx.query('UPDATE production_admins SET disabled=$2 WHERE id=$1',[id,disabled]);if(disabled)await tx.query('DELETE FROM production_sessions WHERE admin_id=$1',[id]);
      await tx.query('INSERT INTO production_admin_audit(id,actor_id,action,target_id) VALUES($1,$2,$3,$4)',[randomUUID(),ownerId,disabled?'ADMIN_DISABLED':'ADMIN_ENABLED',id]);
    });
  }
  async changePassword(id:string,current:string,next:string){
    const row=(await this.db.query<{password_hash:string}>('SELECT password_hash FROM production_admins WHERE id=$1 AND disabled=false',[id])).rows[0];
    if(!row||!await passwordMatches(current,row.password_hash))throw Error('当前密码不正确');
    const encoded=await passwordHash(next).catch(()=>{throw Error('新密码须为12至256个字符');});
    await this.db.transaction(async tx=>{await tx.query('UPDATE production_admins SET password_hash=$2 WHERE id=$1',[id,encoded]);await tx.query('INSERT INTO production_admin_audit(id,actor_id,action) VALUES($1,$1,$2)',[id,'ADMIN_PASSWORD_CHANGED']);});
  }
  requireApproval(role:Role){if(role!=='OWNER'&&role!=='APPROVER')throw Error('Approval permission required');}
  async logout(token:string){if(/^[a-f0-9]{64}$/.test(token))await this.db.query('DELETE FROM production_sessions WHERE token_hash=$1',[digest(token)]);}
  async initialized(){return (await this.db.query('SELECT id FROM production_admins LIMIT 1')).rows.length>0;}
  async freshCsrf(token:string){
    await this.authenticate(token);const csrf=randomBytes(32).toString('hex');
    await this.db.query('UPDATE production_sessions SET csrf_hash=$2 WHERE token_hash=$1',[digest(token),digest(csrf)]);return csrf;
  }
}
