import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';

export async function deployAssistant(port=8783){
  const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
  const artifact=JSON.parse(await readFile(resolve(root,'artifacts/test-token/TestEscrowToken.json'),'utf8'));
  if(artifact.chainId!==97||artifact.testOnly!==true||!/^([0-9a-f]{2})+$/i.test(artifact.evm?.bytecode?.object??'')||!/^([0-9a-f]{2})+$/i.test(artifact.evm?.deployedBytecode?.object??''))throw Error('Test token artifact invalid; compile it first');
  const bytecode='0x'+artifact.evm.bytecode.object,runtime='0x'+artifact.evm.deployedBytecode.object;
  const {keccak256}=await import('ethers');
  const manifest={chainId:97,name:'Escrow Test Token',symbol:'TESTUSD',decimals:18,supply:'1000000',abi:artifact.abi,bytecode,runtimeHash:keccak256(runtime),bytecodeHash:keccak256(bytecode)};
  const workspaceId=createHash('sha256').update(root.toLowerCase()).digest('hex').slice(0,24);
  const files={'/':['public/deploy-assistant/index.html','text/html'],'/app.js':['public/deploy-assistant/app.js','text/javascript'],'/core.js':['public/deploy-assistant/core.js','text/javascript'],'/style.css':['public/production/style.css','text/css'],'/ethers.js':['node_modules/ethers/dist/ethers.min.js','text/javascript']};
  const server=createServer(async(req,res)=>{
    res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self' http://127.0.0.1:8782 http://127.0.0.1:8784; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const address=server.address(),actual=address&&typeof address==='object'?address.port:port;
    try{
      if(![`127.0.0.1:${actual}`,`localhost:${actual}`].includes(req.headers.host??'')){res.writeHead(403).end();return;}
      if(req.method!=='GET'){res.writeHead(405).end();return;}
      const path=new URL(req.url??'/',`http://127.0.0.1:${actual}`).pathname;
      if(path==='/health'||path==='/token.json'){
        res.setHeader('Content-Type','application/json');res.end(JSON.stringify(path==='/health'?{ok:true,application:'escrow-testnet-deploy-assistant',workspaceId,chainId:97,serverSigning:false,mainnetEnabled:false}:manifest));return;
      }
      const file=files[path];if(!file){res.writeHead(404).end();return;}
      res.setHeader('Content-Type',file[1]+'; charset=utf-8');res.end(await readFile(resolve(root,file[0])));
    }catch{res.writeHead(500).end('Assistant unavailable');}
  });
  server.requestTimeout=10000;server.headersTimeout=10000;
  await new Promise((yes,no)=>{server.once('error',no);server.listen(port,'127.0.0.1',yes);});
  const address=server.address();return {server,url:`http://127.0.0.1:${address.port}/`,stop:()=>new Promise(resolve=>{server.closeIdleConnections();server.close(resolve);})};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const app=await deployAssistant();console.log(JSON.stringify({ready:true,url:app.url,chainId:97,serverSigning:false}));
  process.once('SIGINT',()=>void app.stop());process.once('SIGTERM',()=>void app.stop());
}
