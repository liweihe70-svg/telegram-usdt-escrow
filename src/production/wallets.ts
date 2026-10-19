import {createHash,randomUUID} from 'node:crypto';
import {HDNodeWallet,HDNodeVoidWallet} from 'ethers';
import type {AuthDatabase} from './admin-auth.js';
import type {ChainPolicy} from './bep20.js';
import {ProductionOrders} from './orders.js';
import {chain} from './network.js';

// The last two non-hardened children are reserved for the platform, never for an order:
// the testnet gas station and the platform fee treasury.
export const GAS_STATION_INDEX=2147483647,TREASURY_INDEX=2147483646;
// Import the external-chain public node, conventionally m/44'/60'/0'/0.
// An xpub does not encode its full path. The future signer must verify that path.
export function publicWallet(value:string){
  if(typeof value!=='string'||value.length>120||!/^xpub[1-9A-HJ-NP-Za-km-z]+$/.test(value))throw Error('仅接受外部收款分支的公开 xpub，不能填写私钥或助记词');
  let node;try{node=HDNodeWallet.fromExtendedKey(value);}catch{throw Error('公开 xpub 无效');}
  if(!(node instanceof HDNodeVoidWallet)||node.depth!==4||node.index!==0)throw Error("请使用 m/44'/60'/0'/0 层级的公开 xpub");
  return node;
}
export class ProductionWallets{
  constructor(private db:AuthDatabase){}
  async configure(xpub:string,policy:ChainPolicy,adminId:string){
    publicWallet(xpub);if(policy.chainId!==chain())throw Error('收款分支网络与本实例不一致');
    const rootId=createHash('sha256').update(xpub).digest('hex');
    await this.db.transaction(async tx=>{
      await tx.query('LOCK TABLE production_wallet_root IN EXCLUSIVE MODE');
      const setting=(await tx.query<{chain_id:number;token_contract:string}>('SELECT chain_id,token_contract FROM production_chain_settings WHERE id=1 FOR UPDATE')).rows[0];
      if(setting.chain_id!==chain()||setting.token_contract!==policy.tokenContract)throw Error('网络配置已变化，请刷新');
      const admin=(await tx.query("SELECT id FROM production_admins WHERE id=$1 AND role='OWNER' AND disabled=false",[adminId])).rows[0];if(!admin)throw Error('仅负责人可配置收款分支');
      const prior=(await tx.query<{root_id:string;token_contract:string}>('SELECT root_id,token_contract FROM production_wallet_root WHERE id=1')).rows[0];
      if(prior){if(prior.root_id!==rootId||prior.token_contract!==policy.tokenContract)throw Error('收款根和代币已锁定，不能替换或重置地址序号');return;}
      await tx.query('INSERT INTO production_wallet_root(id,root_id,xpub,chain_id,token_contract) VALUES(1,$1,$2,$4,$3)',[rootId,xpub,policy.tokenContract,chain()]);
      await tx.query('INSERT INTO production_admin_audit(id,actor_id,action,target_id) VALUES($1,$2,$3,$4)',[randomUUID(),adminId,'WALLET_ROOT_CONFIGURED',rootId]);
    });
  }
  async status(){
    const root=(await this.db.query<{root_id:string;chain_id:number;token_contract:string;next_index:string}>('SELECT root_id,chain_id,token_contract,next_index::text FROM production_wallet_root WHERE id=1')).rows[0];
    const n=(await this.db.query<{n:number}>('SELECT count(*)::int AS n FROM production_wallet_allocations')).rows[0].n;
    return {configured:Boolean(root),rootId:root?.root_id,chainId:root?.chain_id,tokenContract:root?.token_contract,nextIndex:root?.next_index,allocated:n};
  }
  async allocate(orderId:string,finalizedHead:number){
    if(!Number.isSafeInteger(finalizedHead)||finalizedHead<0)throw Error('Invalid finalized head');
    return this.db.transaction(async tx=>{
      const raw=(await tx.query<{chain_id:56|97;token_contract:string}>('SELECT chain_id,token_contract FROM production_orders WHERE id=$1',[orderId])).rows[0];if(!raw)throw Error('订单不存在');
      const orders=new ProductionOrders(this.db,{chainId:raw.chain_id,tokenContract:raw.token_contract,decimals:18});
      const order=await orders.get(orderId,tx,true);
      const prior=(await tx.query<{address:string}>('SELECT address FROM production_wallet_allocations WHERE order_id=$1',[orderId])).rows[0];
      if(prior){if(prior.address!==order.deposit_address)throw Error('订单与收款地址不一致');return prior.address;}
      if(order.state!=='AWAITING_DEPOSIT'||order.kind!=='PRODUCT'||order.deposit_address)throw Error('订单尚未确认或已有外部地址');
      const root=(await tx.query<{root_id:string;xpub:string;chain_id:number;token_contract:string;next_index:string}>('SELECT root_id,xpub,chain_id,token_contract,next_index::text FROM production_wallet_root WHERE id=1 FOR UPDATE')).rows[0];
      if(!root||root.chain_id!==chain()||order.chain_id!==chain()||root.token_contract!==order.token_contract)throw Error('订单与收款分支网络不匹配');
      const index=Number(root.next_index);if(index>=TREASURY_INDEX)throw Error('公开分支地址已用完');
      const address=publicWallet(root.xpub).deriveChild(index).address,start=Math.max(0,finalizedHead-2);
      await tx.query('INSERT INTO production_wallet_allocations(order_id,root_id,child_index,address,start_block) VALUES($1,$2,$3,$4,$5)',[orderId,root.root_id,index,address,start]);
      await tx.query('INSERT INTO production_wallet_cursors(order_id,next_block) VALUES($1,$2)',[orderId,start]);
      await tx.query('UPDATE production_wallet_root SET next_index=next_index+1 WHERE id=1');
      await tx.query('UPDATE production_orders SET deposit_address=$2,revision=revision+1 WHERE id=$1',[orderId,address]);
      await tx.query("INSERT INTO production_notifications(id,order_id,event,order_revision) SELECT $1,id,'DEPOSIT_ADDRESS_ASSIGNED',revision FROM production_orders WHERE id=$2",[randomUUID(),orderId]);
      await tx.query("INSERT INTO production_admin_audit(id,action,target_id) VALUES($1,'DEPOSIT_ADDRESS_ASSIGNED',$2)",[randomUUID(),orderId]);
      return address;
    });
  }
}
