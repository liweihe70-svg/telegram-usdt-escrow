import solc from 'solc';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import {resolve,relative,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('../',import.meta.url));
const library=resolve(root,'node_modules/@openzeppelin/contracts');
const source=await readFile(resolve(root,'contracts/TestEscrowToken.sol'),'utf8');
const input={language:'Solidity',sources:{'TestEscrowToken.sol':{content:source}},settings:{optimizer:{enabled:true,runs:200},evmVersion:'paris',outputSelection:{'*':{'*':['abi','evm.bytecode.object','evm.deployedBytecode.object']}}}};
const output=JSON.parse(solc.compile(JSON.stringify(input),{import:path=>{
  const prefix='@openzeppelin/contracts@5.4.0/';if(!path.startsWith(prefix))return {error:'Unsupported dependency'};
  const file=resolve(library,path.slice(prefix.length)),inside=relative(library,file);
  if(inside.startsWith('..')||isAbsolute(inside))return {error:'Invalid dependency path'};
  try{return {contents:readFileSync(file,'utf8')};}catch{return {error:'Dependency not available'};}
}}));
const errors=(output.errors??[]).filter(e=>e.severity==='error');
if(errors.length){for(const e of errors)console.error(e.formattedMessage);process.exitCode=1;}
else{
  const contract=output.contracts['TestEscrowToken.sol'].TestEscrowToken;
  const directory=resolve(root,'artifacts/test-token');await mkdir(directory,{recursive:true});
  await writeFile(resolve(directory,'TestEscrowToken.json'),JSON.stringify({compiler:solc.version(),settings:input.settings,chainId:97,testOnly:true,...contract},null,2)+'\n');
  console.log(JSON.stringify({compiled:true,contract:'TestEscrowToken',compiler:solc.version(),evmVersion:'paris',optimizerRuns:200,decimals:18,initialSupply:'1000000',symbol:'TESTUSD',chainId:97,deployed:false,broadcast:false}));
}
