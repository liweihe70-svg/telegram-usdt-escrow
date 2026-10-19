import {readFile,mkdir,lstat} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {PostgresDatabase} from './postgres.js';
import type {AuthDatabase} from './admin-auth.js';

export interface ProductionDatabase extends AuthDatabase {close():Promise<void>}
export async function migrateProduction(db:AuthDatabase,postgresLock=false){
  await db.transaction(async tx=>{
    if(postgresLock)await tx.query('SELECT pg_advisory_xact_lock(735291804)');
    for(const name of ['001_admin.sql','002_orders.sql','003_telegram.sql','004_wallets.sql','005_payouts.sql','006_cases.sql','007_gas.sql','008_sweeps.sql','009_replacements.sql','010_timeouts.sql','011_case_files.sql','012_groups.sql','013_network.sql','014_group_deals.sql','015_open_trading.sql','016_group_language.sql','017_runtime_alerts.sql','018_manual_review.sql','019_refund_origin.sql','020_platform_settings.sql','021_welcome_settings.sql','022_automation.sql','023_open_amount.sql','024_welcome_image.sql','025_revenue_address.sql','026_fixed_custody.sql','027_deal_terms.sql','028_party_usernames.sql'])await tx.exec(await readFile(new URL(`../../../db/production/${name}`,import.meta.url),'utf8'));
  });
}
export async function productionDatabase(databaseUrl:string|undefined,directory:string){
  let database:ProductionDatabase;
  if(databaseUrl){
    const url=new URL(databaseUrl);if(!['postgres:','postgresql:'].includes(url.protocol)||['/postgres','/template0','/template1','/'].includes(url.pathname))throw Error('请配置独立 PostgreSQL 数据库');
    database=PostgresDatabase.open({connectionString:databaseUrl}).database;
  }else{
    await mkdir(directory,{recursive:true});if((await lstat(directory)).isSymbolicLink())throw Error('数据目录不能是链接');
    const local=new PGlite(directory);await local.waitReady;database=local as unknown as ProductionDatabase;
  }
  try{await migrateProduction(database,Boolean(databaseUrl));return {database,engine:databaseUrl?'postgresql':'pglite-local'};}catch(error){await database.close();throw error;}
}
