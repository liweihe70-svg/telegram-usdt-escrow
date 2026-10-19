import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {request} from 'node:http';
import * as ethers from 'ethers';
import {sendDeployment,verifyDeployment,RECORD_KEY,ROOT_PATH,createPlatformWallet,platformPublic,verifyPlatformWallet} from '../public/deploy-assistant/core.js';
import {deployAssistant} from '../scripts/deploy-assistant-server.mjs';
import {validatePayoutPlan,signPayoutLocally,validateGasPlan,signGasLocally,GAS_STATION_INDEX,validateSweepPlan,signSweepLocally,TREASURY_INDEX,setSigningChain} from '../public/deploy-assistant/core.js';
import {hashPlan} from '../dist/src/production/payouts.js';
import {hashSweepPlan} from '../dist/src/production/sweeps.js';
import {TREASURY_INDEX as SERVER_TREASURY_INDEX} from '../dist/src/production/wallets.js';
import {hashGasPlan} from '../dist/src/production/gas.js';
import {GAS_STATION_INDEX as SERVER_GAS_INDEX} from '../dist/src/production/wallets.js';
import {createHash} from 'node:crypto';

const artifact=JSON.parse(await readFile(new URL('../artifacts/test-token/TestEscrowToken.json',import.meta.url),'utf8'));
const manifest={chainId:97,name:'Escrow Test Token',symbol:'TESTUSD',decimals:18,supply:'1000000',abi:artifact.abi,bytecode:'0x'+artifact.evm.bytecode.object,runtimeHash:ethers.keccak256('0x'+artifact.evm.deployedBytecode.object)};manifest.bytecodeHash=ethers.keccak256(manifest.bytecode);
const account='0x1111111111111111111111111111111111111111',other='0x2222222222222222222222222222222222222222',hash='0x'+'a'.repeat(64),block='0x'+'b'.repeat(64);
function fixture(){
  const values=new Map(),storage={getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value)};
  let chain='0x61',actor=account,outcome='success';const calls=[];
  const wallet={request:async({method,params})=>{calls.push({method,params});if(method==='eth_chainId')return chain;if(method==='eth_accounts')return [actor];if(method==='eth_sendTransaction'){if(outcome==='reject')throw Object.assign(Error(),{code:4001});if(outcome==='unknown')throw Error('RPC dropped');return hash;}throw Error('Unexpected method');}};
  const estimate={account,bytecodeHash:manifest.bytecodeHash,gas:'0x100000',at:Date.now()};
  return {storage,calls,wallet,estimate,chain:value=>chain=value,actor:value=>actor=value,outcome:value=>outcome=value};
}
const send=f=>sendDeployment({...f,manifest,confirmation:'TESTNET'});
test('deployment never submits on mainnet, changed account, expired estimate or missing confirmation',async()=>{
  const f=fixture();f.chain('0x38');await assert.rejects(send(f),/CHAIN_97_REQUIRED/);f.chain('0x61');f.actor(other);await assert.rejects(send(f),/ESTIMATE_AGAIN/);f.actor(account);f.estimate.at=Date.now()-130000;await assert.rejects(send(f),/ESTIMATE_AGAIN/);
  await assert.rejects(sendDeployment({...f,manifest,confirmation:''}),/TYPE_TESTNET/);assert.equal(f.calls.filter(c=>c.method==='eth_sendTransaction').length,0);
});
test('submission snapshots zero-value contract creation, saves hash and blocks repeated deployment',async()=>{
  const f=fixture(),r=await send(f);assert.equal(r.hash,hash);assert.equal(JSON.parse(f.storage.getItem(RECORD_KEY)).phase,'pending');
  const tx=f.calls.find(c=>c.method==='eth_sendTransaction').params[0];assert.equal(tx.chainId,'0x61');assert.equal(tx.value,'0x0');assert.equal(tx.to,undefined);assert.equal(tx.data,manifest.bytecode);
  await assert.rejects(send(f),/EXISTING_DEPLOYMENT/);assert.equal(f.calls.filter(c=>c.method==='eth_sendTransaction').length,1);
});
test('unknown submission blocks retry across reload; explicit rejection and failed storage do not auto-send',async()=>{
  const f=fixture();f.outcome('unknown');await assert.rejects(send(f));assert.equal(JSON.parse(f.storage.getItem(RECORD_KEY)).phase,'submitting');await assert.rejects(send(f),/EXISTING_DEPLOYMENT/);
  const rejected=fixture();rejected.outcome('reject');await assert.rejects(send(rejected));assert.equal(JSON.parse(rejected.storage.getItem(RECORD_KEY)).phase,'rejected');assert.equal(rejected.calls.filter(c=>c.method==='eth_sendTransaction').length,1);
  const quota=fixture();quota.storage.setItem=()=>{throw Error('storage quota');};await assert.rejects(send(quota),/storage quota/);assert.equal(quota.calls.filter(c=>c.method==='eth_sendTransaction').length,0);
});
function recovery(){
  const contract=ethers.getCreateAddress({from:account,nonce:0}),state={chain:97n,status:1,code:'0x'+artifact.evm.deployedBytecode.object,from:account,decimals:18n,canonical:block};
  const provider={getNetwork:async()=>({chainId:state.chain}),getTransactionReceipt:async()=>({status:state.status,contractAddress:contract,blockNumber:12,blockHash:block}),getTransaction:async()=>({chainId:97n,to:null,value:0n,data:manifest.bytecode,from:state.from,nonce:0}),getBlock:async()=>({hash:state.canonical}),getCode:async()=>state.code};
  const lib={...ethers,Contract:class{async name(){return manifest.name;}async symbol(){return 'TESTUSD';}async decimals(){return state.decimals;}async totalSupply(){return ethers.parseUnits('1000000',18);}async balanceOf(){return ethers.parseUnits('1000000',18);}}};
  return {state,provider,lib,contract};
}
test('recovery validates chain, creation transaction, canonical success receipt, bytecode and token identity',async()=>{
  const f=recovery(),check=()=>verifyDeployment({provider:f.provider,manifest,hash,expectedAccount:account,ethers:f.lib});
  assert.equal((await check()).address,f.contract);f.state.chain=56n;await assert.rejects(check(),/CHAIN_97_REQUIRED/);f.state.chain=97n;
  f.state.status=0;await assert.rejects(check(),/DEPLOYMENT_REVERTED/);f.state.status=1;f.state.from=other;await assert.rejects(check(),/TRANSACTION_MISMATCH/);f.state.from=account;
  f.state.canonical='0x'+'c'.repeat(64);await assert.rejects(check(),/RECEIPT_NOT_CANONICAL/);f.state.canonical=block;f.state.code='0x1234';await assert.rejects(check(),/CONTRACT_CODE_MISMATCH/);f.state.code='0x'+artifact.evm.deployedBytecode.object;
  f.state.decimals=6n;await assert.rejects(check(),/TOKEN_PROPERTIES_MISMATCH/);
});
test('assistant serves only local public assets and testnet artifact; no signing or write endpoint',async t=>{
  const app=await deployAssistant(0);t.after(()=>app.stop());
  const health=await (await fetch(app.url+'health')).json();assert.equal(health.chainId,97);assert.equal(health.serverSigning,false);assert.equal(health.mainnetEnabled,false);
  const artifact=await (await fetch(app.url+'token.json')).json();assert.equal(artifact.bytecodeHash,manifest.bytecodeHash);
  assert.equal((await fetch(app.url+'.env.production')).status,404);assert.equal((await fetch(app.url+'token.json',{method:'POST',body:'{}'})).status,405);
  const html=await fetch(app.url);assert.ok(html.headers.get('content-security-policy').includes("frame-ancestors 'none'"));assert.ok((await html.text()).includes('deploy-form'));
  const hostile=await new Promise((resolve,reject)=>{const req=request(app.url,{headers:{host:'evil.test'}},res=>{res.resume();resolve(res.statusCode);});req.on('error',reject);req.end();});assert.equal(hostile,403);
});
test('platform wallet encryption preserves the external public branch and restores child signing keys without plaintext secrets',async()=>{
  // Public test mnemonic, never used on a network; browser production uses createRandom.
  const phrase='test test test test test test test test test test test junk';
  const root=ethers.HDNodeWallet.fromPhrase(phrase,undefined,ROOT_PATH),password='fixture-wallet-password-2026';
  const creationLib={...ethers,HDNodeWallet:{createRandom:()=>root}};
  await assert.rejects(createPlatformWallet('short','short',creationLib),/WALLET_PASSWORD/);
  await assert.rejects(createPlatformWallet(password,password+'different',creationLib),/WALLET_PASSWORD/);
  const result=await createPlatformWallet(password,password,creationLib);
  assert.equal(result.xpub,root.neuter().extendedKey);assert.equal(result.firstAddress,root.deriveChild(0).address);
  for(const secret of [phrase,root.privateKey.slice(2),root.extendedKey,root.mnemonic.entropy.slice(2),password])assert.ok(!result.encryptedJson.includes(secret));
  assert.equal(Object.keys(result).sort().join(','),'encryptedJson,firstAddress,rootId,xpub');
  const publicInfo=platformPublic(result.encryptedJson,ethers);assert.equal(publicInfo.xpub,result.xpub);
  const verified=await verifyPlatformWallet(result.encryptedJson,password,ethers);assert.deepEqual(verified,publicInfo);
  const restored=await ethers.Wallet.fromEncryptedJson(result.encryptedJson,password);assert.equal(restored.deriveChild(5).privateKey,root.deriveChild(5).privateKey);
  await assert.rejects(verifyPlatformWallet(result.encryptedJson,'wrong-fixture-password',ethers),/WALLET_RESTORE_FAILED/);
  const tampered=JSON.parse(result.encryptedJson);tampered.escrowTestWallet.chainId=56;assert.throws(()=>platformPublic(JSON.stringify(tampered),ethers),/WALLET_BACKUP_INVALID/);
  tampered.escrowTestWallet.chainId=97;tampered.Crypto.kdfparams.n=1073741824;assert.throws(()=>platformPublic(JSON.stringify(tampered),ethers),/WALLET_BACKUP_INVALID/);
  const altered=JSON.parse(result.encryptedJson),otherRoot=ethers.HDNodeWallet.fromPhrase(phrase,undefined,"m/44'/60'/1'/0");
  altered.escrowTestWallet.xpub=otherRoot.neuter().extendedKey;altered.escrowTestWallet.rootId=ethers.sha256(ethers.toUtf8Bytes(altered.escrowTestWallet.xpub)).slice(2);
  await assert.rejects(verifyPlatformWallet(JSON.stringify(altered),password,ethers),/WALLET_RESTORE_FAILED/);
  const child=root.deriveChild(2),iface=new ethers.Interface(['function transfer(address to,uint256 amount) returns (bool)']);
  const p={version:1,requestId:'11111111-1111-1111-1111-111111111111',orderId:'22222222-2222-2222-2222-222222222222',orderRevision:5,snapshotHash:'a'.repeat(64),chainId:97,tokenContract:'0x3333333333333333333333333333333333333333',xpub:result.xpub,childIndex:2,source:child.address,recipient:other,amount:ethers.parseUnits('100',18).toString(),retainedFee:ethers.parseUnits('5',18).toString(),nonce:0,gasLimit:'90000',gasPrice:'1000000000',value:'0',type:0};p.data=iface.encodeFunctionData('transfer',[p.recipient,p.amount]);
  const hash=createHash('sha256').update(JSON.stringify([p.version,p.requestId,p.orderId,p.orderRevision,p.snapshotHash,p.chainId,p.tokenContract,p.xpub,p.childIndex,p.source,p.recipient,p.amount,p.retainedFee,p.nonce,p.gasLimit,p.gasPrice,p.data,p.value,p.type])).digest('hex');
  assert.equal(validatePayoutPlan(p,hash,ethers),p);assert.throws(()=>validatePayoutPlan({...p,chainId:56},hash,ethers),/PAYOUT_PLAN_INVALID/);
  assert.throws(()=>validatePayoutPlan({...p,recipient:account},hash,ethers),/PAYOUT_PLAN_INVALID/);assert.throws(()=>validatePayoutPlan({...p,gasLimit:'999999999'},hash,ethers),/PAYOUT_PLAN_INVALID/);
  const signed=await signPayoutLocally(p,hash,result.encryptedJson,password,ethers);const tx=ethers.Transaction.from(signed.raw);assert.equal(tx.from,child.address);assert.equal(tx.chainId,97n);assert.equal(tx.value,0n);assert.equal(tx.data,p.data);assert.equal(signed.txHash,tx.hash);
});
test('gas top-up plan hash matches the server and is signed only by the reserved station child',async()=>{
  const phrase='test test test test test test test test test test test junk';
  const root=ethers.HDNodeWallet.fromPhrase(phrase,undefined,ROOT_PATH),password='fixture-wallet-password-2026';
  const backup=(await createPlatformWallet(password,password,{...ethers,HDNodeWallet:{createRandom:()=>root}})).encryptedJson;
  assert.equal(GAS_STATION_INDEX,SERVER_GAS_INDEX);const station=root.deriveChild(GAS_STATION_INDEX);
  const plan={version:1,kind:'GAS_TOPUP',id:'11111111-1111-4111-8111-111111111111',requestId:'22222222-2222-4222-8222-222222222222',orderId:'33333333-3333-4333-8333-333333333333',chainId:97,xpub:root.neuter().extendedKey,childIndex:GAS_STATION_INDEX,source:station.address,target:root.deriveChild(0).address,amount:'180000000000000',nonce:3,gasLimit:'21000',gasPrice:'1000000000',data:'0x',type:0};
  const planHash=hashGasPlan(plan);assert.equal(validateGasPlan(plan,planHash,ethers),plan);
  assert.throws(()=>validateGasPlan({...plan,amount:'20000000000000001'},planHash,ethers),/GAS_PLAN_INVALID/);
  assert.throws(()=>validateGasPlan({...plan,source:root.deriveChild(1).address},planHash,ethers),/GAS_PLAN_INVALID/);
  assert.throws(()=>validateGasPlan(plan,'0'.repeat(64),ethers),/GAS_PLAN_INVALID/);
  const signed=await signGasLocally(plan,planHash,backup,password,ethers),tx=ethers.Transaction.from(signed.raw);
  assert.equal(tx.from,station.address);assert.equal(tx.to,plan.target);assert.equal(tx.value,180000000000000n);assert.equal(tx.nonce,3);assert.equal(tx.chainId,97n);assert.equal(tx.data,'0x');
  await assert.rejects(signGasLocally(plan,planHash,backup,'wrong-password-fixture',ethers),/WALLET_RESTORE_FAILED/);
});
test('fee collection plan hash matches the server and cannot be redirected away from the treasury child',async()=>{
  const phrase='test test test test test test test test test test test junk';
  const root=ethers.HDNodeWallet.fromPhrase(phrase,undefined,ROOT_PATH),password='fixture-wallet-password-2026';
  const backup=(await createPlatformWallet(password,password,{...ethers,HDNodeWallet:{createRandom:()=>root}})).encryptedJson;
  assert.equal(TREASURY_INDEX,SERVER_TREASURY_INDEX);const treasury=root.deriveChild(TREASURY_INDEX),source=root.deriveChild(4),token='0x3333333333333333333333333333333333333333';
  const iface=new ethers.Interface(['function transfer(address to,uint256 amount) returns (bool)']),amount=5n*10n**18n;
  const plan={version:1,kind:'FEE_SWEEP',id:'11111111-1111-4111-8111-111111111111',orderId:'33333333-3333-4333-8333-333333333333',chainId:97,tokenContract:token,xpub:root.neuter().extendedKey,childIndex:4,treasuryIndex:TREASURY_INDEX,source:source.address,target:treasury.address,amount:amount.toString(),nonce:1,gasLimit:'90000',gasPrice:'1000000000',data:iface.encodeFunctionData('transfer',[treasury.address,amount]),value:'0',type:0};
  const planHash=hashSweepPlan(plan);assert.equal(validateSweepPlan(plan,planHash,ethers),plan);
  const other=root.deriveChild(5).address,redirected={...plan,target:other,data:iface.encodeFunctionData('transfer',[other,amount])};
  assert.throws(()=>validateSweepPlan(redirected,hashSweepPlan(redirected),ethers),/SWEEP_PLAN_INVALID/);
  assert.throws(()=>validateSweepPlan(plan,'0'.repeat(64),ethers),/SWEEP_PLAN_INVALID/);
  const signed=await signSweepLocally(plan,planHash,backup,password,ethers),tx=ethers.Transaction.from(signed.raw);
  assert.equal(tx.from,source.address);assert.equal(tx.to,token);assert.equal(tx.data,plan.data);assert.equal(tx.value,0n);assert.equal(tx.nonce,1);
});
test('mainnet signing only accepts chain-56 plans and a mainnet wallet backup; testnet backups are refused',async()=>{
  const phrase='test test test test test test test test test test test junk';
  const root=ethers.HDNodeWallet.fromPhrase(phrase,undefined,ROOT_PATH),password='fixture-wallet-password-2026',lib={...ethers,HDNodeWallet:{createRandom:()=>root}};
  const testnetBackup=(await createPlatformWallet(password,password,lib)).encryptedJson;
  try{
    setSigningChain(56);const mainnetBackup=(await createPlatformWallet(password,password,lib)).encryptedJson;
    assert.equal(JSON.parse(mainnetBackup).escrowTestWallet.chainId,56);assert.throws(()=>platformPublic(testnetBackup,ethers),/WALLET_BACKUP_INVALID/);
    const iface=new ethers.Interface(['function transfer(address to,uint256 amount) returns (bool)']),source=root.deriveChild(0),recipient='0x2222222222222222222222222222222222222222';
    const plan={version:1,requestId:'22222222-2222-4222-8222-222222222222',orderId:'33333333-3333-4333-8333-333333333333',orderRevision:7,snapshotHash:'a'.repeat(64),chainId:56,tokenContract:'0x55d398326f99059fF775485246999027B3197955',xpub:root.neuter().extendedKey,childIndex:0,source:source.address,recipient,amount:'10000000000000000000',retainedFee:'1000000000000000000',nonce:0,gasLimit:'90000',gasPrice:'1000000000',data:iface.encodeFunctionData('transfer',[recipient,10n**19n]),value:'0',type:0};
    const planHash=hashPlan(plan);assert.equal(validatePayoutPlan(plan,planHash,ethers),plan);
    assert.throws(()=>validatePayoutPlan({...plan,chainId:97},hashPlan({...plan,chainId:97}),ethers),/PAYOUT_PLAN_INVALID/);
    await assert.rejects(signPayoutLocally(plan,planHash,testnetBackup,password,ethers),/WALLET_BACKUP_INVALID/);
    const signed=await signPayoutLocally(plan,planHash,mainnetBackup,password,ethers);assert.equal(ethers.Transaction.from(signed.raw).chainId,56n);
  }finally{setSigningChain(97);}
});
