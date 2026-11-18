import assert from 'node:assert/strict';
import {test} from 'node:test';
import {nsecEncode} from 'nostr-tools/nip19';
import {parseAccountBackup} from '../src/accountBackup.ts';

test('full backups restore both keys; damaged PQ recovery never silently rotates identity',()=>{
 const key=new Uint8Array(32).fill(7),nsec=nsecEncode(key),seed='ab'.repeat(32);
 const restored=parseAccountBackup(`fairground:${nsec}:${seed}`);
 assert.deepEqual(restored.nostrKey,key);assert.deepEqual(restored.pqSeed,new Uint8Array(32).fill(171));
 for(const bad of [`fairground:${nsec}`,`fairground:${nsec}:`, `fairground:${nsec}:ab`,`fairground:${nsec}:${'zz'.repeat(32)}`,`fairground:${nsec}:${seed}:extra`,`${nsec}:extra`])assert.throws(()=>parseAccountBackup(bad),/incomplete or damaged/);
 assert.equal(parseAccountBackup(nsec).pqSeed,undefined,'explicit bare-nsec import remains distinct from a full recovery');
});
