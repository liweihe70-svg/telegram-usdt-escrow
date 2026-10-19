import {randomUUID} from 'node:crypto';
import type {AuthDatabase} from './admin-auth.js';
import type {QueryClient} from './postgres.js';
import {walletAddress} from './bep20.js';
import {TREASURY_INDEX,GAS_STATION_INDEX,publicWallet} from './wallets.js';

// Where collected platform fees go: the owner's own wallet address when set, otherwise the treasury child.
export async function revenueAddress(db:QueryClient){return (await db.query<{address:string|null}>('SELECT address FROM production_revenue_address WHERE id=1')).rows[0]?.address??null;}
export async function setRevenueAddress(db:AuthDatabase,adminId:string,input:unknown){
  const raw=typeof input==='string'?input.trim():'';let address:string|null=null;
  if(raw){try{address=walletAddress(raw);}catch{throw Error('收益地址须为 0x 开头的 BNB Chain 地址');}}
  await db.transaction(async tx=>{
    if(!(await tx.query("SELECT id FROM production_admins WHERE id=$1 AND role='OWNER' AND disabled=false",[adminId])).rows.length)throw Error('仅负责人可修改收益地址');
    // The platform's own addresses would keep the fee inside the system; an order address would mix it with escrow.
    const root=(await tx.query<{xpub:string}>('SELECT xpub FROM production_wallet_root WHERE id=1')).rows[0];
    if(address&&root&&[TREASURY_INDEX,GAS_STATION_INDEX].some(i=>publicWallet(root.xpub).deriveChild(i).address===address))throw Error('请填写你自己的外部钱包地址，不要填平台内部地址');
    if(address&&(await tx.query('SELECT 1 FROM production_wallet_allocations WHERE lower(address)=lower($1)',[address])).rows.length)throw Error('这是某笔订单的托管地址，不能作为收益地址');
    await tx.query('UPDATE production_revenue_address SET address=$1,updated_at=now() WHERE id=1',[address]);
    await tx.query('INSERT INTO production_admin_audit(id,actor_id,action,target_id) VALUES($1,$2,$3,$4)',[randomUUID(),adminId,'REVENUE_ADDRESS_UPDATED',address??'treasury']);
  });
  return address;
}
