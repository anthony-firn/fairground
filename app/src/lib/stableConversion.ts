/** Conversion journals are mandatory; settings' best-effort persistence is unsuitable for pending payments. */
import type {ConversionJournal,ConversionStore} from '@core/conversionSession.ts';

export function readConversion(address:string):ConversionJournal|null {
  const raw=localStorage.getItem('fairground.wallet-conversion-'+address);
  if(raw===null)return null;
  try{return JSON.parse(raw) as ConversionJournal;}catch{throw Error('The saved conversion cannot be read. Check its transaction before starting another.');}
}

export function conversionStore(address:string):ConversionStore {
  return {read:async()=>readConversion(address),write:async value=>{
    const text=JSON.stringify(value),key='fairground.wallet-conversion-'+address;
    try{localStorage.setItem(key,text);if(localStorage.getItem(key)!==text)throw Error();}
    catch{throw Error('Conversion state could not be saved. Enable browser storage before continuing.');}
  }};
}

const active=new Set<string>();
export async function conversionLock<T>(address:string,run:()=>Promise<T>):Promise<T>{
  if(navigator.locks)return navigator.locks.request('fairground-conversion-'+address,run);
  if(active.has(address))throw Error('A conversion is already running in this tab.');
  active.add(address);try{return await run();}finally{active.delete(address);}
}
