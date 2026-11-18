/** Shared public instructions contain no account credentials or signing actions. */
export function WalletSetupLink() {
  return (
    <a className="card stack small" href="https://www.evolvetech.dev/wallet-setup/" target="_blank" rel="noopener noreferrer">
      <strong>Wallet setup, step by step ↗</strong>
      <span>Save your account, find your address, transfer ALGO and check when your digital dollars are ready.</span>
    </a>
  );
}
