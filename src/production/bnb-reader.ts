import {Contract,Interface,JsonRpcProvider,FetchRequest} from 'ethers';
import {chainPolicy,verifiedTransfers,type ChainPolicy,type DepositProof} from './bep20.js';

const abi=['function decimals() view returns (uint8)','event Transfer(address indexed from,address indexed to,uint256 value)'];
const tokenInterface=new Interface(abi);
export class BnbReader {
  private readonly provider:JsonRpcProvider;
  constructor(rpcUrl:string,readonly policy:ChainPolicy){
    const endpoint=new URL(rpcUrl);
    if(!['http:','https:'].includes(endpoint.protocol))throw Error('Invalid RPC protocol');
    chainPolicy(policy.chainId,policy.tokenContract);
    const request=new FetchRequest(rpcUrl);request.timeout=30000;
    this.provider=new JsonRpcProvider(request,undefined,{batchMaxCount:1});
  }
  async preflight(){
    try{
      const network=await this.provider.getNetwork();
      if(network.chainId!==BigInt(this.policy.chainId))throw Error('Chain mismatch');
      const token=new Contract(this.policy.tokenContract,abi,this.provider);
      if(await this.provider.getCode(this.policy.tokenContract)==='0x')throw Error('Token contract absent');
      if(BigInt(await token.decimals())!==18n)throw Error('Token precision mismatch');
      const block=await this.provider.getBlock('finalized');
      if(!block?.hash)throw Error('Finalized block unavailable');
      return {chainId:this.policy.chainId,tokenContract:this.policy.tokenContract,decimals:18,finalizedBlock:block.number};
    }catch{throw Error('BNB RPC preflight failed; check network, contract precision and finalized-block support locally');}
  }
  async finalizedTransfers(hash:string,to:string){
    return verifiedTransfers(this.policy,await this.depositProof(hash),hash,to);
  }
  async finalizedHead(){
    try{const network=await this.provider.getNetwork();if(network.chainId!==BigInt(this.policy.chainId))throw Error();const block=await this.provider.getBlock('finalized');if(!block?.hash)throw Error();return {number:block.number,hash:block.hash.toLowerCase()};}
    catch{throw Error('无法读取已最终确认区块，扫描已暂停');}
  }
  async blockHash(number:number){
    try{const block=await this.provider.getBlock(number);if(!block?.hash)throw Error();return block.hash.toLowerCase();}catch{throw Error('无法核对区块哈希，扫描已暂停');}
  }
  async depositProof(hash:string):Promise<DepositProof>{
    try{
      const network=await this.provider.getNetwork();
      if(network.chainId!==BigInt(this.policy.chainId))throw Error('Chain mismatch');
      const [receipt,finalized]=await Promise.all([this.provider.getTransactionReceipt(hash),this.provider.getBlock('finalized')]);
      if(!receipt||!finalized?.hash||receipt.blockNumber>finalized.number)throw Error('Receipt not finalized');
      const canonical=await this.provider.getBlock(receipt.blockNumber);
      if(!canonical?.hash)throw Error('Canonical block unavailable');
      return {chainId:Number(network.chainId),finalizedBlock:finalized.number,canonicalBlockHash:canonical.hash,receipt};
    }catch{throw Error('Unable to verify finalized BEP20 transfer; no deposit was credited');}
  }
  async transferHashes(fromBlock:number,toBlock:number,to:string,side:'to'|'from'='to'){
    if(!Number.isSafeInteger(fromBlock)||!Number.isSafeInteger(toBlock)||fromBlock<0||toBlock<fromBlock||toBlock-fromBlock>999)throw Error('Scan range must contain at most 1000 blocks');
    const topics=tokenInterface.encodeFilterTopics('Transfer',side==='to'?[null,to]:[to,null]);
    try{
      const logs=await this.provider.getLogs({address:this.policy.tokenContract,topics,fromBlock,toBlock});
      return [...new Set(logs.filter(log=>!log.removed).map(log=>log.transactionHash))];
    }catch{throw Error('BEP20 log scan failed; RPC must support eth_getLogs');}
  }
  close(){this.provider.destroy();}
}
