import {randomUUID} from 'node:crypto';
import type {AuthDatabase} from './admin-auth.js';
import {applyOverrides,brand,supportUsername,defaultLanguage,limits,isMainnet,welcomeExtras,type PlatformOverrides} from './network.js';
import {tokenAmount} from './amounts.js';

type Row={brand:string|null;support_username:string|null;default_language:'zh'|'en'|null;max_order:string|null;max_custody:string|null;fee_min:string|null;fee_bps:number|null;welcome_media:string|null;updates_url:string|null;vouches_url:string|null};
const AMOUNT=/^\d{1,12}(\.\d{1,6})?$/;
export async function loadPlatformSettings(db:AuthDatabase){
  const r=(await db.query<Row>('SELECT brand,support_username,default_language,max_order,max_custody,fee_min,fee_bps,welcome_media,updates_url,vouches_url FROM production_platform_settings WHERE id=1')).rows[0];
  const o:PlatformOverrides=r?{brand:r.brand,support:r.support_username,language:r.default_language,maxOrder:r.max_order,maxCustody:r.max_custody,feeMin:r.fee_min,feeBps:r.fee_bps,welcomeMedia:r.welcome_media,updatesUrl:r.updates_url,vouchesUrl:r.vouches_url}:{};
  applyOverrides(o);return effective();
}
// What the bot is using right now, after panel overrides and env defaults.
export function effective(){
  const cap=limits();
  const extras=welcomeExtras();
  return {welcomeMedia:extras.media,updatesUrl:extras.updates,vouchesUrl:extras.vouches,brand:brand(),supportUsername:supportUsername(),defaultLanguage:defaultLanguage(),maxOrder:cap.maxOrder===null?'none':tokenAmount(cap.maxOrder),maxCustody:cap.maxCustody===null?'none':tokenAmount(cap.maxCustody),feeMin:cap.feeMin,feeBps:cap.feeBps,capsApply:isMainnet()};
}
export async function savePlatformSettings(db:AuthDatabase,adminId:string,input:Record<string,unknown>){
  const text=(v:unknown)=>typeof v==='string'?v.trim():'';
  const name=text(input.brand);if(name.length<1||name.length>40)throw Error('品牌名须为1至40个字符');
  const support=text(input.supportUsername).replace(/^@/,'');if(support&&!/^[a-zA-Z0-9_]{5,32}$/.test(support))throw Error('客服用户名须为5至32位字母、数字或下划线（不含 @）');
  const language=input.defaultLanguage;if(language!=='zh'&&language!=='en')throw Error('默认语言只能是中文或英文');
  const cap=(v:unknown,label:string)=>{const s=text(v).toLowerCase();if(s==='none'||s==='0'||s==='')return 'none';if(!AMOUNT.test(s)||Number(s)<=0)throw Error(`${label}须为正数，或填 none 表示不限`);return s;};
  const maxOrder=cap(input.maxOrder,'单笔上限'),maxCustody=cap(input.maxCustody,'托管总额上限');
  const feeMin=text(input.feeMin);if(!AMOUNT.test(feeMin))throw Error('最低手续费须为不小于0的数字');
  const feeBps=Number(input.feeBps);if(!Number.isInteger(feeBps)||feeBps<0||feeBps>10000)throw Error('手续费率须为0至10000基点（100 = 1%）');
  const link=(v:unknown,label:string,max:number)=>{const s=text(v);if(s&&(!/^https:\/\/[^\s"<>]+$/.test(s)||s.length>max))throw Error(`${label}须为 https:// 开头的链接，或留空`);return s;};
  const welcomeMedia=link(input.welcomeMedia,'欢迎媒体',508),updatesUrl=link(input.updatesUrl,'UPDATES 链接',308),vouchesUrl=link(input.vouchesUrl,'VOUCHES 链接',308);
  await db.transaction(async tx=>{
    if(!(await tx.query("SELECT id FROM production_admins WHERE id=$1 AND role='OWNER' AND disabled=false",[adminId])).rows.length)throw Error('仅负责人可修改平台设置');
    await tx.query('UPDATE production_platform_settings SET brand=$1,support_username=$2,default_language=$3,max_order=$4,max_custody=$5,fee_min=$6,fee_bps=$7,welcome_media=$8,updates_url=$9,vouches_url=$10,updated_at=now() WHERE id=1',[name,support,language,maxOrder,maxCustody,feeMin,feeBps,welcomeMedia,updatesUrl,vouchesUrl]);
    await tx.query("INSERT INTO production_admin_audit(id,actor_id,action,target_id) VALUES($1,$2,'PLATFORM_SETTINGS_UPDATED',$3)",[randomUUID(),adminId,JSON.stringify({maxOrder,maxCustody,feeMin,feeBps})]);
  });
  return loadPlatformSettings(db);
}
