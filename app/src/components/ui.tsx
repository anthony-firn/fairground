import { useEffect, type ReactNode } from 'react';
import { useProfile } from '../lib/hooks.ts';
import { displayName } from '../lib/format.ts';

const paths: Record<string, string> = {
  home: 'M3 11.5 12 4l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z',
  plus: 'M12 5v14M5 12h14',
  spark: 'M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6',
  user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0',
  heart: 'M12 20s-7-4.4-9-9a5 5 0 0 1 9-3 5 5 0 0 1 9 3c-2 4.6-9 9-9 9z',
  info: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 16v-5M12 8h.01',
  less: 'M5 12h14M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z',
  back: 'M15 18l-6-6 6-6',
  chevron: 'M9 18l6-6-6-6',
  check: 'M5 12l5 5L20 7',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  bag: 'M6 7h12l1 13H5zM9 7a3 3 0 0 1 6 0',
  photo: 'M4 6h16v12H4zM8 14l3-3 5 5M15 10h.01',
  play: 'M8 5v14l11-7z',
  shorts: 'M8 3h8a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zM10.5 9v6l4.5-3z',
  headphones: 'M4 15v-3a8 8 0 0 1 16 0v3M4 15h3v5H4zM17 15h3v5h-3z',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-4-4',
  receipt: 'M6 3h12v18l-3-2-3 2-3-2-3 2zM9 8h6M9 12h6',
  wallet: 'M4 7h15a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1zM4 7l12-3v3M16 13h.01',
  comment: 'M21 12a8 8 0 0 1-11.6 7.1L4 21l1.9-5.4A8 8 0 1 1 21 12z',
  up: 'M12 19V5M5 12l7-7 7 7',
  down: 'M12 5v14M19 12l-7 7-7-7',
};

export function Icon({ name, filled }: { name: keyof typeof paths | string; filled?: boolean }) {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill={filled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={paths[name]} />
    </svg>
  );
}

export function Avatar({ pubkey, large, onClick }: { pubkey: string; large?: boolean; onClick?: () => void }) {
  const profile = useProfile(pubkey);
  const name = displayName(pubkey, profile);
  const className = `avatar${large ? ' large' : ''}`;
  const inner = profile?.picture
    ? <img src={profile.picture} alt="" className={className} loading="lazy" referrerPolicy="no-referrer" />
    : <span aria-hidden="true">{name.replace(/^npub1/, '').slice(0, 1).toUpperCase()}</span>;
  return onClick
    ? <button type="button" className={className} onClick={onClick} aria-label={`${name}’s profile`}>{inner}</button>
    : <span className={className}>{inner}</span>;
}

export function Name({ pubkey }: { pubkey: string }) {
  return <>{displayName(pubkey, useProfile(pubkey))}</>;
}

export function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="sheet-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sheet" role="dialog" aria-modal="true" aria-label={title}>
        <div className="row between">
          <h2>{title}</h2>
          <button type="button" className="btn ghost small" onClick={onClose}>Close</button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function TopBar({ title, back, children }: { title: ReactNode; back?: () => void; children?: ReactNode }) {
  return (
    <header className="topbar">
      {back && <button type="button" className="icon-btn" onClick={back} aria-label="Back"><Icon name="back" /></button>}
      <h1>{title}</h1>
      {children}
    </header>
  );
}

/** A labelled control. The hint sits outside the label, so it isn't read out as part of the control's name. */
export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="field">
      <label>
        <span>{label}</span>
        {children}
      </label>
      {hint && <small>{hint}</small>}
    </div>
  );
}

export function Segmented<T extends string>({ value, options, onChange }: { value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return (
    <div className="segmented" role="group">
      {options.map(([v, label]) => (
        <button key={v} type="button" aria-pressed={v === value} onClick={() => onChange(v)}>{label}</button>
      ))}
    </div>
  );
}

export function Meter({ fraction }: { fraction: number }) {
  return <div className="meter" role="presentation"><i style={{ width: `${Math.max(0, Math.min(1, fraction)) * 100}%` }} /></div>;
}
