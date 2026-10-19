import {createHash,randomUUID} from 'node:crypto';
import {Transaction,keccak256} from 'ethers';
import type {AuthDatabase} from './admin-auth.js';
import type {TransactionClient} from './postgres.js';
import {chainPolicy,type ChainPolicy} from './bep20.js';
import {BnbGasRpc,transferInterface,type GasRpc} from './payout-rpc.js';
import {GAS_STATION_INDEX,publicWallet} from './wallets.js';
import type {ProductionPayouts} from './payouts.js';
import {chain,confirmWord} from './network.js';

// Native tBNB ledger accounts, in wei. They never share a journal with token accounts.
export const gasStationAccount=()=>`gas:${chain()}:station`,gasExpenseAccount=()=>`expense:gas:${chain()}`;
export const gasOrderAccount=(orderId:string)=>`gas:${chain()}:order:${orderId}`;
export interface GasPlan{version:1;kind:'GAS_TOPUP';id:string;requestId:string;orderId:string;chainId:97|56;xpub:string;childIndex:number;source:string;target:string;amount:string;nonce:number;gasLimit:'21000';gasPrice:string;data:'0x';type:0}
type Row={id:string;request_id:string;order_id:string;plan:GasPlan;plan_hash:string;status:string;signed_raw:string|null;tx_hash:string|null};
export const hashGasPlan=(p:GasPlan)=>createHash('sha256').update(JSON.stringify([p.version,p.kind,p.id,p.requestId,p.orderId,p.chainId,p.xpub,p.childIndex,p.source,p.target,p.amount,p.nonce,p.gasLimit,p.gasPrice,p.data,p.type])).digest('hex');
const OPEN="('PREPARED','SIGNED','BROADCAST')";
export class ProductionGas{
  private rpcUrl:string;private timer?:ReturnType<typeof setInterval>;private work?:Promise<void>;private error='';private stopping=false;
  constructor(private db:AuthDatabase,private payouts:ProductionPayouts,rpcUrl='',private factory:(url:string,p:ChainPolicy)=>GasRpc=(url,p)=>new BnbGasRpc(url,p),private monitoring:()=>boolean=()=>true){this.rpcUrl=rpcUrl;}
  setRpc(value:string){this.rpcUrl=value;}
  start(){this.stopping=false;this.timer=setInterval(()=>void this.tick(),10000);}
  private async root(tx:TransactionClient|AuthDatabase){return (await tx.query<{xpub:string;token_contract:string}>('SELECT xpub,token_contract FROM production_wallet_root WHERE id=1')).rows[0];}
  private async owner(tx:TransactionClient,id:string){if(!(await tx.query("SELECT id FROM production_admins WHERE id=$1 AND role='OWNER' AND disabled=false",[id])).rows.length)throw Error('仅负责人可处理出款');}
  private async audit(tx:TransactionClient,actor:string|null,action:string,target:string){await tx.query('INSERT INTO production_admin_audit(id,actor_id,action,target_id) VALUES($1,$2,$3,$4)',[randomUUID(),actor,action,target]);}
  private async open(tx:TransactionClient,requestId:string){return (await tx.query<Row>(`SELECT id,request_id,order_id,plan,plan_hash,status,signed_raw,tx_hash FROM production_gas_topups WHERE request_id=$1 AND status IN ${OPEN} FOR UPDATE`,[requestId])).rows[0];}
  async status(){
    const root=await this.root(this.db),topups=(await this.db.query(`SELECT id,request_id,order_id,target_address,amount::text,status,plan,plan_hash,tx_hash,fee::text,last_error,created_at FROM production_gas_topups ORDER BY created_at DESC LIMIT 200`)).rows;
    const ledger=(await this.db.query<{account:string;amount:string}>("SELECT account,sum(amount)::text AS amount FROM production_ledger_entries WHERE account LIKE $2 OR account=$1 GROUP BY account",[gasExpenseAccount(),`gas:${chain()}:%`])).rows;
    if(!root)return {configured:false,topups,ledger,confirmationError:this.error};
    const address=publicWallet(root.xpub).deriveChild(GAS_STATION_INDEX).address;let onChain=null,chainError='';
    if(this.rpcUrl){const rpc=this.factory(this.rpcUrl,chainPolicy(chain(),root.token_contract));try{onChain=await rpc.station(address);}catch(e){chainError=(e as Error).message;}finally{rpc.close();}}
    return {configured:true,address,childIndex:GAS_STATION_INDEX,chain:onChain,chainError,topups,ledger,confirmationError:this.error};
  }
  async prepare(requestId:string,actorId:string){
    if(!this.monitoring())throw Error('请先启动入金监听');
    return this.db.transaction(async tx=>{
      await this.owner(tx,actorId);const {o,r,policy}=await this.payouts.approved(tx,requestId);
      if((await tx.query('SELECT 1 FROM production_payout_transactions WHERE request_id=$1',[requestId])).rows.length)throw Error('出款计划已准备，无需补充手续费');
      const root=await this.root(tx),a=(await tx.query<{child_index:string;address:string}>('SELECT child_index::text,address FROM production_wallet_allocations WHERE order_id=$1',[o.id])).rows[0];
      if(!root||!a||a.address!==o.deposit_address||root.token_contract!==o.token_contract)throw Error('订单未分配可签名的平台测试地址');
      const station=publicWallet(root.xpub).deriveChild(GAS_STATION_INDEX).address,rpc=this.factory(this.rpcUrl,policy);
      try{
        const terms=await rpc.station(station),prior=await this.open(tx,requestId);
        if(prior){
          if(prior.signed_raw||prior.plan.nonce===terms.nonce)return {plan:prior.plan,planHash:prior.plan_hash,status:prior.status,txHash:prior.tx_hash};
          await tx.query("UPDATE production_gas_topups SET status='ABANDONED',last_error='手续费钱包 nonce 已变化，未签名计划作废',updated_at=now() WHERE id=$1",[prior.id]);await this.audit(tx,actorId,'GAS_TOPUP_ABANDONED',prior.id);
        }
        if((await tx.query("SELECT 1 FROM production_gas_topups WHERE status IN ('SIGNED','BROADCAST')")).rows.length)throw Error('上一笔手续费补充尚未最终确认，请先刷新回执');
        const allocation=r.allocations[0],data=transferInterface.encodeFunctionData('transfer',[allocation.recipient,BigInt(allocation.amount)]);
        const quote=await rpc.quote(a.address,policy.tokenContract,data),need=BigInt(quote.gasLimit)*BigInt(quote.gasPrice),native=BigInt(quote.native);
        if(native>=need)throw Error('独立收款地址已有足够 tBNB，可直接准备出款');
        // Twice the current estimate leaves room for a modest price rise before the payout is signed.
        const amount=need*2n-native,price=BigInt(terms.gasPrice);
        if(BigInt(terms.native)<amount+21000n*price)throw Error(`手续费钱包 tBNB 不足，请先向 ${station} 转入 BNB`);
        const id=randomUUID(),plan:GasPlan={version:1,kind:'GAS_TOPUP',id,requestId,orderId:o.id,chainId:chain(),xpub:root.xpub,childIndex:GAS_STATION_INDEX,source:station,target:a.address,amount:amount.toString(),nonce:terms.nonce,gasLimit:'21000',gasPrice:terms.gasPrice,data:'0x',type:0};
        const planHash=hashGasPlan(plan);
        await tx.query('INSERT INTO production_gas_topups(id,request_id,order_id,source_address,target_address,nonce,amount,plan,plan_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[id,requestId,o.id,station,a.address,terms.nonce,plan.amount,JSON.stringify(plan),planHash]);
        await this.audit(tx,actorId,'GAS_TOPUP_PREPARED',id);return {plan,planHash,status:'PREPARED',txHash:null};
      }finally{rpc.close();}
    });
  }
  async submit(requestId:string,actorId:string,raw:string,expectedPlanHash:string){
    if(!this.monitoring())throw Error('请先启动入金监听');
    if(typeof raw!=='string'||raw.length>4096||!/^0x([0-9a-f]{2})+$/i.test(raw))throw Error('签名交易格式无效');
    return this.db.transaction(async tx=>{
      await this.owner(tx,actorId);await this.payouts.approved(tx,requestId);const row=await this.open(tx,requestId);
      if(!row||row.plan_hash!==expectedPlanHash||hashGasPlan(row.plan)!==row.plan_hash)throw Error('手续费补充计划已变化');
      let signed;try{signed=Transaction.from(raw);}catch{throw Error('签名交易无效');}const p=row.plan;
      if(!signed.signature||signed.from!==p.source||signed.to!==p.target||signed.chainId!==BigInt(chain())||signed.type!==0||signed.nonce!==p.nonce||signed.value!==BigInt(p.amount)||signed.data!=='0x'||signed.gasLimit!==21000n||signed.gasPrice!==BigInt(p.gasPrice))throw Error('签名与手续费补充计划不一致');
      const hash=keccak256(raw);if(row.signed_raw){if(row.signed_raw!==raw||row.tx_hash!==hash)throw Error('已存在不同的签名交易');return {txHash:hash,status:row.status};}
      await tx.query("UPDATE production_gas_topups SET signed_raw=$2,tx_hash=$3,status='SIGNED',updated_at=now() WHERE id=$1",[row.id,raw,hash]);await this.audit(tx,actorId,'GAS_TOPUP_SIGNED',row.id);return {txHash:hash,status:'SIGNED'};
    });
  }
  async broadcast(requestId:string,actorId:string,confirmation:string){
    if(!this.monitoring())throw Error('请先启动入金监听');
    if(confirmation!==confirmWord())throw Error(`请准确输入 ${confirmWord()}`);
    return this.db.transaction(async tx=>{
      await this.owner(tx,actorId);const {policy}=await this.payouts.approved(tx,requestId),row=await this.open(tx,requestId);
      if(!row?.signed_raw||!row.tx_hash||hashGasPlan(row.plan)!==row.plan_hash)throw Error('没有可广播的已核验签名');
      const rpc=this.factory(this.rpcUrl,policy),p=row.plan;
      try{
        if(!await rpc.known(row.tx_hash)){
          const terms=await rpc.station(p.source);
          if(terms.nonce!==p.nonce)throw Error('手续费钱包 nonce 已变化，不能重新发送');
          if(BigInt(terms.gasPrice)>BigInt(p.gasPrice))throw Error('节点手续费已变化，请保留原交易并人工核对');
          if(BigInt(terms.native)<BigInt(p.amount)+21000n*BigInt(p.gasPrice))throw Error('手续费钱包 tBNB 不足');
          if(!this.monitoring())throw Error('入金监听已停止，广播取消');
          const returned=await rpc.send(row.signed_raw);if(returned.toLowerCase()!==row.tx_hash)throw Error('广播交易哈希不一致');
        }
        await tx.query("UPDATE production_gas_topups SET status='BROADCAST',last_error=NULL,updated_at=now() WHERE id=$1",[row.id]);await this.audit(tx,actorId,'GAS_TOPUP_BROADCAST',row.id);
      }finally{rpc.close();}
      return {txHash:row.tx_hash,status:'BROADCAST'};
    });
  }
  // Booking follows the finalized chain, independent of the payout request's later state.
  async reconcile(id:string){
    const ref=(await this.db.query<Row>('SELECT id,plan,status,tx_hash FROM production_gas_topups WHERE id=$1',[id])).rows[0];
    if(!ref?.tx_hash||!['SIGNED','BROADCAST'].includes(ref.status))return;
    const root=await this.root(this.db),rpc=this.factory(this.rpcUrl,chainPolicy(chain(),root.token_contract));let result;
    try{result=await rpc.nativeProof(ref.tx_hash);}finally{rpc.close();}if(!result)return;
    await this.db.transaction(async tx=>{
      const row=(await tx.query<Row>('SELECT id,request_id,order_id,plan,plan_hash,status,signed_raw,tx_hash FROM production_gas_topups WHERE id=$1 FOR UPDATE',[id])).rows[0];
      if(!['SIGNED','BROADCAST'].includes(row.status)||!row.tx_hash)return;
      const {proof}=result,p=row.plan,gasUsed=proof.receipt.gasUsed;
      if(proof.chainId!==chain()||!/^0x[0-9a-f]{64}$/i.test(proof.receipt.blockHash)||!/^0x[0-9a-f]{64}$/i.test(proof.canonicalBlockHash)||!Number.isSafeInteger(proof.receipt.blockNumber)||proof.receipt.blockNumber<0||!Number.isSafeInteger(proof.finalizedBlock)||proof.receipt.hash.toLowerCase()!==row.tx_hash||proof.receipt.blockNumber>proof.finalizedBlock||proof.receipt.blockHash.toLowerCase()!==proof.canonicalBlockHash.toLowerCase())throw Error('手续费补充回执尚未最终确认或发生冲突');
      if(result.from!==p.source||result.to!==p.target||result.value!==p.amount||result.gasPrice!==p.gasPrice||typeof gasUsed!=='bigint'||gasUsed<=0n||gasUsed>21000n)throw Error('手续费补充回执与计划不一致');
      const fee=gasUsed*BigInt(p.gasPrice),ok=proof.receipt.status===1,moved=ok?BigInt(p.amount):0n;
      const journal=randomUUID();await tx.query('INSERT INTO production_ledger_transactions(id,event_key) VALUES($1,$2)',[journal,`gas:${chain()}:${row.tx_hash}`]);
      const entries:Array<[string,bigint]>=[[gasStationAccount(),-(moved+fee)],[gasOrderAccount(row.order_id),moved],[gasExpenseAccount(),fee]];
      for(const [account,amount] of entries)if(amount!==0n)await tx.query('INSERT INTO production_ledger_entries(id,transaction_id,account,amount) VALUES($1,$2,$3,$4)',[randomUUID(),journal,account,amount.toString()]);
      await tx.query('UPDATE production_gas_topups SET status=$2,block_number=$3,block_hash=$4,fee=$5,last_error=NULL,updated_at=now() WHERE id=$1',[id,ok?'CONFIRMED':'REVERTED',proof.receipt.blockNumber,proof.receipt.blockHash,fee.toString()]);
      await this.audit(tx,null,ok?'GAS_TOPUP_CONFIRMED':'GAS_TOPUP_REVERTED',id);
    });
  }
  async reconcileRequest(requestId:string){for(const {id} of (await this.db.query<{id:string}>("SELECT id FROM production_gas_topups WHERE request_id=$1 AND status IN ('SIGNED','BROADCAST')",[requestId])).rows)await this.reconcile(id);}
  private async tick(){if(this.work||this.stopping||!this.rpcUrl)return;this.work=(async()=>{
    const rows=(await this.db.query<{id:string}>("SELECT id FROM production_gas_topups WHERE status IN ('SIGNED','BROADCAST') ORDER BY updated_at LIMIT 20")).rows;
    for(const {id} of rows){if(this.stopping)break;try{await this.reconcile(id);await this.db.query('UPDATE production_gas_topups SET updated_at=now() WHERE id=$1',[id]);this.error='';}catch{this.error='手续费补充回执核验暂未完成，请查询原交易';await this.db.query('UPDATE production_gas_topups SET last_error=$2,updated_at=now() WHERE id=$1',[id,this.error]);}}
  })().catch(()=>{this.error='手续费补充回执核验暂未完成，请查询原交易';}).finally(()=>{this.work=undefined;});await this.work;}
  async stop(){this.stopping=true;if(this.timer)clearInterval(this.timer);await this.work;}
}
