/** Parse recovery without silently replacing a damaged post-quantum identity. */
import {hexToBytes} from '@noble/hashes/utils.js';
import {decode} from 'nostr-tools/nip19';

export function parseAccountBackup(code:string):{nostrKey:Uint8Array;pqSeed?:Uint8Array}{
 const parts=code.trim().split(':');
 const full=parts[0]==='fairground';
 if((full&&(parts.length!==3||!/^([0-9a-f]{2}){32}$/i.test(parts[2])))||(!full&&parts.length!==1)){
  throw Error('That backup is incomplete or damaged. Use the complete backup code; its post-quantum identity will not be replaced automatically.');
 }
 const decoded=decode(full?parts[1]:parts[0]);
 if(decoded.type!=='nsec')throw Error('That isn’t a backup code or an nsec key.');
 return {nostrKey:decoded.data,...(full?{pqSeed:hexToBytes(parts[2])}:{})};
}
