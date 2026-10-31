/** Receiving crypto needs no banking provider. New wallets receive ALGO before they can receive native USDC. */
import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { USDC_ASSET_ID } from '@core/rails/algorand.ts';
import { useApp } from '../context.ts';
import { LOCAL_PILOT } from '../lib/pilot.ts';
import { useSettle, useWallet } from '../lib/wallet.ts';
import { Segmented, Sheet } from './ui.tsx';

export function CryptoFundingSheet({ onClose }: { onClose: () => void }) {
  const { account, navigate, toast } = useApp();
  const wallet = useWallet(account);
  const settle = useSettle(account, wallet.state);
  const [selected, setSelected] = useState<'ALGO' | 'USDC'>();
  const [provider, setProvider] = useState<'coinbase' | 'kraken' | 'other'>('coinbase');
  const [qr, setQr] = useState('');
  const [copied, setCopied] = useState(false);
  const active = wallet.state?.active === true;
  const asset = active ? selected ?? 'USDC' : 'ALGO';
  const link = `algorand://${wallet.address}${asset === 'USDC' ? `?asset=${USDC_ASSET_ID}` : ''}`;
  useEffect(() => {
    let stopped = false;
    setQr('');
    QRCode.toDataURL(link, { margin: 2, width: 360 }).then((value) => { if (!stopped) setQr(value); }, () => undefined);
    return () => { stopped = true; };
  }, [link]);
  const name = provider === 'coinbase' ? 'Coinbase' : provider === 'kraken' ? 'Kraken' : 'your wallet or exchange';
  return (
    <Sheet title="Transfer crypto to Fairground" onClose={onClose}>
      <p className="small">Already have crypto? Send it from an exchange or another wallet. This works independently of card checkout.</p>
      {LOCAL_PILOT && <p className="small warn">Preview address only. Do not send real funds to this test account.</p>}
      {!wallet.state && <p className="small muted">Checking whether your wallet can receive USDC… ALGO can be received first.</p>}
      {active ? (
        <>
          <p className="small good"><strong>USDC ready.</strong> Your wallet can receive native USDC on Algorand.</p>
          <Segmented value={asset} options={[["USDC", "USDC"], ["ALGO", "ALGO"]]} onChange={setSelected} />
        </>
      ) : <p className="card small"><strong>First deposit: ALGO.</strong> Your wallet needs ALGO before it can receive USDC. We’ll show “USDC ready” when setup finishes.</p>}
      <div className="card stack" style={{ gap: 6 }}>
        <strong>Asset: {asset}</strong>
        <strong>Network: Algorand (mainnet)</strong>
        <span className="tiny muted">{asset === 'USDC' ? 'Native USDC · asset ID 31566704' : 'Native ALGO'}</span>
        <label className="small">Your Fairground address
          <input type="text" readOnly value={wallet.address} className="mono" onFocus={(e) => e.currentTarget.select()} aria-label="Your Fairground address" />
        </label>
        <button type="button" className="btn primary block" onClick={async () => {
          try { await navigator.clipboard.writeText(wallet.address); setCopied(true); }
          catch { toast('Select the address above and copy it.'); }
        }}>{copied ? 'Address copied' : 'Copy address'}</button>
        <span className="tiny muted">No memo is needed to fund your own Fairground wallet.</span>
      </div>
      <Segmented value={provider} options={[["coinbase", "Coinbase"], ["kraken", "Kraken"], ["other", "Other"]]} onChange={setProvider} />
      <ol className="small stack" style={{ paddingLeft: 20, margin: 0 }}>
        <li>In {name}, choose <strong>Send</strong> or <strong>Withdraw</strong>, then select <strong>{asset}</strong>.</li>
        <li>Choose <strong>Algorand</strong> as the network and paste the address above. Review the destination, withdrawal minimum and fees.</li>
        <li>{asset === 'ALGO' ? <>Send ALGO and keep this page open. Fairground enables USDC and converts larger deposits to dollars, keeping a small ALGO reserve for network fees.</> : <>Send USDC. Your dollar balance updates when it arrives; you can then pay, support creators or donate.</>}</li>
      </ol>
      {asset === 'ALGO' && <p className="small">Send ALGO worth the balance you want to add, allowing for fees and the reserve. For a first deposit, allow at least <strong>2 ALGO to arrive after exchange fees</strong> so there is room for setup, a fee reserve and conversion. Your exchange may require more. Final conversion depends on the available exchange quote.</p>}
      {asset === 'USDC' && <p className="small">If {name} does not offer Algorand for USDC, choose ALGO above and send ALGO on Algorand instead.</p>}
      <p className="tiny warn">Use the Algorand network only. USDC on Ethereum, Base, Solana or another network cannot be received here.</p>
      {settle.status === 'working' && <p className="small"><span className="dot warn" /> Deposit received. Setting up your wallet and converting ALGO…</p>}
      {settle.status === 'error' && <p className="small warn">Your ALGO is in your wallet, but setup or conversion needs another try: {settle.error} <button type="button" className="btn small" onClick={settle.retry}>Retry setup or conversion</button></p>}
      {wallet.error && <p className="small warn">Couldn’t refresh the wallet: {wallet.error} <button type="button" className="btn small" onClick={wallet.refresh}>Refresh wallet</button></p>}
      <details className="small">
        <summary>Scan with another Algorand wallet</summary>
        {qr && <img className="qr" src={qr} alt={`QR code to receive ${asset} on Algorand in your Fairground wallet`} />}
        <a className="btn block" href={link}>Open in an Algorand wallet</a>
      </details>
      <p className="tiny muted">Before funding, save your Fairground account so you can restore this wallet. <button type="button" className="btn small" onClick={() => { onClose(); navigate('/account'); }}>Save account</button></p>
      <div className="row wrap tiny">
        {provider === 'coinbase' && <a href="https://help.coinbase.com/en/coinbase/trading-and-funding/sending-or-receiving-cryptocurrency/assets-on-multiple-networks" target="_blank" rel="noopener noreferrer">Coinbase network help ↗</a>}
        {provider === 'kraken' && <a href="https://blog.kraken.com/product/new-features/usdc-deposits-and-withdrawals-now-available-on-algorand" target="_blank" rel="noopener noreferrer">Kraken’s Algorand funding guide ↗</a>}
        <span className="muted">Available assets and networks depend on your exchange and location.</span>
      </div>
    </Sheet>
  );
}
