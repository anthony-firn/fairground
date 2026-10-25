# First live funding trial from a home computer

The deployed static app uses its ordinary mainnet wallet and the production
Transak provider. There is no simulated balance in this build. The operator
reviews and approves the purchase in Transak; the deployment itself buys nothing.

For this first trial, Netlify's payment routes are enabled only for the public
IP in the private `PAYMENTS_PILOT_IP` setting. Other visitors keep the existing
exchange instructions. Netlify forwards authenticated requests over HTTPS to
the local payment service, passing the visitor IP from its request context.
The service binds only to loopback. Production Transak secrets remain on the
home computer, outside both repositories and all frontend builds.

A temporary Cloudflare Quick Tunnel supplies HTTPS ingress at no recurring
server cost. This is a short-lived interface trial, not permanent production
hosting: its hostname changes on restart and it has no availability guarantee.
The tunnel provides ingress only; Transak API calls leave directly through the
computer's home connection. ISP changes can interrupt access and require
updating Transak's IP approval and the pilot IP setting. A successful session
does not replace provider business/domain/IP approval.

Local user services:

- `fairground-live-gateway`: production gateway on `127.0.0.1:18872`.
- `fairground-payment-tunnel`: temporary HTTPS tunnel to that service.
- `fairground-donation-optin`: waits for ALGO at the configured development
  wallet, then submits only its zero-amount USDC self-transfer opt-in.
- `fairground-local-pilot`: separate staging preview on localhost; it remains
  simulated and cannot transfer real money.

Private configuration is under `~/.config/evolvetech/`, with production
credentials in `transak.env`, routing state in `live-gateway.json`, and a
private process launcher in `run-live-gateway.py`. The donation wallet recovery
information stays in `~/.config/fairground/development-wallet.json`; it is never
sent to Netlify or Transak.

## First deposit and automatic USDC setup

A new wallet has no ALGO and cannot yet hold USDC. The first purchase buys ALGO
into the wallet on the user's device. While the wallet is open it polls for the
deposit, signs its USDC opt-in locally, and converts the remaining ALGO to USDC,
keeping a 0.5 ALGO reserve. The opt-in increases the network's minimum balance;
it cannot be completed while the wallet is unfunded. No other user's wallet or
the project fund subsidizes this setup.

The project donation wallet has a separate balance and requires its own ALGO
minimum and opt-in fee. Its watcher does not fund it or move donations out; it
only opts it into mainnet USDC once sufficient ALGO arrives. A zero-balance
destination cannot be made USDC-ready by configuration alone.

## Stop or recover

Keep the computer awake and online for the trial. To stop the live gateway:

```sh
systemctl --user stop fairground-live-gateway fairground-payment-tunnel
```

Remove the three `PAYMENTS_*` settings from Netlify and redeploy to restore the
usual exchange instructions. If a tunnel restarts with a different hostname,
update `PAYMENTS_ORIGIN` and redeploy before testing again. These transient
services do not automatically survive a reboot. Never expose the Vite staging
server or its relay through this tunnel.
