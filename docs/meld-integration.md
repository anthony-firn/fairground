# Meld integration

Fairground uses Meld's retail ramp API (version `2026-02-03`) for hosted card purchases and bank cash-outs.
The direct Transak adapter, token refresh and IPv4-only transport have been removed. Self-custody keys,
ALGO setup, USDC opt-in, exchange-router validation and ordinary payments continue to run on the device.

## Request flow

1. The customer enters an amount and their US state. The initial app UI requests US/USD routes; the API accepts
   country and subdivision for future country selectors. Provider KYC determines actual eligibility.
2. A signed member request reaches `/fairground/ramp/session`. The gateway checks the supplier’s currency catalog
   for the Algorand chain and native USDC asset ID (31566704), rejecting ambiguous tickers and other chains.
   It requests a fresh quote only from the configured supplier, for the exact configured Algorand currency.
   No quote means no checkout.
3. The gateway calls `POST /crypto/session/widget`, pins both currencies, the amount, wallet and payment method,
   and opens the returned Meld-hosted `widgetUrl`. Identity checks, card/bank data and final fees live there.
4. The app saves the returned session ID and external reference before opening checkout. A first purchase requests
   ALGO; later purchases request native USDC on Algorand. Wallet setup/conversion runs after real chain confirmation.
5. For a sale, the provider returns to our original URL without adding an order ID. The wallet restores its saved
   session and fetches `/payments/transactions/sessions/{sessionId}` through the gateway. If the provider has not
   created the transaction yet, use Check cash-out/Resume cash-out to retry.
6. The provider deposit address comes only from `cryptoDetails.destinationWalletAddress`. The payer wallet comes
   from `sourceWalletAddress`. Ownership, session, supplier, status, currency, address and amount are checked before
   showing confirmation and rechecked immediately before signing. A confirmed previous transfer with this
   transaction memo is reused. Completed sessions are cleared; redirects never authorize a transfer.

The public-chain indexer can lag: the duplicate-transfer lookup is a recovery aid, not an atomic, cross-device
payment lock. Do not confirm a cash-out simultaneously on multiple devices. Provider-specific deposit memos are
not implemented; the first supplier must support ordinary native USDC transfers to a unique Algorand address.

## Configuration

Obtain the exact supplier IDs and canonical currency IDs from Meld for this account. They must explicitly identify
native ALGO and USDC on Algorand, not similarly named assets on another network. No supplier or multi-chain USDC
ID is guessed in the shipped configuration. The supplier must support the requested field locks and redirect flow.

For the website's Netlify Edge function, set private environment values, then redeploy:

```text
MELD_PAYMENTS_ENABLED=false
MELD_API_KEY=<production private API key>
MELD_BUY_PROVIDER=<approved supplier ID>
MELD_SELL_PROVIDER=<approved supplier ID>
MELD_ALGO_CURRENCY_CODE=<canonical native Algorand ALGO ID>
MELD_USDC_CURRENCY_CODE=<canonical native Algorand USDC ID>
MELD_SELL_PAYMENT_METHOD=<approved bank payout method ID>
# Optional white-labelled Meld checkout origins, comma separated:
# MELD_CHECKOUT_ORIGINS=https://meldcrypto.com
```

Enable `MELD_PAYMENTS_ENABLED=true` only with working production routes. A missing key/route leaves the wallet's
ramp disabled. Sandbox keys stay in the loopback-only preview. Netlify calls Meld directly; the old
`PAYMENTS_ORIGIN` and `PAYMENTS_PROXY_SECRET` forwarding configuration is no longer read by the website edge.
Its request limit is per edge isolate, not a global account quota. Meld/provider account limits still apply.

The portable Node service remains an optional deployment for other gateway operators. See
[`gateway/payments/README.md`](../gateway/payments/README.md). No fixed-IP host is required by this implementation;
confirm any account-specific network restrictions with Meld before selecting a host.

## Local sandbox

Create a private `~/.config/evolvetech/meld.env` containing the route fields above and `MELD_SANDBOX_API_KEY`
instead of the production key, then run `npm run local:pilot`. Its wallet balance is explicitly simulated;
all real signing/settlement is disabled. Do not use real payment details in sandbox checkout. The local gateway
resolves this computer’s public IP using ipify at startup and passes it to Meld. Restart if that IP changes;
a particular sandbox supplier may also require an approved return domain.
No secrets or private configuration are committed or copied into the app build.

## Validation and remaining external checks

`npm test`, `npm run typecheck`, `npm run app:build`, `npm run gateway:build`, and `node e2e/wallet.ts`
validate protocol behavior, the adapter contract and the built browser wallet with in-process Meld and chain fixtures.
The browser test covers first ALGO deposit and conversion, later USDC deposits, fan payments, saved-session cash-out,
changed-owner rejection at signing time, completed-session cleanup, and development donations. The same browser test covers the independent crypto-transfer path documented in
[Use crypto you already own](crypto-transfers.md).

These tests do not prove live supplier availability. Meld must still provide credentials and confirm the supplier,
California/customer eligibility, adult-content-related wallet activity, asset IDs, minimums, fees, field locks,
redirect behavior and unique-address cash-out requirements. Test real Meld sandbox sessions once credentials exist.
No provider API keys or live checkout were used to implement this migration. Production deployment and real purchases
are separate operational steps; this change does not delete cloud resources or revoke old provider credentials.

## API references

- [White-label guide](https://docs.meld.io/docs/stablecoins/white-label-api-integration/whitelabel-api-guide/index)
- [Create widget](https://docs.meld.io/api-reference/crypto/retail-ramp/crypto-session-widget-create)
- [Fetch transaction by session](https://docs.meld.io/api-reference/crypto/retail-ramp/payments-transactions-sessions-get)
- [Statuses](https://docs.meld.io/docs/stablecoins/for-all-products/transaction-statuses)
- [Coverage](https://docs.meld.io/docs/stablecoins/coverage)
