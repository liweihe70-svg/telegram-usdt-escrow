// Fault injector for the isolated test fixture only. Does not load configuration or Telegram.
import {resolve,relative,isAbsolute} from 'node:path';
import {writeFile} from 'node:fs/promises';
import {Escrow,TEST_NETWORK} from '../src/escrow.js';
const root=resolve(process.argv[2]??''),base=resolve('data'),child=relative(base,root);
if(!child||isAbsolute(child)||child.startsWith('..')||!child.startsWith('qa-stability-'))throw Error('Invalid fault-test directory');
const e=await Escrow.open(root);
const o=await e.create({kind:'PRODUCT',buyerId:'1001',sellerId:'1002',principal:'100',fee:'5',buyerAddress:'sim:b',sellerAddress:'sim:s',description:'Synthetic crash fixture'});
await e.accept(o.id,'1001',1);await e.accept(o.id,'1002',1);
await e.deposit(o.id,{network:TEST_NETWORK,token:'SIM_USDT',txHash:'simtx:crash_fixture',eventIndex:0,amount:'105',confirmed:true,success:true,to:o.deposit_address});
await e.act(o.id,'1002','DECLARE');await e.act(o.id,'1001','RELEASE');const [p]=await e.broadcast(o.id);
await writeFile(resolve(root,'fault-result.json'),JSON.stringify({orderId:o.id,payoutId:p.id,txHash:p.tx_hash}));
// Deliberately exits this disposable child before closing the database.
process.exit(23);
