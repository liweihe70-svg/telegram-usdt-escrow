// Read-only capability check. Credentials and raw RPC errors are never printed.
const endpoint=process.env.BNB_RPC_URL??'https://bsc-testnet-dataseed.bnbchain.org';
async function call(method:string,params:unknown[]){
  try{
    const url=new URL(endpoint);if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw Error();
    const response=await fetch(endpoint,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),signal:AbortSignal.timeout(8000)});
    if(!response.ok)return {ok:false,code:`HTTP_${response.status}`,value:undefined};
    const data=await response.json() as {error?:{code:number};result?:unknown};
    if(data.error)return {ok:false,code:`RPC_${data.error.code}`,value:undefined};
    return {ok:true,code:null,value:data.result};
  }catch{return {ok:false,code:'CONNECTION_OR_RESPONSE_ERROR',value:undefined};}
}
const network=await call('eth_chainId',[]);
if(!network.ok||network.value!=='0x61'){
  console.log(JSON.stringify({ready:false,readOnly:true,reason:'BNB_TESTNET_97_REQUIRED',code:network.code}));process.exitCode=1;
}else{
  const finalized=await call('eth_getBlockByNumber',['finalized',false]);
  const block=finalized.value as {number?:string;hash?:string}|null;
  const validBlock=finalized.ok&&Boolean(block?.hash)&&/^0x[0-9a-f]+$/i.test(block?.number??'');
  const logs=validBlock?await call('eth_getLogs',[{fromBlock:block!.number,toBlock:block!.number,address:'0x1111111111111111111111111111111111111111'}]):{ok:false,code:'FINALIZED_UNAVAILABLE',value:undefined};
  const logsSupported=logs.ok&&Array.isArray(logs.value),ready=validBlock&&logsSupported;
  console.log(JSON.stringify({ready,readOnly:true,chainId:97,source:process.env.BNB_RPC_URL?'local-configuration':'official-public-default',finalizedSupported:validBlock,logsSupported,finalizedError:finalized.code,logsError:logs.code,tokenContractValidated:false,broadcastEnabled:false}));
  if(!ready)process.exitCode=1;
}
export {};
