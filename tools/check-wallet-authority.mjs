/** Read-only mainnet authority diagnostic. No wallet files, keys, signatures or submissions. */
import {ed25519} from '@noble/curves/ed25519.js';
import {decodeAddress} from 'algosdk';
import {DEVELOPMENT_ADDRESS} from '../src/defaults.ts';

const address=process.argv[2]??DEVELOPMENT_ADDRESS;
if(!address)throw Error('Provide an Algorand address.');
decodeAddress(address); // Reject malformed addresses before making a network request.
const base='https://mainnet-api.4160.nodely.dev';
async function get(path){
 const r=await fetch(base+path,{redirect:'error',signal:AbortSignal.timeout(15000)});
 if(!r.ok)throw Error(`Public mainnet request failed (${r.status}).`);
 return r.json();
}
const [account,params]=await Promise.all([get('/v2/accounts/'+address),get('/v2/transactions/params')]);
if(params['genesis-id']!=='mainnet-v1.0')throw Error('Unexpected network.');
const authority=account['auth-addr']??address;
const authorityKey=decodeAddress(authority).publicKey;
let onCurve=false;
try{ed25519.Point.fromBytes(authorityKey);onCurve=true;}catch{}
console.log(JSON.stringify({address,authority,rekeyed:authority!==address,
 authorityIsEd25519CurvePoint:onCurve,
 assessment:onCurve?'Classical-curve authority: not post-quantum protected.':'Off-curve authority: this alone does not establish Falcon signing or secure recovery.',
 usdcReady:(account.assets??[]).some(a=>a['asset-id']===31566704&&a['is-frozen']===false),
 mainnetRound:params['last-round'],
 migrationChecksRequired:['Compatible Falcon signer and canonical off-curve authority','Independent private recovery backup and restoration rehearsal','Supported network protocol and correct fees','Conversions, payments and pending-transaction recovery compatible with replacement authority'],
 action:'Read-only check completed; no signing authority changed.'},null,2));
