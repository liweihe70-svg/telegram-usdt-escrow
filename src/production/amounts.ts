// BEP20 amounts are stored as integer strings. Never use JS Number for balances.
export const BNB_USDT_DECIMALS = 18;
export const UINT256_MAX = (1n << 256n) - 1n;
export function tokenUnits(value:string, decimals=BNB_USDT_DECIMALS):bigint {
  if(!Number.isInteger(decimals)||decimals<0||decimals>36)throw Error('Invalid token precision');
  if(typeof value!=='string'||value.length>100||!/^\d+(?:\.\d+)?$/.test(value))throw Error('Invalid amount');
  const [whole,fraction='']=value.split('.');
  if(fraction.length>decimals)throw Error('Amount exceeds token precision');
  const result=BigInt(whole)*10n**BigInt(decimals)+BigInt(fraction.padEnd(decimals,'0')||'0');
  if(result>UINT256_MAX)throw Error('Amount exceeds uint256');
  return result;
}
export function tokenAmount(value:bigint,decimals=BNB_USDT_DECIMALS):string {
  if(value<0n||value>UINT256_MAX||!Number.isInteger(decimals)||decimals<0||decimals>36)throw Error('Invalid amount');
  if(decimals===0)return value.toString();
  const scale=10n**BigInt(decimals);
  const fraction=(value%scale).toString().padStart(decimals,'0').replace(/0+$/,'');
  return (value/scale).toString()+(fraction?'.'+fraction:'');
}
// Splits an amount already received into principal and fee, so that principal+fee(principal) fits and
// the remainder goes to the fee. Amounts not above the minimum fee have no principal yet.
export function splitTotal(total:bigint,minimumFee:string,feeBps:number){
  if(!Number.isSafeInteger(feeBps)||feeBps<0||feeBps>10000)throw Error('Invalid fee rate');
  const minimum=tokenUnits(minimumFee),fee=(p:bigint)=>{const proportional=(p*BigInt(feeBps)+9999n)/10000n;return minimum>proportional?minimum:proportional;};
  if(total<=minimum)return {principal:'0',fee:total.toString(),total:total.toString()};
  let principal=total-minimum;
  if(principal+fee(principal)>total){principal=total*10000n/(10000n+BigInt(feeBps));while(principal>0n&&principal+fee(principal)>total)principal--;}
  return {principal:principal.toString(),fee:(total-principal).toString(),total:total.toString()};
}
export function quote(principal:string,minimumFee:string,feeBps:number) {
  if(!Number.isSafeInteger(feeBps)||feeBps<0||feeBps>10000)throw Error('Invalid fee rate');
  const amount=tokenUnits(principal),minimum=tokenUnits(minimumFee);
  if(amount===0n)throw Error('Principal must be positive');
  const proportional=(amount*BigInt(feeBps)+9999n)/10000n;
  const fee=minimum>proportional?minimum:proportional;
  if(amount+fee>UINT256_MAX)throw Error('Total exceeds uint256');
  return {principal:amount.toString(),fee:fee.toString(),total:(amount+fee).toString()};
}
