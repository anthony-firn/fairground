/**
 * Credentials and trust. People list their own (shown as self-declared), vouch for people they know, and choose which
 * organisations' attestations count as verified (none by default: a background-check company, a licensing body…).
 */
import { useEffect, useState } from 'react';
import { npubEncode, decode } from 'nostr-tools/nip19';
import { createCredential, CREDENTIAL_TYPES, type CredentialType } from '@core/commerce.ts';
import { KIND } from '@core/kinds.ts';
import { Field, Name, Sheet, TopBar } from '../components/ui.tsx';
import { useApp } from '../context.ts';
import { useEvents } from '../lib/hooks.ts';
import { publish } from '../lib/net.ts';
import { load, save } from '../lib/storage.ts';

function CredentialForm({ subject, vouch, onClose }: { subject: string; vouch: boolean; onClose: () => void }) {
  const { account, toast } = useApp();
  const [type, setType] = useState<CredentialType>(vouch ? 'vouch' : 'drivers-license');
  const [note, setNote] = useState('');
  const [expires, setExpires] = useState('');
  async function submit() {
    try {
      await publish(createCredential(account.nostrKey, account.pq, {
        subject, type, note, expires: expires ? Math.floor(new Date(expires).getTime() / 1000) : undefined,
      }));
      toast(vouch ? 'Vouch published. People who follow you will see it.' : 'Added. It shows as self-declared until someone vouches or an issuer verifies it.');
      onClose();
    } catch (e) {
      toast((e as Error).message);
    }
  }
  return (
    <Sheet title={vouch ? 'Vouch' : 'Add a credential'} onClose={onClose}>
      {vouch && <p className="small">Vouch for <strong><Name pubkey={subject} /></strong> only if you know it’s true. It’s public and signed by you.</p>}
      <Field label="What">
        <select value={type} onChange={(e) => setType(e.target.value as CredentialType)}>
          {CREDENTIAL_TYPES.filter((c) => vouch || c.type !== 'vouch').map((c) => <option key={c.type} value={c.type}>{c.type === 'vouch' ? 'I recommend them' : c.label}</option>)}
        </select>
      </Field>
      <Field label="Details (optional)"><input type="text" value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} placeholder={vouch ? 'Drove me to the airport twice, always on time' : 'Class C, California'} /></Field>
      {!vouch && <Field label="Expires (optional)"><input type="text" value={expires} onChange={(e) => setExpires(e.target.value)} placeholder="2028-05-31" /></Field>}
      <button type="button" className="btn primary block" onClick={submit}>{vouch ? 'Publish vouch' : 'Add'}</button>
    </Sheet>
  );
}

export function useVouch(subject: string) {
  const [open, setOpen] = useState(false);
  return { open: () => setOpen(true), sheet: open ? <CredentialForm subject={subject} vouch onClose={() => setOpen(false)} /> : null };
}

export function CredentialsScreen() {
  const { account, navigate, toast } = useApp();
  const { events } = useEvents({ kinds: [KIND.credential], '#p': [account.pubkey], limit: 100 });
  const [adding, setAdding] = useState(false);
  const [issuers, setIssuers] = useState(() => load<string[]>('trustedIssuers', []));
  const [issuer, setIssuer] = useState('');
  useEffect(() => {
    save('trustedIssuers', issuers);
  }, [issuers]);
  const label = (t?: string) => CREDENTIAL_TYPES.find((c) => c.type === t)?.label ?? t;
  return (
    <>
      <TopBar title="Credentials and trust" back={() => navigate('/create')} />
      <div className="page">
        <p className="muted">Show people why they can trust you: a licence, insurance, a food handler card. What you add yourself shows as
          self-declared; it becomes vouched when people others follow vouch for you, and verified when an organisation the reader trusts attests it.</p>
        <button type="button" className="btn primary" onClick={() => setAdding(true)}>Add a credential</button>
        <div className="card list">
          {!events.length && <p className="small muted">Nothing yet.</p>}
          {events.map((ev) => (
            <div key={ev.id} className="row between" style={{ padding: '10px 4px' }}>
              <span className="small"><strong>{label(ev.tags.find((t) => t[0] === 'credential')?.[1])}</strong>{ev.content ? ` · ${ev.content}` : ''}</span>
              <span className="tiny muted">{ev.pubkey === account.pubkey ? 'self-declared' : <>by <Name pubkey={ev.pubkey} /></>}</span>
            </div>
          ))}
        </div>
        <h2>Organisations you trust</h2>
        <div className="card stack">
          <p className="small muted" style={{ margin: 0 }}>Their attestations show as verified for you. Add one only if you know it checks what it claims (for example a background-check company’s Nostr account).</p>
          {issuers.map((pk) => (
            <div key={pk} className="row between"><span className="small"><Name pubkey={pk} /> <span className="mono tiny">{npubEncode(pk).slice(0, 16)}…</span></span>
              <button type="button" className="btn ghost small" onClick={() => setIssuers(issuers.filter((x) => x !== pk))}>Remove</button></div>
          ))}
          <form className="row" onSubmit={(e) => {
            e.preventDefault();
            try {
              const d = decode(issuer.trim());
              if (d.type !== 'npub') throw new Error();
              setIssuers([...new Set([...issuers, d.data])]);
              setIssuer('');
            } catch {
              toast('Paste an npub.');
            }
          }}>
            <input type="text" value={issuer} onChange={(e) => setIssuer(e.target.value)} placeholder="npub1…" aria-label="Issuer npub" />
            <button type="submit" className="btn">Add</button>
          </form>
        </div>
      </div>
      {adding && <CredentialForm subject={account.pubkey} vouch={false} onClose={() => setAdding(false)} />}
    </>
  );
}
