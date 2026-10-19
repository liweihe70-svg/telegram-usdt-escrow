import { readFile, writeFile, rename } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { units } from './escrow.js';
export const LOCAL_ADMIN='9223372036854775806';
export interface Settings { token:string; brand:string; minimumFee:string; feeBps:number; admins:string[] }
export class LocalSettings {
  constructor(private path='.env'){}
  async load():Promise<Settings>{
    let env:ReturnType<typeof parseEnv>={};
    try{env=parseEnv(await readFile(this.path,'utf8'));}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    return {token:env.TELEGRAM_BOT_TOKEN??'',brand:env.BOT_BRAND??'USDT 交易担保',minimumFee:env.FEE_MIN_USDT??'5',feeBps:Number(env.FEE_BPS??'500'),admins:(env.ADMIN_TELEGRAM_IDS??'').split(',').map(s=>s.trim()).filter(Boolean)};
  }
  async public(){const s=await this.load();return {brand:s.brand,minimumFee:s.minimumFee,feeBps:s.feeBps,admins:s.admins,tokenConfigured:!!s.token,mode:'simulation'};}
  async save(input:{brand:string;minimumFee:string;feeBps:number;admins:string[];token?:string;clearToken?:boolean}){
    if(typeof input.brand!=='string' || !input.brand.trim() || input.brand.length>60 || /[\r\n]/.test(input.brand))throw new Error('品牌名称须为1至60字');
    units(input.minimumFee);
    if(!Number.isSafeInteger(input.feeBps) || input.feeBps<0 || input.feeBps>10000)throw new Error('费率须在0至100%之间');
    if(!Array.isArray(input.admins) || input.admins.length>20 || input.admins.some(id=>typeof id!=='string' || !/^[1-9]\d{0,15}$/.test(id) || !Number.isSafeInteger(Number(id))))throw new Error('管理员须为有效 Telegram 数字 ID');
    const old=await this.load(),token=input.clearToken?'':input.token?.trim() || old.token;
    if(token && !/^\d+:[a-zA-Z0-9_-]{20,}$/.test(token))throw new Error('Token 格式不正确');
    let extra:ReturnType<typeof parseEnv>={};try{extra=parseEnv(await readFile(this.path,'utf8'));}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    const env={...extra,TELEGRAM_BOT_TOKEN:token,BOT_BRAND:input.brand.trim(),FEE_MIN_USDT:input.minimumFee,FEE_BPS:String(input.feeBps),ADMIN_TELEGRAM_IDS:[...new Set(input.admins)].join(',')};
    const contents='# 本机私有配置，请勿提交或分享\n'+Object.entries(env).map(([key,value])=>`${key}=${JSON.stringify(value)}`).join('\n')+'\n';
    await writeFile(this.path+'.tmp',contents,{mode:0o600});await rename(this.path+'.tmp',this.path);
    return this.public();
  }
}
