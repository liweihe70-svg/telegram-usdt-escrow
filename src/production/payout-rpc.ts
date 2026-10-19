import {FetchRequest,JsonRpcProvider,Contract,Interface,keccak256} from 'ethers';
import {BnbReader} from './bnb-reader.js';
import type {ChainPolicy,DepositProof} from './bep20.js';
import {validateRpc} from './deposit-monitor.js';
import {chain} from './network.js';
export interface TxTerms{nonce:number;gasLimit:string;gasPrice:string}
export interface PayoutRpc{
  terms(source:string,token:string,data:string,requiredTokens:string):Promise<TxTerms>;
  send(raw:string):Promise<string>;known(hash:string):Promise<boolean>;proof(hash:string):Promise<DepositProof|null>;close():void;
}
export interface PendingState{minedNonce:number;gasPrice:string;native:string}
export interface ReplacementRpc extends PayoutRpc{pending(source:string):Promise<PendingState>}
export class BnbPayoutRpc implements ReplacementRpc{
  private provider:JsonRpcProvider;private reader:BnbReader;
  constructor(url:string,private policy:ChainPolicy){
    if(policy.chainId!==chain())throw Error('出款网络与本实例不一致');validateRpc(url);const req=new FetchRequest(url);req.timeout=10000;
    this.provider=new JsonRpcProvider(req,undefined,{batchMaxCount:1});this.reader=new BnbReader(url,policy);
  }
  async terms(source:string,token:string,data:string,requiredTokens:string){
    try{
      await this.reader.preflight();if(token!==this.policy.tokenContract)throw Error();
      const contract=new Contract(token,['function balanceOf(address) view returns (uint256)'],this.provider);
      const [tokens,nonce,gasPrice,native]=await Promise.all([contract.balanceOf(source),this.provider.getTransactionCount(source,'pending'),this.provider.send('eth_gasPrice',[]),this.provider.getBalance(source)]);
      if(BigInt(tokens)<BigInt(requiredTokens))throw Error('TOKEN_BALANCE');
      if(BigInt(tokens)>BigInt(requiredTokens))throw Error('TOKEN_EXCESS');
      const price=BigInt(gasPrice);if(price<=0n||price>5000000000n)throw Error('FEE_CAP');
      if(native<21000n*price)throw Error('GAS_BALANCE');
      const estimate=await this.provider.estimateGas({from:source,to:token,data,value:0n,chainId:chain()});const limit=(estimate*120n+99n)/100n;
      if(limit>200000n||limit<21000n||limit*price>10000000000000000n)throw Error('FEE_CAP');
      if(native<limit*price)throw Error('GAS_BALANCE');
      return {nonce,gasLimit:limit.toString(),gasPrice:price.toString()};
    }catch(e){const msg=(e as Error).message;throw Error(msg==='TOKEN_BALANCE'?'独立收款地址的代币余额不足':msg==='TOKEN_EXCESS'?'独立收款地址存在额外代币，请等待入金核验或人工处理':msg==='GAS_BALANCE'?'独立收款地址缺少 tBNB 手续费':msg==='FEE_CAP'?'手续费超过出款上限':'出款预检失败，请核对节点及余额');}
  }
  async send(raw:string){
    try{const network=await this.provider.getNetwork();if(network.chainId!==BigInt(chain()))throw Error();const hash=await this.provider.send('eth_sendRawTransaction',[raw]);if(hash?.toLowerCase()!==keccak256(raw))throw Error();return hash.toLowerCase();}
    catch{throw Error('广播结果尚不确定，请查询原交易，不要重新签名');}
  }
  async known(hash:string){try{return Boolean(await this.provider.getTransaction(hash));}catch{throw Error('无法查询原交易');}}
  // Mined (latest) nonce, not pending: a stuck transaction is still replaceable while this equals its nonce.
  async pending(source:string){
    try{const network=await this.provider.getNetwork();if(network.chainId!==BigInt(chain()))throw Error();const [minedNonce,gasPrice,native]=await Promise.all([this.provider.getTransactionCount(source,'latest'),this.provider.send('eth_gasPrice',[]),this.provider.getBalance(source)]);return {minedNonce,gasPrice:BigInt(gasPrice).toString(),native:native.toString()};}
    catch{throw Error('无法读取出款地址的链上状态');}
  }
  async proof(hash:string){
    try{const receipt=await this.provider.getTransactionReceipt(hash),head=await this.reader.finalizedHead();if(!receipt||receipt.blockNumber>head.number)return null;return await this.reader.depositProof(hash);}
    catch{throw Error('无法核验最终确认出款回执');}
  }
  close(){this.reader.close();this.provider.destroy();}
}
export const transferInterface=new Interface(['function transfer(address to,uint256 amount) returns (bool)']);
export interface GasQuote{gasLimit:string;gasPrice:string;native:string}
export interface StationTerms{nonce:number;gasPrice:string;native:string}
export interface NativeProof{proof:DepositProof;from:string;to:string|null;value:string;gasPrice:string}
export interface GasRpc{
  quote(source:string,token:string,data:string):Promise<GasQuote>;
  station(address:string):Promise<StationTerms>;
  send(raw:string):Promise<string>;known(hash:string):Promise<boolean>;nativeProof(hash:string):Promise<NativeProof|null>;close():void;
}
export class BnbGasRpc implements GasRpc{
  private provider:JsonRpcProvider;private reader:BnbReader;
  constructor(url:string,private policy:ChainPolicy){
    if(policy.chainId!==chain())throw Error('手续费补充网络与本实例不一致');validateRpc(url);const req=new FetchRequest(url);req.timeout=10000;
    this.provider=new JsonRpcProvider(req,undefined,{batchMaxCount:1});this.reader=new BnbReader(url,policy);
  }
  private async price(){const price=BigInt(await this.provider.send('eth_gasPrice',[]));if(price<=0n||price>5000000000n)throw Error('FEE_CAP');return price;}
  // Estimate without a gas price, so an address with no tBNB can still be quoted.
  async quote(source:string,token:string,data:string){
    try{
      await this.reader.preflight();if(token!==this.policy.tokenContract)throw Error();
      const [price,native,estimate]=await Promise.all([this.price(),this.provider.getBalance(source),this.provider.estimateGas({from:source,to:token,data,value:0n,chainId:chain()})]);
      const limit=(estimate*120n+99n)/100n;if(limit>200000n||limit<21000n||limit*price>10000000000000000n)throw Error('FEE_CAP');
      return {gasLimit:limit.toString(),gasPrice:price.toString(),native:native.toString()};
    }catch(e){throw Error((e as Error).message==='FEE_CAP'?'手续费超过出款上限':'无法估算出款手续费，请核对节点及代币余额');}
  }
  async station(address:string){
    try{const network=await this.provider.getNetwork();if(network.chainId!==BigInt(chain()))throw Error();const [nonce,price,native]=await Promise.all([this.provider.getTransactionCount(address,'pending'),this.price(),this.provider.getBalance(address)]);return {nonce,gasPrice:price.toString(),native:native.toString()};}
    catch(e){throw Error((e as Error).message==='FEE_CAP'?'手续费超过出款上限':'无法读取手续费钱包状态');}
  }
  async send(raw:string){
    try{const network=await this.provider.getNetwork();if(network.chainId!==BigInt(chain()))throw Error();const hash=await this.provider.send('eth_sendRawTransaction',[raw]);if(hash?.toLowerCase()!==keccak256(raw))throw Error();return hash.toLowerCase();}
    catch{throw Error('广播结果尚不确定，请查询原交易，不要重新签名');}
  }
  async known(hash:string){try{return Boolean(await this.provider.getTransaction(hash));}catch{throw Error('无法查询原交易');}}
  async nativeProof(hash:string){
    try{
      const [tx,receipt,head]=await Promise.all([this.provider.getTransaction(hash),this.provider.getTransactionReceipt(hash),this.reader.finalizedHead()]);
      if(!tx||!receipt||receipt.blockNumber>head.number)return null;
      return {proof:await this.reader.depositProof(hash),from:tx.from,to:tx.to,value:tx.value.toString(),gasPrice:(tx.gasPrice??0n).toString()};
    }catch{throw Error('无法核验最终确认的手续费补充回执');}
  }
  close(){this.reader.close();this.provider.destroy();}
}
