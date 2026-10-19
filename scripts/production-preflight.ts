import {BnbReader} from '../src/production/bnb-reader.js';
import {BNB_USDT_CONTRACT,chainPolicy} from '../src/production/bep20.js';
import {PostgresDatabase} from '../src/production/postgres.js';
import {migrateProduction} from '../src/production/database.js';

const mode=process.argv.includes('--migrate')?'migrate':'check';
const databaseUrl=process.env.PRODUCTION_DATABASE_URL;
const rpc=process.env.BNB_RPC_URL;
const chainId=Number(process.env.BNB_CHAIN_ID??97);
const token=process.env.BNB_TOKEN_CONTRACT??(chainId===56?BNB_USDT_CONTRACT:'');
if(!databaseUrl||!rpc||!token){
  console.log(JSON.stringify({ready:false,missing:[!databaseUrl?'PRODUCTION_DATABASE_URL':null,!rpc?'BNB_RPC_URL':null,!token?'BNB_TOKEN_CONTRACT (testnet)':null].filter(Boolean),broadcastEnabled:false}));
  process.exitCode=1;
}else{
  let reader:BnbReader|undefined;
  let database:PostgresDatabase|undefined;
  try{
    const parsed=new URL(databaseUrl);
    if(!['postgres:','postgresql:'].includes(parsed.protocol))throw Error('PostgreSQL is required');
    if(!parsed.pathname||['/postgres','/template0','/template1','/'].includes(parsed.pathname))throw Error('Dedicated application database is required');
    const policy=chainPolicy(chainId,token);
    reader=new BnbReader(rpc,policy);
    const runtime=PostgresDatabase.open({connectionString:databaseUrl});database=runtime.database;
    await database.query('SELECT 1');
    const chain=await reader.preflight();
    if(mode==='migrate'){
      await migrateProduction(database,true);
    }
    console.log(JSON.stringify({ready:true,mode,chain,broadcastEnabled:false,database:'connected',backgroundError:runtime.hasBackgroundError()}));
  }catch{
    console.log(JSON.stringify({ready:false,error:'Production preflight failed. Check local database/RPC configuration and required capabilities.',broadcastEnabled:false}));
    process.exitCode=1;
  }finally{reader?.close();await database?.close();}
}
