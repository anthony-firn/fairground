/** Local operator utility: keep mined development proceeds in USDC, with an ALGO operating reserve. */
import {readFile,lstat,mkdir,open,rename} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {DEVELOPMENT_ADDRESS} from '../src/defaults.ts';
import {walletKeys,walletState} from '../src/wallet.ts';
import {convertibleOnRequest,prepareWalletConversion,walletSignerProblem} from '../src/walletConversion.ts';
import {executeWalletConversion,resumeWalletConversion,type ConversionJournal,type ConversionStore} from '../src/conversionSession.ts';

const uid=process.getuid?.();if(uid===undefined)throw Error('The local operator utility requires a Unix user ID');
const dir=join(homedir(),'.local/share/evolve-bootstrap/treasury');
await mkdir(dir,{recursive:true,mode:0o700});
const info=await lstat(dir);if(info.isSymbolicLink()||info.uid!==uid||(info.mode&0o077))throw Error('Treasury state directory must be private and owned by this user');
if(process.env.FAIRGROUND_TREASURY_LOCKED!=='1'){
 const lock=await open(join(dir,'run.lock'),'a',0o600);await lock.close();
 try{execFileSync('/usr/bin/flock',['-n',join(dir,'run.lock'),process.execPath,fileURLToPath(import.meta.url),...process.argv.slice(2)],{stdio:'inherit',env:{...process.env,FAIRGROUND_TREASURY_LOCKED:'1'}});process.exit(0);}
 catch(error){process.exit((error as {status?:number}).status??1);}
}
async function privateJson(path:string):Promise<unknown>{
 const s=await lstat(path);if(s.isSymbolicLink()||s.uid!==uid||(s.mode&0o077))throw Error('Private wallet/state file permissions are invalid');
 try{return JSON.parse(await readFile(path,'utf8'));}catch{throw Error('Private wallet/state file could not be parsed');}
}
async function write(path:string,value:unknown){
 const temp=path+'.'+randomBytes(8).toString('hex')+'.tmp',f=await open(temp,'wx',0o600);
 try{await f.writeFile(JSON.stringify(value,null,2)+'\n');await f.sync();}finally{await f.close();}
 await rename(temp,path);
}
const store:ConversionStore={read:async()=>{
 try{return await privateJson(join(dir,'current.json')) as ConversionJournal;}
 catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;}
},write:async value=>{
 if(value.phase==='confirmed'){
  if(!/^[A-Z2-7]{52}$/.test(value.txids[0]))throw Error('Invalid receipt transaction ID');
  await mkdir(join(dir,'receipts'),{mode:0o700,recursive:true});await write(join(dir,'receipts',value.txids[0]+'.json'),value);
 }
 await write(join(dir,'current.json'),value);
}};
async function tick(){
 if(!DEVELOPMENT_ADDRESS)throw Error('No development recipient is configured');
 const pending=await store.read();
 if(pending&&pending.phase!=='confirmed'&&pending.phase!=='expired'){
  const result=await resumeWalletConversion(DEVELOPMENT_ADDRESS,store);console.log('Existing conversion:',result.phase,result.txids[0]);return;
 }
 const state=await walletState(DEVELOPMENT_ADDRESS);
 if(!state.active)throw Error('Development wallet must already be opted into native USDC');
 const problem=walletSignerProblem(state);if(problem)throw Error(problem);
 // Keep the existing automatic policy: small balances require an explicit user review.
 if(convertibleOnRequest(state)<1_000_000n){console.log('Waiting: less than 1 ALGO is available above the protected reserve and fee budget.');return;}
 const owner=await privateJson(join(homedir(),'.config/fairground/anthony-firn.json')) as {nostrKey?:string};
 if(!/^[a-fA-F0-9]{64}$/.test(owner.nostrKey??''))throw Error('Local owner account has an unsupported key format');
 const secret=Uint8Array.from(Buffer.from(owner.nostrKey!,'hex')),keys=walletKeys(secret);secret.fill(0);
 try{
  if(keys.address!==DEVELOPMENT_ADDRESS)throw Error('Local owner account does not control the configured development wallet');
  const plan=await prepareWalletConversion(state);
  const receipt=await executeWalletConversion(keys,plan,store);console.log('Stablecoin conversion:',receipt.phase,receipt.txids[0]);
 }finally{keys.seed.fill(0);}
}
const watch=process.argv.includes('--watch');
do{
 try{await tick();}catch(error){console.error('Treasury conversion deferred:',(error as Error).message);if(!watch)process.exitCode=1;}
 if(watch)await new Promise(resolve=>setTimeout(resolve,300000));
}while(watch);
