export const RECORD_KEY='escrow-test-token-deployment-v1';
export const PLATFORM_KEY='escrow-testnet-platform-wallet-v1';
export const ROOT_PATH="m/44'/60'/0'/0";
// Wallets, plans and signatures are bound to one network; a testnet backup or plan never signs on mainnet.
export let SIGNING_CHAIN=97;
export function setSigningChain(id){if(id!==97&&id!==56)throw Error('NETWORK_INVALID');SIGNING_CHAIN=id;}
export async function createPlatformWallet(password,repeat,ethers,progress){
  if(typeof password!=='string'||password.trim().length<12||password.length>128||password!==repeat)throw Error('WALLET_PASSWORD');
  const root=ethers.HDNodeWallet.createRandom(undefined,ROOT_PATH),xpub=root.neuter().extendedKey;
  const encrypted=JSON.parse(await root.encrypt(password,progress)),rootId=ethers.sha256(ethers.toUtf8Bytes(xpub)).slice(2);
  encrypted.escrowTestWallet={version:1,chainId:SIGNING_CHAIN,rootPath:ROOT_PATH,xpub,rootId};
  return {xpub,rootId,firstAddress:root.neuter().deriveChild(0).address,encryptedJson:JSON.stringify(encrypted,null,2)};
}
export function platformPublic(json,ethers){
  if(typeof json!=='string'||json.length>32768)throw Error('WALLET_BACKUP_INVALID');
  let data;try{data=JSON.parse(json);}catch{throw Error('WALLET_BACKUP_INVALID');}
  const meta=data.escrowTestWallet;
  const crypto=data.Crypto??data.crypto,kdf=crypto?.kdfparams;
  if(crypto?.cipher!=='aes-128-ctr'||crypto?.kdf!=='scrypt'||kdf?.n!==131072||kdf?.r!==8||kdf?.p!==1||kdf?.dklen!==32||!data['x-ethers'])throw Error('WALLET_BACKUP_INVALID');
  if(data.version!==3||!meta||meta.version!==1||meta.chainId!==SIGNING_CHAIN||meta.rootPath!==ROOT_PATH||typeof meta.xpub!=='string'||!meta.xpub.startsWith('xpub'))throw Error('WALLET_BACKUP_INVALID');
  let root;try{root=ethers.HDNodeWallet.fromExtendedKey(meta.xpub);}catch{throw Error('WALLET_BACKUP_INVALID');}
  if(!(root instanceof ethers.HDNodeVoidWallet)||root.depth!==4||root.index!==0||meta.rootId!==ethers.sha256(ethers.toUtf8Bytes(meta.xpub)).slice(2))throw Error('WALLET_BACKUP_INVALID');
  return {xpub:meta.xpub,rootId:meta.rootId,firstAddress:root.deriveChild(0).address};
}
export async function verifyPlatformWallet(json,password,ethers,progress){
  const info=platformPublic(json,ethers);
  let restored;try{restored=await ethers.Wallet.fromEncryptedJson(json,password,progress);}catch{throw Error('WALLET_RESTORE_FAILED');}
  if(!(restored instanceof ethers.HDNodeWallet)||restored.path!==ROOT_PATH||restored.depth!==4||restored.index!==0||restored.neuter().extendedKey!==info.xpub)throw Error('WALLET_RESTORE_FAILED');
  return info;
}
export function validatePayoutPlan(plan,planHash,ethers){
  const p=plan,uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
  if(!p||p.version!==1||p.chainId!==SIGNING_CHAIN||p.type!==0||p.value!=='0'||!uuid.test(p.requestId)||!uuid.test(p.orderId)||!Number.isSafeInteger(p.orderRevision)||!/^([0-9a-f]{64})$/.test(p.snapshotHash))throw Error('PAYOUT_PLAN_INVALID');
  if(!Number.isSafeInteger(p.nonce)||p.nonce<0||!Number.isSafeInteger(p.childIndex)||p.childIndex<0||p.childIndex>=2147483648||![p.amount,p.retainedFee,p.gasLimit,p.gasPrice].every(v=>typeof v==='string'&&/^\d{1,78}$/.test(v)))throw Error('PAYOUT_PLAN_INVALID');
  const gas=BigInt(p.gasLimit),price=BigInt(p.gasPrice);if(gas<21000n||gas>200000n||price<1n||price>5000000000n||gas*price>10000000000000000n||BigInt(p.amount)<=0n||BigInt(p.amount)>ethers.MaxUint256)throw Error('PAYOUT_PLAN_INVALID');
  for(const a of [p.source,p.recipient,p.tokenContract])if(ethers.getAddress(a)!==a||a===ethers.ZeroAddress)throw Error('PAYOUT_PLAN_INVALID');
  if(typeof p.xpub!=='string'||!p.xpub.startsWith('xpub'))throw Error('PAYOUT_PLAN_INVALID');
  const publicRoot=ethers.HDNodeWallet.fromExtendedKey(p.xpub);
  if(!(publicRoot instanceof ethers.HDNodeVoidWallet)||publicRoot.depth!==4||publicRoot.index!==0||publicRoot.deriveChild(p.childIndex).address!==p.source)throw Error('PAYOUT_PLAN_INVALID');
  const iface=new ethers.Interface(['function transfer(address to,uint256 amount) returns (bool)']);
  if(iface.encodeFunctionData('transfer',[p.recipient,BigInt(p.amount)])!==p.data)throw Error('PAYOUT_PLAN_INVALID');
  const hash=ethers.sha256(ethers.toUtf8Bytes(JSON.stringify([p.version,p.requestId,p.orderId,p.orderRevision,p.snapshotHash,p.chainId,p.tokenContract,p.xpub,p.childIndex,p.source,p.recipient,p.amount,p.retainedFee,p.nonce,p.gasLimit,p.gasPrice,p.data,p.value,p.type]))).slice(2);
  if(hash!==planHash)throw Error('PAYOUT_PLAN_INVALID');return p;
}
export async function signPayoutLocally(plan,planHash,backup,password,ethers,progress){
  const p=validatePayoutPlan(plan,planHash,ethers),info=platformPublic(backup,ethers);
  if(info.xpub!==p.xpub)throw Error('WALLET_ROOT_MISMATCH');
  let root;try{root=await ethers.Wallet.fromEncryptedJson(backup,password,progress);}catch{throw Error('WALLET_RESTORE_FAILED');}
  if(!(root instanceof ethers.HDNodeWallet)||root.path!==ROOT_PATH||root.neuter().extendedKey!==p.xpub)throw Error('WALLET_RESTORE_FAILED');
  const child=root.deriveChild(p.childIndex);if(child.address!==p.source)throw Error('WALLET_ROOT_MISMATCH');
  const raw=await child.signTransaction({type:0,chainId:SIGNING_CHAIN,nonce:p.nonce,to:p.tokenContract,value:0n,data:p.data,gasLimit:BigInt(p.gasLimit),gasPrice:BigInt(p.gasPrice)});
  return {raw,txHash:ethers.keccak256(raw)};
}
export const GAS_STATION_INDEX=2147483647;
export function validateGasPlan(plan,planHash,ethers){
  const p=plan,uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  if(!p||p.version!==1||p.kind!=='GAS_TOPUP'||p.chainId!==SIGNING_CHAIN||p.type!==0||p.data!=='0x'||p.gasLimit!=='21000'||p.childIndex!==GAS_STATION_INDEX||![p.id,p.requestId,p.orderId].every(v=>uuid.test(v)))throw Error('GAS_PLAN_INVALID');
  if(!Number.isSafeInteger(p.nonce)||p.nonce<0||![p.amount,p.gasPrice].every(v=>typeof v==='string'&&/^\d{1,78}$/.test(v)))throw Error('GAS_PLAN_INVALID');
  const price=BigInt(p.gasPrice),amount=BigInt(p.amount);if(price<1n||price>5000000000n||amount<=0n||amount>20000000000000000n)throw Error('GAS_PLAN_INVALID');
  for(const a of [p.source,p.target])if(ethers.getAddress(a)!==a||a===ethers.ZeroAddress)throw Error('GAS_PLAN_INVALID');
  if(typeof p.xpub!=='string'||!p.xpub.startsWith('xpub'))throw Error('GAS_PLAN_INVALID');
  let publicRoot;try{publicRoot=ethers.HDNodeWallet.fromExtendedKey(p.xpub);}catch{throw Error('GAS_PLAN_INVALID');}
  if(!(publicRoot instanceof ethers.HDNodeVoidWallet)||publicRoot.depth!==4||publicRoot.index!==0||publicRoot.deriveChild(GAS_STATION_INDEX).address!==p.source||p.target===p.source)throw Error('GAS_PLAN_INVALID');
  const hash=ethers.sha256(ethers.toUtf8Bytes(JSON.stringify([p.version,p.kind,p.id,p.requestId,p.orderId,p.chainId,p.xpub,p.childIndex,p.source,p.target,p.amount,p.nonce,p.gasLimit,p.gasPrice,p.data,p.type]))).slice(2);
  if(hash!==planHash)throw Error('GAS_PLAN_INVALID');return p;
}
export async function signGasLocally(plan,planHash,backup,password,ethers,progress){
  const p=validateGasPlan(plan,planHash,ethers),info=platformPublic(backup,ethers);
  if(info.xpub!==p.xpub)throw Error('WALLET_ROOT_MISMATCH');
  let root;try{root=await ethers.Wallet.fromEncryptedJson(backup,password,progress);}catch{throw Error('WALLET_RESTORE_FAILED');}
  if(!(root instanceof ethers.HDNodeWallet)||root.path!==ROOT_PATH||root.neuter().extendedKey!==p.xpub)throw Error('WALLET_RESTORE_FAILED');
  const station=root.deriveChild(GAS_STATION_INDEX);if(station.address!==p.source)throw Error('WALLET_ROOT_MISMATCH');
  const raw=await station.signTransaction({type:0,chainId:SIGNING_CHAIN,nonce:p.nonce,to:p.target,value:BigInt(p.amount),data:'0x',gasLimit:21000n,gasPrice:BigInt(p.gasPrice)});
  return {raw,txHash:ethers.keccak256(raw)};
}
export const TREASURY_INDEX=2147483646;
export function validateSweepPlan(plan,planHash,ethers){
  const p=plan,uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  if(!p||p.version!==1||p.kind!=='FEE_SWEEP'||p.chainId!==SIGNING_CHAIN||p.type!==0||p.value!=='0'||p.treasuryIndex!==TREASURY_INDEX||!uuid.test(p.id)||!uuid.test(p.orderId))throw Error('SWEEP_PLAN_INVALID');
  if(!Number.isSafeInteger(p.nonce)||p.nonce<0||!Number.isSafeInteger(p.childIndex)||p.childIndex<0||p.childIndex>=TREASURY_INDEX||![p.amount,p.gasLimit,p.gasPrice].every(v=>typeof v==='string'&&/^\d{1,78}$/.test(v)))throw Error('SWEEP_PLAN_INVALID');
  const gas=BigInt(p.gasLimit),price=BigInt(p.gasPrice);if(gas<21000n||gas>200000n||price<1n||price>5000000000n||gas*price>10000000000000000n||BigInt(p.amount)<=0n||BigInt(p.amount)>ethers.MaxUint256)throw Error('SWEEP_PLAN_INVALID');
  for(const a of [p.source,p.target,p.tokenContract])if(ethers.getAddress(a)!==a||a===ethers.ZeroAddress)throw Error('SWEEP_PLAN_INVALID');
  if(typeof p.xpub!=='string'||!p.xpub.startsWith('xpub'))throw Error('SWEEP_PLAN_INVALID');
  let publicRoot;try{publicRoot=ethers.HDNodeWallet.fromExtendedKey(p.xpub);}catch{throw Error('SWEEP_PLAN_INVALID');}
  // The recipient must be the platform's own treasury child, so a tampered plan cannot redirect fees.
  if(!(publicRoot instanceof ethers.HDNodeVoidWallet)||publicRoot.depth!==4||publicRoot.index!==0||publicRoot.deriveChild(p.childIndex).address!==p.source||publicRoot.deriveChild(TREASURY_INDEX).address!==p.target)throw Error('SWEEP_PLAN_INVALID');
  const iface=new ethers.Interface(['function transfer(address to,uint256 amount) returns (bool)']);
  if(iface.encodeFunctionData('transfer',[p.target,BigInt(p.amount)])!==p.data)throw Error('SWEEP_PLAN_INVALID');
  const hash=ethers.sha256(ethers.toUtf8Bytes(JSON.stringify([p.version,p.kind,p.id,p.orderId,p.chainId,p.tokenContract,p.xpub,p.childIndex,p.treasuryIndex,p.source,p.target,p.amount,p.nonce,p.gasLimit,p.gasPrice,p.data,p.value,p.type]))).slice(2);
  if(hash!==planHash)throw Error('SWEEP_PLAN_INVALID');return p;
}
export async function signSweepLocally(plan,planHash,backup,password,ethers,progress){
  const p=validateSweepPlan(plan,planHash,ethers),info=platformPublic(backup,ethers);
  if(info.xpub!==p.xpub)throw Error('WALLET_ROOT_MISMATCH');
  let root;try{root=await ethers.Wallet.fromEncryptedJson(backup,password,progress);}catch{throw Error('WALLET_RESTORE_FAILED');}
  if(!(root instanceof ethers.HDNodeWallet)||root.path!==ROOT_PATH||root.neuter().extendedKey!==p.xpub)throw Error('WALLET_RESTORE_FAILED');
  const child=root.deriveChild(p.childIndex);if(child.address!==p.source)throw Error('WALLET_ROOT_MISMATCH');
  const raw=await child.signTransaction({type:0,chainId:SIGNING_CHAIN,nonce:p.nonce,to:p.tokenContract,value:0n,data:p.data,gasLimit:BigInt(p.gasLimit),gasPrice:BigInt(p.gasPrice)});
  return {raw,txHash:ethers.keccak256(raw)};
}
const HASH=/^0x[0-9a-fA-F]{64}$/;
export async function identity(wallet){
  const chain=BigInt(await wallet.request({method:'eth_chainId'}));
  if(chain!==97n)throw Error('CHAIN_97_REQUIRED');
  const accounts=await wallet.request({method:'eth_accounts'});
  if(!Array.isArray(accounts)||!/^0x[0-9a-fA-F]{40}$/.test(accounts[0]??''))throw Error('CONNECT_WALLET');
  return {chainId:97,account:accounts[0]};
}
export function readRecord(storage){const value=storage.getItem(RECORD_KEY);if(!value)return null;try{const r=JSON.parse(value);if(r.chainId!==97||typeof r.account!=='string'||!['submitting','pending','verified','failed','rejected'].includes(r.phase)||!HASH.test(r.bytecodeHash)||r.hash&&!HASH.test(r.hash))throw Error();return r;}catch{throw Error('SAVED_RECORD_INVALID');}}
export async function sendDeployment({wallet,manifest,estimate,confirmation,storage}){
  if(confirmation!=='TESTNET')throw Error('TYPE_TESTNET');
  if(manifest.chainId!==97||!HASH.test(manifest.bytecodeHash))throw Error('INVALID_ARTIFACT');
  const prior=readRecord(storage);if(prior&&!['rejected','failed'].includes(prior.phase))throw Error('EXISTING_DEPLOYMENT');
  const current=await identity(wallet);
  const fresh=readRecord(storage);if(fresh&&!['rejected','failed'].includes(fresh.phase))throw Error('EXISTING_DEPLOYMENT');
  if(!estimate||estimate.account.toLowerCase()!==current.account.toLowerCase()||estimate.bytecodeHash!==manifest.bytecodeHash||Date.now()-estimate.at>120000||Date.now()<estimate.at||!/^0x[0-9a-f]+$/i.test(estimate.gas))throw Error('ESTIMATE_AGAIN');
  const record={...current,phase:'submitting',bytecodeHash:manifest.bytecodeHash,createdAt:new Date().toISOString()};
  // Save BEFORE sending. Unknown outcome remains blocked; never blindly resubmit.
  storage.setItem(RECORD_KEY,JSON.stringify(record));
  try{
    const hash=await wallet.request({method:'eth_sendTransaction',params:[{from:current.account,chainId:'0x61',data:manifest.bytecode,value:'0x0',gas:estimate.gas}]});
    if(!HASH.test(hash))throw Error('UNKNOWN_SUBMISSION');
    record.phase='pending';record.hash=hash;storage.setItem(RECORD_KEY,JSON.stringify(record));return record;
  }catch(e){if(e.code===4001){record.phase='rejected';storage.setItem(RECORD_KEY,JSON.stringify(record));}throw e;}
}
export async function verifyDeployment({provider,manifest,hash,expectedAccount,ethers}){
  if(!HASH.test(hash))throw Error('INVALID_HASH');
  if((await provider.getNetwork()).chainId!==97n)throw Error('CHAIN_97_REQUIRED');
  const receipt=await provider.getTransactionReceipt(hash);if(!receipt)return null;
  const tx=await provider.getTransaction(hash);if(!tx)throw Error('TX_UNAVAILABLE');
  if(tx.chainId!==97n||tx.to!==null||tx.value!==0n||ethers.keccak256(tx.data)!==manifest.bytecodeHash||tx.from.toLowerCase()!==expectedAccount.toLowerCase())throw Error('TRANSACTION_MISMATCH');
  const canonical=await provider.getBlock(receipt.blockNumber);if(!canonical?.hash||canonical.hash.toLowerCase()!==receipt.blockHash.toLowerCase())throw Error('RECEIPT_NOT_CANONICAL');
  if(receipt.status!==1)throw Error('DEPLOYMENT_REVERTED');
  if(!receipt.contractAddress)throw Error('CONTRACT_UNAVAILABLE');
  const address=ethers.getAddress(receipt.contractAddress);
  const expectedAddress=ethers.getCreateAddress({from:tx.from,nonce:tx.nonce});if(address!==expectedAddress)throw Error('TRANSACTION_MISMATCH');
  const code=await provider.getCode(address);if(code==='0x'||ethers.keccak256(code)!==manifest.runtimeHash)throw Error('CONTRACT_CODE_MISMATCH');
  const contract=new ethers.Contract(address,manifest.abi,provider);
  const [name,symbol,decimals,supply,balance]=await Promise.all([contract.name(),contract.symbol(),contract.decimals(),contract.totalSupply(),contract.balanceOf(expectedAccount)]);
  if(name!==manifest.name||symbol!==manifest.symbol||decimals!==18n||supply!==ethers.parseUnits(manifest.supply,18))throw Error('TOKEN_PROPERTIES_MISMATCH');
  return {address,hash,blockNumber:receipt.blockNumber,balance:ethers.formatUnits(balance,18)};
}
