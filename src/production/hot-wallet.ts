import {HDNodeWallet,Wallet} from 'ethers';
import {chain} from './network.js';

const ROOT_PATH="m/44'/60'/0'/0";
// Holds the platform wallet root in process memory only, after the owner unlocks it with the encrypted
// backup and its password. Nothing here is written to disk, the database or logs; a restart locks it again.
export class HotWallet{
  private root:HDNodeWallet|null=null;private unlockedAt:Date|null=null;
  isUnlocked(){return this.root!==null;}
  status(){return {unlocked:this.root!==null,unlockedAt:this.unlockedAt?.toISOString()??null};}
  async unlock(backup:unknown,password:unknown,expectedXpub:string){
    if(typeof backup!=='string'||backup.length>32768||typeof password!=='string'||!password||password.length>256)throw Error('请提供平台钱包加密备份和密码');
    let meta:{version?:number;chainId?:number;rootPath?:string;xpub?:string}|undefined;
    try{meta=JSON.parse(backup)?.escrowTestWallet;}catch{throw Error('不是有效的平台钱包备份文件');}
    if(!meta||meta.version!==1||meta.chainId!==chain()||meta.rootPath!==ROOT_PATH||meta.xpub!==expectedXpub)throw Error('这份备份不属于本实例已配置的平台钱包或网络');
    let wallet;try{wallet=await Wallet.fromEncryptedJson(backup,password);}catch{throw Error('备份密码不正确，或备份文件已损坏');}
    if(!(wallet instanceof HDNodeWallet)||wallet.path!==ROOT_PATH||wallet.neuter().extendedKey!==expectedXpub)throw Error('解密出的钱包与已配置的公开分支不一致');
    this.root=wallet;this.unlockedAt=new Date();
  }
  lock(){this.root=null;this.unlockedAt=null;}
  // A child signer, checked against the address the plan says it signs for.
  signer(childIndex:number,expectedAddress:string){
    if(!this.root)throw Error('自动出款钱包未解锁');
    const child=this.root.deriveChild(childIndex);if(child.address!==expectedAddress)throw Error('签名地址与计划不一致');return child;
  }
}
