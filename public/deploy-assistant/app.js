import * as ethers from '/ethers.js';
import {identity,readRecord,sendDeployment,verifyDeployment,RECORD_KEY,PLATFORM_KEY,createPlatformWallet,platformPublic,verifyPlatformWallet,validatePayoutPlan,signPayoutLocally,validateGasPlan,signGasLocally,validateSweepPlan,signSweepLocally,setSigningChain} from './core.js';
const $=id=>document.getElementById(id);
// The selected network decides which backend is contacted, which wallet backup is used and which chain ID is signed.
const NET=localStorage.getItem('signer-network')==='mainnet'?'mainnet':'testnet',MAINNET=NET==='mainnet',WORD=MAINNET?'MAINNET':'TESTNET';
setSigningChain(MAINNET?56:97);const API=MAINNET?'http://127.0.0.1:8784':'http://127.0.0.1:8782',WALLET_KEY=MAINNET?PLATFORM_KEY+'-mainnet':PLATFORM_KEY;
let lang=localStorage.getItem('production-language')==='en'?'en':'zh',wallet=null,account='',estimate=null,manifest=null,busy=false,timer=null,verified=null;
const providers=[];
let platformBackup=null,platformVerified=false,platformBusy=false,backupUrl=null;
let payoutCsrf='',payoutRows=[],payoutBusy=false,gasState=null,sweepState=null;
const words={
subtitle:['测试部署助手','Test deployment assistant'],notice:['仅 BNB 测试网（97）· 部署测试代币 · 钱包由你确认','BNB testnet (97) only · Test token deployment · Confirm in your wallet'],title:['部署 TESTUSD 测试代币','Deploy TESTUSD test token'],intro:['无需 Remix。连接测试钱包、估算手续费，然后在钱包中确认部署。不会要求私钥或助记词，也不会修改正式订单。','No Remix required. Connect your test wallet, estimate the fee, then confirm deployment in your wallet. No private keys or recovery phrases are requested. Production orders are not changed.'],
'wallet-title':['1. 连接测试钱包','1. Connect a test wallet'],'wallet-help':['请用安装 MetaMask 的 Edge / Chrome 打开本页，并在钱包中切换 BNB 测试网（97）。钱包密码只在扩展中填写。','Open this page in Edge / Chrome with MetaMask installed. Select BNB testnet (97) in the wallet. Enter your wallet password only in the extension.'],connect:['连接钱包','Connect wallet'],refresh:['刷新钱包状态','Refresh wallet'],
'account-label':['部署账号','Deployment account'],'network-label':['网络','Network'],'balance-label':['测试币余额','Test balance'],'token-title':['2. 核对部署内容','2. Review deployment'],'symbol-label':['代币符号','Symbol'],'decimals-label':['精度','Decimals'],'supply-label':['发放给部署账号','Issued to deployer'],'chain-label':['测试网链 ID','Testnet chain ID'],
'estimate-help':['部署后当前账号获得100万枚测试代币。没有真实价值，不会兑换或支付 USDT。估算会过期，钱包中显示的最终手续费为准。','The deployer receives 1,000,000 test tokens with no monetary value. No USDT payment or exchange is performed. Estimates expire; review the final fee in your wallet.'],estimate:['估算部署手续费','Estimate deployment fee'],'confirmation-text':['核对后输入 TESTNET，再点击部署','After review, type TESTNET and click Deploy'],deploy:['部署，并在钱包中确认','Deploy and confirm in wallet'],
'result-title':['3. 部署结果','3. Deployment result'],'hash-label':['交易哈希','Transaction hash'],'contract-label':['测试代币合约地址','Test token contract address'],copy:['复制合约地址','Copy contract address'],import:['在钱包中添加 TESTUSD','Add TESTUSD to wallet'],'recover-label':['已有部署交易？粘贴完整交易哈希核验','Already submitted? Paste the full transaction hash'],'recover':['查询并核验交易','Check and verify transaction'],'recover-help':['页面不会自动重新发送部署。若钱包已提交但页面没有哈希，请从钱包活动记录复制交易哈希，在此恢复核验。此处只查询，不发送交易。','Deployment is never automatically resubmitted. If your wallet submitted but this page has no hash, copy it from wallet activity and verify it here. Recovery only reads chain data.'],explorer:['在 BscScan 测试网查看交易','View transaction on BscScan testnet']};
const messages={READY:['页面就绪，请连接测试钱包。','Ready. Connect your test wallet.'],NO_WALLET:['未发现钱包扩展。请在安装 MetaMask 的 Edge/Chrome 打开此网址。','No wallet extension found. Open this URL in Edge/Chrome with MetaMask installed.'],CHAIN_97_REQUIRED:['请在钱包中切换 BNB 测试网（链 ID 97），再刷新。','Switch your wallet to BNB testnet (chain ID 97), then refresh.'],CONNECT_WALLET:['请先连接钱包。','Connect your wallet first.'],TYPE_TESTNET:['请准确输入 TESTNET。','Type TESTNET exactly.'],ESTIMATE_AGAIN:['账号或估算已变化，请重新估算。','Account or estimate changed. Estimate again.'],EXISTING_DEPLOYMENT:['已有待处理或已成功部署，请核验原交易，避免重复部署。','A pending or successful deployment exists. Verify the original transaction to avoid duplicates.'],SAVED_RECORD_INVALID:['本机部署记录格式异常，部署已暂停，请核对钱包活动记录。','Saved deployment record is invalid. Deployment paused; review wallet activity.'],INSUFFICIENT_BALANCE:['测试币余额不足以支付估算手续费。','Insufficient test balance for the estimated fee.'],PENDING:['交易已提交，等待链上回执。可稍后点击查询；不会自动重发。','Transaction submitted. Waiting for a receipt. You may check later; it will not be resubmitted.'],UNKNOWN:['钱包操作结果尚不确定。请查看钱包活动记录，并用交易哈希恢复核验，暂勿再次部署。','Wallet outcome is uncertain. Check wallet activity and recover using the transaction hash before attempting another deployment.'],REJECTED:['你取消了钱包请求；没有自动重试。','You rejected the wallet request. No automatic retry.'],DEPLOYMENT_REVERTED:['部署交易失败；请查看钱包回执，手续费可能已消耗。','Deployment reverted. Check the receipt; gas may have been spent.'],TRANSACTION_MISMATCH:['这笔交易与本页面的测试合约、链或部署账号不匹配。','Transaction does not match this test contract, chain or deployment account.'],COPIED:['合约地址已复制。','Contract address copied.'],GENERIC:['操作未完成，请核对钱包网络和扩展提示，再查询原交易。','Operation incomplete. Check wallet network and extension prompts, then check the original transaction.'],LOCKED:['另一个页面正在部署，请先处理该页面或钱包请求。','Another tab is deploying. Resolve that tab or wallet request first.'],LOCK_UNAVAILABLE:['此浏览器不支持部署互斥，请使用新版 Edge/Chrome。','This browser lacks deployment locking. Use current Edge/Chrome.']};
const choose=a=>a[lang==='en'?1:0];
Object.assign(words,{'payout-title':['5. 已审核的测试网出款','5. Approved testnet payouts'],'payout-help':['先在同一浏览器登录8782。这里仅处理已审核的商品订单；不会创建假订单或替代双方确认。备份与密码只在本页面本机解密，后台只收到公开的签名交易。签名和广播分两步，每步需你核对。','Sign in to 8782 in the same browser first. Only approved goods orders are processed. No fake orders or party impersonation. Backup decryption is local; the server receives only the public signed transaction. Review signing and broadcasting separately.'],
'payout-login':['打开正式后台登录','Open production panel to sign in'],'payout-connect':['连接已登录后台','Connect authenticated panel'],'payout-refresh':['刷新出款与回执','Refresh payouts and receipts'],'payout-select-label':['选择出款申请','Select a payout request'],'payout-prepare':['准备不可变交易计划','Prepare immutable transaction plan'],'payout-file-label':['选择平台加密钱包备份','Choose platform encrypted wallet backup'],'payout-password-label':['备份密码（仅本机使用）','Backup password (local use only)'],'payout-sign-confirm-label':['核对计划，输入 TESTNET 签名','Review plan, type TESTNET to sign'],'payout-sign':['本机签名并提交核验（不广播）','Sign locally and submit for validation (no broadcast)'],'payout-broadcast-confirm-label':['再次核对交易，输入 TESTNET 广播','Review again, type TESTNET to broadcast'],'payout-broadcast':['广播原签名测试交易','Broadcast the original signed test transaction']});
Object.assign(messages,{PAYOUT_PLAN_INVALID:['出款计划核验失败，不能签名。','Payout plan validation failed; signing blocked.'],PAYOUT_SIGNED:['签名已提交核验，尚未广播。请再次核对后广播原交易。','Signature validated; not broadcast. Review again before broadcasting the original transaction.'],PAYOUT_READY:['已连接后台。没有已审核订单时，仍需最后完成双账号订单联调。','Panel connected. Without approved orders, the final two-account integration test is still required.'],PAYOUT_BROADCAST:['已请求广播原交易，后台将核验最终确认回执。超时请刷新原交易，不要重新签名。','Original transaction broadcast requested. The server checks finalized receipts. If delayed, refresh the original transaction; do not sign again.']});
Object.assign(words,{'gas-title':['补充出款手续费（tBNB）','Top up payout gas (tBNB)'],'gas-help':['独立收款地址没有 tBNB 时无法出款。先向下方手续费钱包转入测试 BNB，再为所选出款准备补充计划。签名使用上面选择的同一份加密备份，只在本机解密。','An order address without tBNB cannot pay out. Send test BNB to the gas wallet below, then prepare a top-up for the selected payout. Signing uses the same encrypted backup chosen above and decrypts only locally.'],'gas-prepare':['准备手续费补充计划','Prepare gas top-up plan'],'gas-password-label':['备份密码（仅本机使用）','Backup password (local use only)'],'gas-sign-confirm-label':['核对补充计划，输入 TESTNET 签名','Review top-up plan, type TESTNET to sign'],'gas-sign':['本机签名补充交易（不广播）','Sign top-up locally (no broadcast)'],'gas-broadcast-confirm-label':['再次核对，输入 TESTNET 广播','Review again, type TESTNET to broadcast'],'gas-broadcast':['广播手续费补充交易','Broadcast gas top-up']});
Object.assign(messages,{GAS_PLAN_INVALID:['手续费补充计划核验失败，不能签名。','Gas top-up plan validation failed; signing blocked.'],GAS_SIGNED:['补充交易签名已核验，尚未广播。','Top-up signature validated; not broadcast.'],GAS_BROADCAST:['已请求广播补充交易。最终确认并记账后，再准备出款计划。','Top-up broadcast requested. Prepare the payout plan after it is finalized and booked.']});
Object.assign(words,{'replace-title':['出款长时间未确认：提高手续费加速','Payout stuck: speed up with a higher fee'],'replace-help':['只用于已广播但迟迟未确认的出款。加速交易与原交易使用同一 nonce、同一收款方和金额，只提高 gas 价格，链上最多只会成交其中一笔，不会重复付款。签名使用上面选择的同一份加密备份。','Only for a broadcast payout that has not confirmed. The speed-up uses the same nonce, recipient and amount with a higher gas price; at most one of them can ever be mined, so it cannot pay twice. Signing uses the encrypted backup chosen above.'],'replace-prepare':['准备加速计划','Prepare speed-up plan'],'replace-password-label':['备份密码（仅本机使用）','Backup password (local use only)'],'replace-sign-confirm-label':['核对加速计划，输入 TESTNET 签名','Review speed-up plan, type TESTNET to sign'],'replace-sign':['本机签名加速交易（不广播）','Sign speed-up locally (no broadcast)'],'replace-broadcast-confirm-label':['再次核对，输入 TESTNET 广播','Review again, type TESTNET to broadcast'],'replace-broadcast':['广播加速交易','Broadcast speed-up']});
Object.assign(messages,{REPLACE_SIGNED:['加速签名已核验，尚未广播。','Speed-up signature validated; not broadcast.'],REPLACE_BROADCAST:['已请求广播加速交易。原交易和加速交易只会成交一笔，请刷新回执。','Speed-up broadcast requested. Only one of the original and the speed-up can be mined; refresh receipts.']});
Object.assign(words,{'sweep-title':['6. 归集平台手续费','6. Collect platform fees'],'sweep-help':['正常放款或“本金给卖家”裁决后，订单地址留有平台手续费。这里把它转到同一钱包的平台收入地址（保留子地址）。订单地址余额必须正好等于手续费，并需要少量 tBNB 支付 gas。请先在上方连接已登录后台。','After a normal release or a principal-to-seller decision, the platform fee stays at the order address. This moves it to the platform treasury (a reserved child of the same wallet). The order address must hold exactly the fee and a little tBNB for gas. Connect the authenticated panel above first.'],'sweep-refresh':['刷新可归集订单与回执','Refresh collectable orders and receipts'],'sweep-select-label':['选择订单','Select an order'],'sweep-prepare':['准备不可变归集计划','Prepare immutable collection plan'],'sweep-file-label':['选择平台加密钱包备份','Choose platform encrypted wallet backup'],'sweep-password-label':['备份密码（仅本机使用）','Backup password (local use only)'],'sweep-sign-confirm-label':['核对计划，输入 TESTNET 签名','Review plan, type TESTNET to sign'],'sweep-sign':['本机签名并提交核验（不广播）','Sign locally and submit for validation (no broadcast)'],'sweep-broadcast-confirm-label':['再次核对，输入 TESTNET 广播','Review again, type TESTNET to broadcast'],'sweep-broadcast':['广播归集交易','Broadcast collection transaction']});
Object.assign(messages,{SWEEP_PLAN_INVALID:['归集计划核验失败，不能签名。','Collection plan validation failed; signing blocked.'],SWEEP_SIGNED:['归集签名已核验，尚未广播。','Collection signature validated; not broadcast.'],SWEEP_BROADCAST:['已请求广播归集交易，后台将核验最终确认回执。','Collection broadcast requested. The server checks the finalized receipt.']});
async function payoutApi(path,body){
  const res=await fetch(API+'/api/signing/'+path,{credentials:'include',method:body===undefined?'GET':'POST',headers:body===undefined?{}:{'content-type':'application/json','x-csrf-token':payoutCsrf},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const data=await res.json();if(!res.ok)throw Error(data.error??'GENERIC');return data;
}
const selectedPayout=()=>payoutRows.find(r=>r.id===$('payout-select').value);
const selectedGas=()=>{const r=selectedPayout();return r&&gasState?.topups?.find(g=>g.request_id===r.id&&['PREPARED','SIGNED','BROADCAST'].includes(g.status));};
const openReplacement=()=>(selectedPayout()?.replacements??[]).find(a=>['PREPARED','SIGNED'].includes(a.status));
function replaceButtons(){const r=selectedPayout(),a=openReplacement();$('replace-prepare').disabled=payoutBusy||r?.status!=='APPROVED'||r?.transaction_status!=='BROADCAST'||a?.status==='SIGNED';$('replace-sign').disabled=payoutBusy||a?.status!=='PREPARED';$('replace-broadcast').disabled=payoutBusy||a?.status!=='SIGNED';}
function replaceDetails(){const r=selectedPayout(),lines=[];for(const a of r?.replacements??[]){lines.push(`Speed-up #${a.attempt}: ${a.status} · ${ethers.formatUnits(a.gas_price,'gwei')} gwei${a.tx_hash?' · '+a.tx_hash:''}`);if(['PREPARED','SIGNED'].includes(a.status))lines.push(`Nonce: ${a.plan.nonce}`,`Maximum native fee: ${ethers.formatEther(BigInt(a.plan.gasLimit)*BigInt(a.plan.gasPrice))} ${MAINNET?'BNB':'tBNB'}`,`Plan hash: ${a.plan_hash}`);}
  if(r?.confirmed_tx_hash)lines.push(`Finalized: ${r.confirmed_tx_hash}`);$('replace-details').textContent=lines.join('\n');replaceButtons();}
function gasButtons(){replaceButtons();const r=selectedPayout(),g=selectedGas();$('gas-prepare').disabled=payoutBusy||r?.status!=='APPROVED'||Boolean(r?.transaction_status)||Boolean(g&&g.status!=='PREPARED');$('gas-sign').disabled=payoutBusy||g?.status!=='PREPARED';$('gas-broadcast').disabled=payoutBusy||!['SIGNED','BROADCAST'].includes(g?.status);}
function gasDetails(){const lines=[];if(gasState?.configured){lines.push(`Gas wallet: ${gasState.address}`);if(gasState.chain)lines.push(`Balance: ${ethers.formatEther(gasState.chain.native)} ${MAINNET?'BNB':'tBNB'}`,`Nonce: ${gasState.chain.nonce}`);if(gasState.chainError)lines.push(gasState.chainError);}
  const g=selectedGas(),done=gasState?.topups?.filter(t=>t.request_id===selectedPayout()?.id&&t.status==='CONFIRMED')??[];
  if(g){const p=g.plan;lines.push(`Top-up: ${g.status}`,`To: ${p.target}`,`Amount: ${ethers.formatEther(p.amount)} ${MAINNET?'BNB':'tBNB'}`,`Nonce: ${p.nonce}`,`Gas price (wei): ${p.gasPrice}`,`Plan hash: ${g.plan_hash}`);if(g.tx_hash)lines.push(`Tx: ${g.tx_hash}`);if(g.last_error)lines.push(g.last_error);}
  for(const t of done)lines.push(`Confirmed top-up: ${ethers.formatEther(t.amount)} tBNB · ${t.tx_hash}`);if(gasState?.confirmationError)lines.push(gasState.confirmationError);$('gas-details').textContent=lines.join('\n');gasButtons();}
function payoutButtons(){const r=selectedPayout();$('payout-connect').disabled=payoutBusy;$('payout-refresh').disabled=payoutBusy||!payoutCsrf;$('payout-select').disabled=payoutBusy;
  $('payout-prepare').disabled=payoutBusy||r?.status!=='APPROVED';$('payout-sign').disabled=payoutBusy||r?.status!=='APPROVED'||!r?.plan||r.transaction_status!=='PREPARED';$('payout-broadcast').disabled=payoutBusy||r?.status!=='APPROVED'||!['SIGNED','BROADCAST'].includes(r?.transaction_status);gasButtons();}
function payoutDetails(){const r=selectedPayout();if(!r){$('payout-details').textContent=lang==='en'?'No approved payouts.':'暂无已审核出款申请。';$('payout-hash').textContent='';payoutButtons();gasDetails();replaceDetails();return;}
  const p=r.plan;const lines=[`Request: ${r.id}`,`Order: ${r.order_id}`,`Type: ${r.kind??'RELEASE'}`,`Approval: ${r.status}`,`Transaction: ${r.transaction_status??'—'}`,`Chain: ${r.chain_id}`,`Token: ${r.token_contract}`,`Source: ${r.deposit_address??'—'}`,...r.allocations.map(a=>`Recipient: ${a.recipient}\nAmount: ${ethers.formatUnits(a.amount,18)}`),`Retained fee: ${ethers.formatUnits(r.fee,18)}`];
  if(p)lines.push(`Nonce: ${p.nonce}`,`Gas limit: ${p.gasLimit}`,`Gas price (wei): ${p.gasPrice}`,`Maximum native fee: ${ethers.formatEther(BigInt(p.gasLimit)*BigInt(p.gasPrice))} ${MAINNET?'BNB':'tBNB'}`,`Plan hash: ${r.plan_hash}`);
  if(r.last_error)lines.push(r.last_error);$('payout-details').textContent=lines.join('\n');$('payout-hash').textContent=r.tx_hash??'';payoutButtons();gasDetails();replaceDetails();
}
async function loadPayouts(){const old=$('payout-select').value,data=await payoutApi('requests');gasState=await payoutApi('gas');payoutRows=data.requests;$('payout-select').replaceChildren();for(const r of payoutRows){const o=document.createElement('option');o.value=r.id;o.textContent=`${r.id.slice(0,8)} · ${r.transaction_status??r.status}`;$('payout-select').append(o);}if(payoutRows.some(r=>r.id===old))$('payout-select').value=old;payoutDetails();}
async function payoutRun(fn){if(payoutBusy)return;payoutBusy=true;payoutButtons();try{await fn();}catch(e){$('payout-status').textContent=messages[e.message]?text(e.message):(lang==='en'?'Payout operation incomplete. Check the panel and original transaction. ':'出款操作未完成：')+(lang==='en'?'':e.message);try{if(payoutCsrf)await loadPayouts();}catch{}}finally{payoutBusy=false;payoutButtons();}}
$('payout-connect').onclick=()=>payoutRun(async()=>{const session=await payoutApi('session');payoutCsrf=session.csrf;await loadPayouts();$('payout-status').textContent=text('PAYOUT_READY');});
$('payout-refresh').onclick=()=>payoutRun(async()=>{const r=selectedPayout();if(selectedGas()?.tx_hash)await payoutApi(r.id+'/gas-reconcile',{});if(r?.tx_hash&&['SIGNED','BROADCAST'].includes(r.transaction_status))await payoutApi(r.id+'/reconcile',{});await loadPayouts();});
$('payout-select').onchange=payoutDetails;
$('payout-prepare').onclick=()=>payoutRun(async()=>{const r=selectedPayout();await payoutApi(r.id+'/prepare',{});await loadPayouts();});
$('payout-sign-form').onsubmit=e=>{e.preventDefault();void payoutRun(async()=>{const r=selectedPayout(),form=e.target,password=form.elements.password.value,confirmation=form.elements.confirmation.value;form.elements.password.value='';form.elements.confirmation.value='';
  if(confirmation!==WORD)throw Error('TYPE_TESTNET');validatePayoutPlan(r.plan,r.plan_hash,ethers);
  const file=$('payout-file').files?.[0];if(!file||file.size>32768)throw Error('WALLET_BACKUP_INVALID');const json=await file.text();
  const signed=await signPayoutLocally(r.plan,r.plan_hash,json,password,ethers,n=>{$('payout-status').textContent=(lang==='en'?'Local decryption: ':'本机解密：')+Math.round(n*100)+'%';});
  await payoutApi(r.id+'/submit',{raw:signed.raw,planHash:r.plan_hash});await loadPayouts();$('payout-status').textContent=text('PAYOUT_SIGNED');
});};
$('payout-broadcast-form').onsubmit=e=>{e.preventDefault();void payoutRun(async()=>{const r=selectedPayout(),confirmation=e.target.elements.confirmation.value;e.target.reset();await payoutApi(r.id+'/broadcast',{confirmation});await loadPayouts();$('payout-status').textContent=text('PAYOUT_BROADCAST');});};
Object.assign(words,{
'platform-title':['4. 初始化平台测试收款钱包','4. Initialize a platform test deposit wallet'],
'platform-help':['此钱包用于平台每单收款，与刚才部署代币的 MetaMask 钱包分开。仅供测试。加密备份在浏览器本机生成；私钥和助记词不会显示或上传。请保存备份并记住密码，丢失任一项可能无法恢复。','This wallet holds per-order platform deposits, separate from the MetaMask deployment wallet. Test use only. The encrypted backup is generated locally in your browser; private keys and recovery phrases are not displayed or uploaded. Keep the backup and password; losing either may prevent recovery.'],
'platform-password-label':['设置备份加密密码（至少12字符）','Backup encryption password (at least 12 characters)'],'platform-repeat-label':['再次输入密码','Repeat password'],
'platform-create':['生成平台测试钱包与加密备份','Generate test wallet and encrypted backup'],'platform-xpub-label':['公开收款分支 xpub','Public deposit branch xpub'],'platform-root-label':['公开分支编号','Public root ID'],'platform-address-label':['第一个子地址（仅预览，先不要转账）','First child address (preview only; do not transfer yet)'],
'platform-download':['下载加密钱包备份','Download encrypted wallet backup'],'platform-copy':['复制已验证的公开 xpub','Copy verified public xpub'],
'platform-restore-title':['验证备份后再配置后台','Verify backup before configuring the panel'],'platform-restore-help':['选择刚下载的 JSON 文件，输入同一个密码。本页在本机解密并检查公开分支，只返回 xpub；文件不会上传。刷新后仍需重新验证。','Choose the downloaded JSON file and enter the same password. This page decrypts locally and checks the public branch; only the xpub is returned. The file is not uploaded. Reverify after refreshing.'],
'platform-file-label':['选择加密钱包备份文件','Choose encrypted wallet backup'],'platform-restore-password-label':['备份加密密码','Backup encryption password'],'platform-restore':['验证加密备份','Verify encrypted backup']
});
Object.assign(messages,{
WALLET_PASSWORD:['密码至少12字符、不超过128字符，且两次输入必须一致。','Use 12–128 characters and matching passwords.'],WALLET_BACKUP_INVALID:['此文件不是本助手支持的测试钱包备份。','This is not a supported test wallet backup.'],WALLET_RESTORE_FAILED:['备份解密或公开分支核验失败，请核对密码和原始备份。','Backup decryption or public branch verification failed. Check the password and original backup.'],WALLET_ALREADY_EXISTS:['本浏览器已有平台钱包，请下载或验证现有备份，不要重新生成。','A platform wallet already exists here. Download or verify its backup instead of generating another.'],WALLET_ROOT_MISMATCH:['选中的备份与本浏览器现有收款分支不同，未替换现有钱包。','The backup belongs to a different deposit branch. The existing wallet was not replaced.'],WALLET_CREATED:['已生成加密备份。请下载文件，再用该文件验证恢复；尚未配置后台或接收资金。','Encrypted backup generated. Download the file and verify recovery using it. No panel configuration or funds have been changed.'],WALLET_VERIFIED:['备份解密与公开分支核验通过，可以复制 xpub 到正式后台。不要把备份或密码发到聊天。','Backup decryption and public branch verification passed. You may copy the xpub to the production panel. Do not share the backup or password in chat.'],WALLET_SAVED:['已发现本浏览器保存的加密备份，请先下载并验证。','An encrypted backup is saved in this browser. Download and verify it first.'],WALLET_STORAGE_FAILED:['无法保存浏览器加密备份。请先下载当前备份并验证，不要重新生成。','Could not save the encrypted backup in browser storage. Download and verify the current backup before generating anything else.']
});
Object.assign(words,{'platform-replace':['更换为新的平台钱包','Replace with a new platform wallet']});
// Forget the wallet this browser remembers so a new one can be generated. The old backup file is not touched;
// a panel that already uses the old wallet keeps refusing a different xpub, so this only helps a fresh instance.
function replacePlatform(){
  const word=prompt(lang==='en'?'Only for a fresh, empty instance. Make sure the OLD wallet backup file and password are saved: funds sent to old addresses can only be recovered with them. Type REPLACE to continue:':'只用于全新的空实例。请先确认旧钱包备份文件和密码已经保存好：以后转到旧地址的钱只能用它们取回。输入 REPLACE 继续：');
  if(word!=='REPLACE')return;localStorage.removeItem(WALLET_KEY);location.reload();
}
function platformButtons(){
  $('platform-create').disabled=platformBusy||Boolean(platformBackup);$('platform-create-form').hidden=Boolean(platformBackup);
  $('platform-restore').disabled=platformBusy;$('platform-copy').disabled=platformBusy||!platformVerified;
}
function showPlatform(json){
  const info=platformPublic(json,ethers);platformBackup=json;platformVerified=false;
  $('platform-output').hidden=false;$('platform-xpub').value=info.xpub;$('platform-root').textContent=info.rootId;$('platform-address').textContent=info.firstAddress;
  if(backupUrl)URL.revokeObjectURL(backupUrl);backupUrl=URL.createObjectURL(new Blob([json],{type:'application/json'}));
  $('platform-download').href=backupUrl;$('platform-download').download=(MAINNET?'escrow-mainnet-wallet-':'escrow-testnet-wallet-')+info.rootId.slice(0,8)+'.json';platformButtons();return info;
}
async function platformRun(fn){if(platformBusy)return;platformBusy=true;platformButtons();try{await fn();}catch(e){$('platform-status').textContent=text(messages[e.message]?e.message:'GENERIC');}finally{platformBusy=false;platformButtons();}}
function platformProgress(value){$('platform-status').textContent=(lang==='en'?'Local encryption/decryption: ':'本机加密／解密进度：')+Math.round(value*100)+'%';}
$('platform-create-form').onsubmit=e=>{e.preventDefault();void platformRun(async()=>{
  if(!navigator.locks)throw Error('LOCK_UNAVAILABLE');
  const form=e.target,password=form.elements.password.value,repeat=form.elements.repeat.value;form.reset();
  await navigator.locks.request('escrow-platform-wallet-init',{ifAvailable:true},async lock=>{
    if(!lock)throw Error('LOCKED');if(platformBackup||localStorage.getItem(WALLET_KEY))throw Error('WALLET_ALREADY_EXISTS');
    const created=await createPlatformWallet(password,repeat,ethers,platformProgress);showPlatform(created.encryptedJson);
    try{localStorage.setItem(WALLET_KEY,created.encryptedJson);}catch{throw Error('WALLET_STORAGE_FAILED');}
    $('platform-status').textContent=text('WALLET_CREATED');
  });
});};
$('platform-restore-form').onsubmit=e=>{e.preventDefault();void platformRun(async()=>{
  const file=$('platform-file').files?.[0],form=e.target,password=form.elements.password.value;form.elements.password.value='';
  if(!file||file.size>32768)throw Error('WALLET_BACKUP_INVALID');const json=await file.text();
  const candidate=platformPublic(json,ethers),current=platformBackup?platformPublic(platformBackup,ethers):null;
  if(current&&candidate.xpub!==current.xpub)throw Error('WALLET_ROOT_MISMATCH');
  await verifyPlatformWallet(json,password,ethers,platformProgress);
  showPlatform(json);platformVerified=true;
  try{const saved=localStorage.getItem(WALLET_KEY);if(saved&&platformPublic(saved,ethers).xpub!==candidate.xpub){platformVerified=false;throw Error('WALLET_ROOT_MISMATCH');}localStorage.setItem(WALLET_KEY,json);}catch(e){platformVerified=false;throw e;}
  $('platform-status').textContent=text('WALLET_VERIFIED');
});};
$('platform-copy').onclick=()=>platformRun(async()=>{if(!platformVerified)throw Error('WALLET_RESTORE_FAILED');await navigator.clipboard.writeText(platformPublic(platformBackup,ethers).xpub);$('platform-status').textContent=text('WALLET_VERIFIED');});
window.addEventListener('storage',e=>{if(e.key===WALLET_KEY&&e.newValue){try{showPlatform(e.newValue);$('platform-status').textContent=text('WALLET_SAVED');}catch{$('platform-status').textContent=text('WALLET_BACKUP_INVALID');$('platform-create').disabled=true;}}});
function text(key){return choose(messages[key]??messages.GENERIC);}
function status(key){$('status').textContent=text(key);}
function error(e){const rejected=e.code===4001||e.code==='ACTION_REJECTED';status(rejected?'REJECTED':messages[e.message]?e.message:'GENERIC');}
function render(){document.documentElement.lang=lang==='en'?'en':'zh-CN';$('language').value=lang;for(const [id,value] of Object.entries(words))$(id).textContent=choose(value);buttons();}
function record(){return readRecord(localStorage);}
function buttons(){let r;try{r=record();}catch{r={phase:'invalid'};}
  const blocked=r&&!['rejected','failed'].includes(r.phase);
  $('connect').disabled=busy||providers.length===0||!manifest;$('wallets').disabled=busy||Boolean(wallet);$('refresh').disabled=busy||!wallet;
  $('estimate').disabled=busy||!account||Boolean(blocked);$('deploy').disabled=busy||!estimate||$('confirmation').value!=='TESTNET'||Boolean(blocked);
  $('copy').disabled=!verified;$('import').disabled=busy||!verified||!wallet;$('recover').disabled=busy||!wallet;
}
async function run(fn){if(busy)return;busy=true;buttons();try{await fn();}catch(e){error(e);}finally{busy=false;buttons();}}
function addWallet(p,name){if(!p?.request||providers.some(item=>item.provider===p))return;providers.push({provider:p,name});const option=document.createElement('option');option.value=String(providers.length-1);option.textContent=name;$('wallets').append(option);buttons();}
window.addEventListener('eip6963:announceProvider',e=>addWallet(e.detail?.provider,e.detail?.info?.name??'Browser wallet'));
window.dispatchEvent(new Event('eip6963:requestProvider'));
for(const p of window.ethereum?.providers??(window.ethereum?[window.ethereum]:[]))addWallet(p,p.isMetaMask?'MetaMask':'Browser wallet');
async function refreshWallet(){estimate=null;$('estimate-result').textContent='';account='';$('account').textContent='—';$('balance').textContent='—';
  const chain=await wallet.request({method:'eth_chainId'});$('network').textContent=`Chain ID ${BigInt(chain)}`;
  const current=await identity(wallet);account=ethers.getAddress(current.account);$('account').textContent=account;
  const balance=await wallet.request({method:'eth_getBalance',params:[account,'latest']});$('balance').textContent=ethers.formatEther(balance)+' tBNB';
}
function showRecord(r){$('hash').textContent=r?.hash??'—';$('recover-hash').value=r?.hash??'';if(r?.hash){$('explorer').href='https://testnet.bscscan.com/tx/'+r.hash;$('explorer').hidden=false;}}
async function verify(hash,expectedAccount){
  await identity(wallet);
  const provider=new ethers.BrowserProvider(wallet,'any',{cacheTimeout:0});
  let result;try{result=await verifyDeployment({provider,manifest,hash,expectedAccount,ethers});}finally{provider.destroy();}
  if(!result){status('PENDING');return false;}
  verified=result;$('contract').value=result.address;$('hash').textContent=hash;$('explorer').href='https://testnet.bscscan.com/tx/'+hash;$('explorer').hidden=false;
  localStorage.setItem(RECORD_KEY,JSON.stringify({chainId:97,account:expectedAccount,bytecodeHash:manifest.bytecodeHash,hash,phase:'verified',address:result.address}));
  $('status').textContent=lang==='en'?`Verified mined receipt and contract: TESTUSD, 18 decimals. Account balance: ${result.balance} TESTUSD. Finality is still checked separately by the deposit monitor.`:`已核验成功回执与合约：TESTUSD，精度18位。部署账号当前余额 ${result.balance} TESTUSD。入金监听仍会另外检查最终确认。`;
  if(timer)clearInterval(timer);timer=null;return true;
}
function poll(r){if(timer)clearInterval(timer);let attempts=0;timer=setInterval(()=>{if(busy)return;if(++attempts>36){clearInterval(timer);timer=null;status('PENDING');return;}void run(()=>verify(r.hash,r.account));},5000);}
$('connect').onclick=()=>run(async()=>{
  wallet=providers[Number($('wallets').value)]?.provider;if(!wallet)throw Error('NO_WALLET');
  await wallet.request({method:'eth_requestAccounts'});await refreshWallet();
  const changed=()=>{estimate=null;account='';$('estimate-result').textContent='';status('ESTIMATE_AGAIN');buttons();};wallet.on?.('accountsChanged',changed);wallet.on?.('chainChanged',changed);
  const r=record();showRecord(r);if(r?.hash)await verify(r.hash,r.account);else status(r?.phase==='submitting'?'UNKNOWN':'READY');
});
$('refresh').onclick=()=>run(async()=>{await refreshWallet();const r=record();if(r?.hash)await verify(r.hash,r.account);else status('READY');});
$('estimate').onclick=()=>run(async()=>{
  const before=await identity(wallet),tx={from:before.account,data:manifest.bytecode,value:'0x0'};
  const raw=BigInt(await wallet.request({method:'eth_estimateGas',params:[tx]})),gas=(raw*120n+99n)/100n;
  const price=BigInt(await wallet.request({method:'eth_gasPrice'})),balance=BigInt(await wallet.request({method:'eth_getBalance',params:[before.account,'latest']}));
  const after=await identity(wallet);if(before.account.toLowerCase()!==after.account.toLowerCase())throw Error('ESTIMATE_AGAIN');
  if(balance<gas*price)throw Error('INSUFFICIENT_BALANCE');
  estimate={account:after.account,bytecodeHash:manifest.bytecodeHash,gas:ethers.toQuantity(gas),at:Date.now()};
  $('estimate-result').textContent=lang==='en'?`Account ${after.account} · estimated fee budget ${ethers.formatEther(gas*price)} tBNB (20% gas buffer). Review the final fee in MetaMask.`:`账号 ${after.account} · 估算手续费预算 ${ethers.formatEther(gas*price)} tBNB（含20% gas余量）。最终以 MetaMask 显示为准。`;
});
$('confirmation').oninput=buttons;
$('deploy-form').onsubmit=e=>{e.preventDefault();void run(async()=>{
  if(!navigator.locks)throw Error('LOCK_UNAVAILABLE');
  const r=await navigator.locks.request('escrow-test-token-deploy',{ifAvailable:true},async lock=>{if(!lock)throw Error('LOCKED');
    try{return await sendDeployment({wallet,manifest,estimate,confirmation:$('confirmation').value,storage:localStorage});}
    catch(e){const r=record();if(r?.phase==='submitting'){status('UNKNOWN');throw Error('UNKNOWN');}throw e;}
  });
  showRecord(r);status('PENDING');$('confirmation').value='';if(!await verify(r.hash,r.account))poll(r);
});};
$('recover-form').onsubmit=e=>{e.preventDefault();void run(async()=>{const current=await identity(wallet),r=record();const expected=r&&!['failed','rejected'].includes(r.phase)?r.account:current.account;const hash=$('recover-hash').value.trim();
  try{await verify(hash,expected);}catch(e){if(e.message==='DEPLOYMENT_REVERTED'&&r?.hash===hash){r.phase='failed';localStorage.setItem(RECORD_KEY,JSON.stringify(r));}throw e;}
});};
$('copy').onclick=()=>run(async()=>{await navigator.clipboard.writeText(verified.address);status('COPIED');});
$('import').onclick=()=>run(async()=>{await identity(wallet);await wallet.request({method:'wallet_watchAsset',params:{type:'ERC20',options:{address:verified.address,symbol:'TESTUSD',decimals:18}}});});
$('language').onchange=e=>{lang=e.target.value;localStorage.setItem('production-language',lang);render();status('READY');};
window.addEventListener('storage',e=>{if(e.key===RECORD_KEY){estimate=null;showRecord(record());buttons();}});
render();status('READY');
$('platform-replace').onclick=replacePlatform;
try{const saved=localStorage.getItem(WALLET_KEY);if(saved){showPlatform(saved);$('platform-status').textContent=text('WALLET_SAVED');}else platformButtons();}catch{$('platform-status').textContent=text('WALLET_BACKUP_INVALID');$('platform-create').disabled=true;}
try{const r=await fetch('/token.json');if(!r.ok)throw Error();manifest=await r.json();if(manifest.chainId!==97||ethers.keccak256(manifest.bytecode)!==manifest.bytecodeHash)throw Error();showRecord(record());if(record()?.phase==='submitting')status('UNKNOWN');buttons();}
catch{manifest=null;status('GENERIC');buttons();}
setTimeout(()=>{if(!providers.length)status('NO_WALLET');},1500);
$('gas-prepare').onclick=()=>payoutRun(async()=>{const r=selectedPayout();await payoutApi(r.id+'/gas-prepare',{});await loadPayouts();});
$('gas-sign-form').onsubmit=e=>{e.preventDefault();void payoutRun(async()=>{const r=selectedPayout(),g=selectedGas(),form=e.target,password=form.elements.password.value,confirmation=form.elements.confirmation.value;form.elements.password.value='';form.elements.confirmation.value='';
  if(confirmation!==WORD)throw Error('TYPE_TESTNET');validateGasPlan(g.plan,g.plan_hash,ethers);
  const file=$('payout-file').files?.[0];if(!file||file.size>32768)throw Error('WALLET_BACKUP_INVALID');const json=await file.text();
  const signed=await signGasLocally(g.plan,g.plan_hash,json,password,ethers,n=>{$('payout-status').textContent=(lang==='en'?'Local decryption: ':'本机解密：')+Math.round(n*100)+'%';});
  await payoutApi(r.id+'/gas-submit',{raw:signed.raw,planHash:g.plan_hash});await loadPayouts();$('payout-status').textContent=text('GAS_SIGNED');
});};
$('gas-broadcast-form').onsubmit=e=>{e.preventDefault();void payoutRun(async()=>{const r=selectedPayout(),confirmation=e.target.elements.confirmation.value;e.target.reset();await payoutApi(r.id+'/gas-broadcast',{confirmation});await loadPayouts();$('payout-status').textContent=text('GAS_BROADCAST');});};
let sweepBusy=false;
const sweepRows=()=>{const done=new Set((sweepState?.sweeps??[]).filter(w=>w.status==='CONFIRMED').map(w=>w.order_id)),rows=(sweepState?.eligible??[]).map(e=>({...e,sweep:(sweepState.sweeps??[]).find(w=>w.order_id===e.order_id&&['PREPARED','SIGNED','BROADCAST'].includes(w.status))}));return rows.filter(r=>!done.has(r.order_id));};
const selectedSweep=()=>sweepRows().find(r=>r.order_id===$('sweep-select').value);
function sweepButtons(){const r=selectedSweep(),w=r?.sweep;$('sweep-refresh').disabled=sweepBusy||!payoutCsrf;$('sweep-select').disabled=sweepBusy;$('sweep-prepare').disabled=sweepBusy||!r||Boolean(w&&w.status!=='PREPARED');$('sweep-sign').disabled=sweepBusy||w?.status!=='PREPARED';$('sweep-broadcast').disabled=sweepBusy||!['SIGNED','BROADCAST'].includes(w?.status);}
function sweepDetails(){const r=selectedSweep(),lines=[];if(sweepState?.configured)lines.push(`Treasury: ${sweepState.treasury}`,`Collected (ledger): ${ethers.formatUnits(sweepState.held,18)}`);
  if(!r)lines.push(lang==='en'?'No orders with fees to collect.':'暂无可归集手续费的订单。');
  else{lines.push(`Order: ${r.order_id}`,`State: ${r.state}`,`Source: ${r.deposit_address}`,`Fee: ${ethers.formatUnits(r.fee,18)}`);const w=r.sweep;if(w){const p=w.plan;lines.push(`Collection: ${w.status}`,`Nonce: ${p.nonce}`,`Gas limit: ${p.gasLimit}`,`Gas price (wei): ${p.gasPrice}`,`Maximum native fee: ${ethers.formatEther(BigInt(p.gasLimit)*BigInt(p.gasPrice))} ${MAINNET?'BNB':'tBNB'}`,`Plan hash: ${w.plan_hash}`);if(w.tx_hash)lines.push(`Tx: ${w.tx_hash}`);if(w.last_error)lines.push(w.last_error);}}
  if(sweepState?.confirmationError)lines.push(sweepState.confirmationError);$('sweep-details').textContent=lines.join('\n');sweepButtons();}
async function loadSweeps(){const old=$('sweep-select').value;sweepState=await payoutApi('sweeps');$('sweep-select').replaceChildren();for(const r of sweepRows()){const o=document.createElement('option');o.value=r.order_id;o.textContent=`${r.order_id.slice(0,8)} · ${r.sweep?.status??r.state}`;$('sweep-select').append(o);}if(sweepRows().some(r=>r.order_id===old))$('sweep-select').value=old;sweepDetails();}
async function sweepRun(fn){if(sweepBusy)return;sweepBusy=true;sweepButtons();try{await fn();}catch(e){$('sweep-status').textContent=messages[e.message]?text(e.message):(lang==='en'?'Collection incomplete. Check the panel and original transaction. ':'归集操作未完成：')+(lang==='en'?'':e.message);try{if(payoutCsrf)await loadSweeps();}catch{}}finally{sweepBusy=false;sweepButtons();}}
const connectPayouts=$('payout-connect').onclick;$('payout-connect').onclick=async()=>{await connectPayouts();if(payoutCsrf)await sweepRun(loadSweeps);};
$('sweep-select').onchange=sweepDetails;
$('sweep-refresh').onclick=()=>sweepRun(async()=>{const r=selectedSweep();if(r?.sweep?.tx_hash)await payoutApi('sweeps/'+r.order_id+'/reconcile',{});await loadSweeps();});
$('sweep-prepare').onclick=()=>sweepRun(async()=>{await payoutApi('sweeps/'+selectedSweep().order_id+'/prepare',{});await loadSweeps();});
$('sweep-sign-form').onsubmit=e=>{e.preventDefault();void sweepRun(async()=>{const r=selectedSweep(),w=r.sweep,form=e.target,password=form.elements.password.value,confirmation=form.elements.confirmation.value;form.elements.password.value='';form.elements.confirmation.value='';
  if(confirmation!==WORD)throw Error('TYPE_TESTNET');validateSweepPlan(w.plan,w.plan_hash,ethers);
  const file=$('sweep-file').files?.[0];if(!file||file.size>32768)throw Error('WALLET_BACKUP_INVALID');const json=await file.text();
  const signed=await signSweepLocally(w.plan,w.plan_hash,json,password,ethers,n=>{$('sweep-status').textContent=(lang==='en'?'Local decryption: ':'本机解密：')+Math.round(n*100)+'%';});
  await payoutApi('sweeps/'+r.order_id+'/submit',{raw:signed.raw,planHash:w.plan_hash});await loadSweeps();$('sweep-status').textContent=text('SWEEP_SIGNED');
});};
$('sweep-broadcast-form').onsubmit=e=>{e.preventDefault();void sweepRun(async()=>{const r=selectedSweep(),confirmation=e.target.elements.confirmation.value;e.target.reset();await payoutApi('sweeps/'+r.order_id+'/broadcast',{confirmation});await loadSweeps();$('sweep-status').textContent=text('SWEEP_BROADCAST');});};
sweepDetails();
$('replace-prepare').onclick=()=>payoutRun(async()=>{await payoutApi(selectedPayout().id+'/replace-prepare',{});await loadPayouts();});
$('replace-sign-form').onsubmit=e=>{e.preventDefault();void payoutRun(async()=>{const r=selectedPayout(),a=openReplacement(),form=e.target,password=form.elements.password.value,confirmation=form.elements.confirmation.value;form.elements.password.value='';form.elements.confirmation.value='';
  if(confirmation!==WORD)throw Error('TYPE_TESTNET');validatePayoutPlan(a.plan,a.plan_hash,ethers);
  // A speed-up may only change the gas price of the plan that was already reviewed and broadcast.
  const o=r.plan;for(const k of ['requestId','orderId','source','recipient','tokenContract','amount','nonce','data','gasLimit'])if(a.plan[k]!==o[k])throw Error('PAYOUT_PLAN_INVALID');if(BigInt(a.plan.gasPrice)<=BigInt(o.gasPrice))throw Error('PAYOUT_PLAN_INVALID');
  const file=$('payout-file').files?.[0];if(!file||file.size>32768)throw Error('WALLET_BACKUP_INVALID');const json=await file.text();
  const signed=await signPayoutLocally(a.plan,a.plan_hash,json,password,ethers,n=>{$('payout-status').textContent=(lang==='en'?'Local decryption: ':'本机解密：')+Math.round(n*100)+'%';});
  await payoutApi(r.id+'/replace-submit',{raw:signed.raw,planHash:a.plan_hash});await loadPayouts();$('payout-status').textContent=text('REPLACE_SIGNED');
});};
$('replace-broadcast-form').onsubmit=e=>{e.preventDefault();void payoutRun(async()=>{const r=selectedPayout(),confirmation=e.target.elements.confirmation.value;e.target.reset();await payoutApi(r.id+'/replace-broadcast',{confirmation});await loadPayouts();$('payout-status').textContent=text('REPLACE_BROADCAST');});};
if(MAINNET){
  $('mainnet-banner').hidden=false;Object.assign($('mainnet-banner').style,{background:'#b00020',color:'#fff',fontWeight:'600'});$('mainnet-banner').textContent=lang==='en'?'MAINNET · REAL FUNDS. Plans are signed for BNB Chain (56) with the mainnet platform wallet. Type MAINNET to sign or broadcast.':'主网 · 真实资金。计划按 BNB Chain（56）和主网平台钱包签名；签名和广播需输入 MAINNET。';
  for(const id of Object.keys(words))if(/^(payout|gas|replace|sweep)-/.test(id)&&$(id))$(id).textContent=$(id).textContent.replaceAll('TESTNET','MAINNET').replaceAll('测试网','主网').replaceAll('testnet','mainnet').replaceAll('tBNB','BNB').replaceAll('测试交易','交易').replaceAll('test transaction','transaction');
  for(const input of document.querySelectorAll('#payout-panel input[pattern="TESTNET"],#sweep-panel input[pattern="TESTNET"]'))input.pattern='MAINNET';
}
$('payout-login').href=API+'/';$('signer-network').value=NET;$('signer-network').onchange=e=>{localStorage.setItem('signer-network',e.target.value);location.reload();};
