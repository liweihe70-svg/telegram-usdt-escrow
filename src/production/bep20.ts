import {getAddress,Interface,ZeroAddress} from 'ethers';
import {UINT256_MAX} from './amounts.js';

// Explicit asset identity: token names/symbols are not sufficient to accept deposits.
export const BNB_CHAIN_ID=56;
export const BNB_TESTNET_CHAIN_ID=97;
export const BNB_USDT_CONTRACT='0x55d398326f99059fF775485246999027B3197955';
const erc20=new Interface(['event Transfer(address indexed from,address indexed to,uint256 value)']);
export interface ChainPolicy {chainId:56|97;tokenContract:string;decimals:18}
export function chainPolicy(chainId:number,tokenContract:string):ChainPolicy{
  if(chainId!==56&&chainId!==97)throw Error('Only BNB Chain is supported');
  const token=walletAddress(tokenContract);
  if(chainId===56&&token.toLowerCase()!==BNB_USDT_CONTRACT.toLowerCase())throw Error('Mainnet token is not allowlisted');
  return {chainId,tokenContract:token,decimals:18};
}
export function walletAddress(value:string):string{
  if(typeof value!=='string'||!/^0x[0-9a-fA-F]{40}$/.test(value))throw Error('Invalid EVM address');
  const result=getAddress(value);
  if(result===ZeroAddress)throw Error('Zero address is not allowed');
  return result;
}
export interface ChainLog {address:string;topics:readonly string[];data:string;index:number;removed?:boolean}
export interface ChainReceipt {hash:string;status:number|null;blockNumber:number;blockHash:string;logs:readonly ChainLog[];gasUsed?:bigint}
export interface DepositProof {chainId:number;finalizedBlock:number;canonicalBlockHash:string;receipt:ChainReceipt}
const hash=(value:string)=>/^0x[0-9a-fA-F]{64}$/.test(value);
// Only the internal RPC watcher may construct this proof; HTTP callers must not supply it.
export function verifiedTransfers(policy:ChainPolicy,proof:DepositProof,expectedHash:string,to:string,side:'to'|'from'='to'){
  const destination=walletAddress(to);
  if(proof.chainId!==policy.chainId)throw Error('RPC chain mismatch');
  if(!hash(expectedHash)||!hash(proof.receipt.hash)||proof.receipt.hash.toLowerCase()!==expectedHash.toLowerCase())throw Error('Transaction hash mismatch');
  if(proof.receipt.status!==1)throw Error('Transaction is not successful');
  if(!Number.isSafeInteger(proof.finalizedBlock)||!Number.isSafeInteger(proof.receipt.blockNumber)||proof.receipt.blockNumber<0||proof.receipt.blockNumber>proof.finalizedBlock)throw Error('Transaction is not finalized');
  if(!hash(proof.receipt.blockHash)||!hash(proof.canonicalBlockHash)||proof.receipt.blockHash.toLowerCase()!==proof.canonicalBlockHash.toLowerCase())throw Error('Block is not canonical');
  const result: {txHash:string;eventIndex:number;from:string;to:string;amount:string;blockNumber:number;blockHash:string}[]=[];
  const indices=new Set<number>();
  for(const log of proof.receipt.logs){
    if(log.address.toLowerCase()!==policy.tokenContract.toLowerCase())continue;
    if(log.removed)throw Error('Removed log');
    if(!Number.isSafeInteger(log.index)||log.index<0||indices.has(log.index))throw Error('Invalid or duplicate log index');
    indices.add(log.index);
    let parsed;try{parsed=erc20.parseLog(log);}catch{continue;}
    if(!parsed||parsed.name!=='Transfer'||getAddress(parsed.args[side])!==destination)continue;
    const amount:bigint=parsed.args.value;
    if(amount<=0n||amount>UINT256_MAX)continue;
    result.push({txHash:expectedHash.toLowerCase(),eventIndex:log.index,from:getAddress(parsed.args.from),to:getAddress(parsed.args.to),amount:amount.toString(),blockNumber:proof.receipt.blockNumber,blockHash:proof.receipt.blockHash.toLowerCase()});
  }
  return result;
}
