import {tokenUnits} from './amounts.js';

// One process serves exactly one network. The testnet and mainnet instances use separate databases,
// configuration files, ports and Telegram bots, so test data and real funds never share a ledger.
export type NetworkName='testnet'|'mainnet';
export type ChainId=97|56;
let current:NetworkName='testnet';
export function configureNetwork(value:string|undefined){
  if(value===undefined||value==='')value='testnet';
  if(value!=='testnet'&&value!=='mainnet')throw Error('PRODUCTION_NETWORK 只能是 testnet 或 mainnet');
  current=value;
}
export const network=():NetworkName=>current;
export const chain=():ChainId=>current==='mainnet'?56:97;
export const isMainnet=()=>current==='mainnet';
export const instanceFiles=()=>current==='mainnet'
  ?{port:8784,dataDir:'data/production-mainnet',serviceDir:'data/production-mainnet-service',envFile:'.env.mainnet'}
  :{port:8782,dataDir:'data/production-local',serviceDir:'data/production-service',envFile:'.env.production'};
// Values saved in the admin panel override the env file; null/undefined falls back to env or the default.
export interface PlatformOverrides{brand?:string|null;support?:string|null;language?:'zh'|'en'|null;maxOrder?:string|null;maxCustody?:string|null;feeMin?:string|null;feeBps?:number|null;welcomeMedia?:string|null;updatesUrl?:string|null;vouchesUrl?:string|null}
let overrides:PlatformOverrides={};
export function applyOverrides(value:PlatformOverrides){overrides={...value};}
// Mainnet starts with small, explicit limits unless an administrator changes them.
export function limits(env:Record<string,string|undefined>=process.env){
  // "none" or 0 switches a cap off.
  const read=(key:string,saved:string|null|undefined,fallback:string)=>{const v=(saved??env[key]??fallback).trim().toLowerCase();if(v==='none'||v==='0')return null;if(!/^\d+(\.\d{1,18})?$/.test(v))throw Error(`${key} 必须是正数或 none`);return tokenUnits(v);};
  const feeMin=overrides.feeMin??env.PRODUCTION_FEE_MIN_USDT,feeBps=overrides.feeBps??(env.PRODUCTION_FEE_BPS===undefined?undefined:Number(env.PRODUCTION_FEE_BPS));
  return current==='mainnet'
    ?{maxOrder:read('PRODUCTION_MAX_ORDER_USDT',overrides.maxOrder,'20'),maxCustody:read('PRODUCTION_MAX_CUSTODY_USDT',overrides.maxCustody,'100'),feeMin:feeMin??'1',feeBps:feeBps??100}
    :{maxOrder:null,maxCustody:null,feeMin:feeMin??'5',feeBps:feeBps??500};
}
export const confirmWord=()=>current==='mainnet'?'MAINNET':'TESTNET';
// Language for users and groups that have not chosen one; the mainnet instance is English-first.
export const defaultLanguage=():'zh'|'en'=>{const v=overrides.language??process.env.PRODUCTION_DEFAULT_LANGUAGE;return v==='zh'||v==='en'?v:current==='mainnet'?'en':'zh';};
export const brand=()=>(overrides.brand??process.env.PRODUCTION_BOT_BRAND??'').trim().slice(0,40)||'Escrow';
// Telegram username (without @) users can contact for help or arbitration; optional.
export const supportUsername=()=>{const v=(overrides.support??process.env.PRODUCTION_SUPPORT_USERNAME??'').trim().replace(/^@/,'');return /^[a-zA-Z0-9_]{5,32}$/.test(v)?v:'';};
// Optional /start extras configured in the panel; empty means not shown.
export const welcomeExtras=()=>({media:overrides.welcomeMedia??'',updates:overrides.updatesUrl??'',vouches:overrides.vouchesUrl??''});
