# Stablecoin balances and quantum security

USDC is the USD-pegged asset used for Fairground settlement on Algorand (asset
31566704). ALGO pays network fees and account minimums. ALGO left as an operating
reserve still has a changing market price. Receiving readiness, holding USDC,
and post-quantum signing are separate properties.

## What can affect funds

| Layer | Current position | Consequence and mitigation |
|---|---|---|
| Built-in spending key | Ed25519, derived from the Fairground account key | A sufficiently capable future quantum attacker could forge spending signatures and transfer ALGO or USDC. The built-in signer is not post-quantum. No such capable quantum computer is currently known. |
| Contract and recipient identity | ML-DSA-65 plus Schnorr signatures | A verified signature needs an authentic key binding. Competing keys now fail closed. First-contact history still needs a trusted anchor or prior trusted key; relay timestamps alone cannot establish that trust after Schnorr becomes forgeable. |
| USDC issuer controls | Circle-operated asset management and freeze authorities exist | Compromise of privileged issuer authorization could affect asset availability. The fund's signer does not secure Circle's infrastructure or controls. Their complete post-quantum readiness has not been verified here. |
| Network consensus | Account signatures and State Proofs have deployed Falcon protection; other consensus signatures and VRF migration remain on Algorand's roadmap | Protecting an account does not protect every consensus component, guarantee network availability, or eliminate ledger-level risks. |
| Wallet software, recovery and RPC/router services | Separate implementation and trust dependencies | Malware, stolen backups, malicious frontend code, unsafe transaction validation or misleading recipient data can cause losses without a quantum computer. A post-quantum signature does not protect a stolen secret key or an incorrectly authorized payment. |

USDC's reserves, redemption rules and USD peg also carry issuer/market risks.
Stable value does not imply quantum resistance or risk-free custody.

## What this release does

The wallet shows exact USDC units, the separate ALGO balance and reserve, and its
standard Ed25519 signing status. Manual ALGO-to-USDC conversion works below the
automatic threshold. It presents actual prepared network fees, expected/minimum
USDC and the protected reserve before confirmation. Network and transaction
checks reject rekeying, closing, other assets, changed groups and reserve spending.

Conversion state must be saved before broadcast. Timeouts and reloads reconcile
the same signed group. An expired group is cleared only after checking both the
node and a sufficiently synchronized indexer. A short shared sender lease limits
overlapping conversions from separate clients. Receiving remains available for
rekeyed accounts, while built-in spending is disabled when an external authority
is required. No secret key is sent to the router or node.

The local operator utility `node tools/settle-development-fund.ts --watch` keeps
new development-fund deposits in USDC, converting only when at least one ALGO is
available above the protected reserve and maximum fee budget. It reads only the
existing private local owner's file, requires an exact match to the configured
development recipient, holds a process lock, and keeps signed journals/receipts
under `~/.local/share/evolve-bootstrap/treasury/`. It is not a cloud custody service
for users. Small balances use the explicit review flow.

## What is not implemented

This release does not create Falcon keys or rekey users. A production migration
needs an independently protected Falcon secret, compatible deterministic signing,
recovery/export, and verified signing/payment tests before changing authority.
Deriving a Falcon secret only from the classical Nostr key would preserve a
quantum attack path and is not an acceptable migration. Losing the replacement
signer can make funds inaccessible. Restoring a wallet also needs its original
post-quantum identity seed; generating a competing binding does not prove the
new identity is the authentic one.

## Primary references

- [Algorand post-quantum FAQ](https://algorand.co/learn/post-quantum-security-frequently-asked-questions)
- [Algorand post-quantum accounts](https://dev.algorand.co/concepts/accounts/post-quantum/)
- [Circle USDC terms and controls](https://www.circle.com/legal/usdc-terms)
- [Folks Router SDK transaction checks](https://github.com/Folks-Finance/folks-router/blob/main/packages/folks-router-js-sdk/src/checks.ts)

Implementation and live fund checks: November 18, 2026. Provider and protocol
capabilities can change; none of these statements guarantees future security.
