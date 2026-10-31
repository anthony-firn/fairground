# Use crypto you already own

Card checkout is optional. Fairground's wallet can receive transfers from an exchange or another Algorand wallet
without Meld. The same transfer instructions are reachable from Wallet, Add money and the donation/payment screens.

## Transfer into Fairground

1. Open **Wallet → Transfer crypto I already own** (new wallet), **Receive** (active wallet), or **Add money → Transfer
   crypto I already own**. The sheet supplies the address, Copy address, a wallet link and a QR code.
2. For a new wallet, choose **ALGO** at the sending exchange and the **Algorand** network. Paste the displayed
   Fairground address. Choose the amount you want to fund, accounting for the exchange's withdrawal minimum and fee.
   There is no memo for deposits into your own wallet.
3. Keep Fairground open. It detects ALGO, signs the USDC opt-in locally, and converts eligible ALGO above its reserve
   to USDC. The funding sheet stays open during this transition and shows **USDC ready** when the wallet can receive it.
4. After that, native **USDC on Algorand** can be transferred to the same address. ALGO transfers remain available too.

The UI's first-deposit guidance allows at least 2 ALGO to arrive after withdrawal fees. This provides room for the
existing 0.201-ALGO opt-in requirement, reserve and conversion threshold. It is not a dollar-value promise or an exchange
withdrawal minimum. Larger ALGO deposits convert at the router's current quote; 0.5 ALGO remains reserved and exchange,
router and network fees apply. If conversion fails, the ALGO remains in the wallet and the interface offers a retry.

Coinbase and Kraken instructions are selectable in the same sheet. Do not assume that every exchange/account supports
every USDC network: choose Algorand in the exchange's actual send interface. If Algorand is not offered for USDC,
select ALGO in Fairground and send native ALGO on Algorand instead. USDC on Ethereum, Base, Solana or other networks
cannot be sent to this Algorand address. Back up the Fairground account before funding it.

## Pay directly from another wallet

A payment dialog always offers **Pay with another Algorand wallet**, including while Fairground's own balance is still
loading or the wallet is empty. Open the filled payment link on the same phone or scan its QR code in an Algorand wallet.
The address, exact USDC amount and required note can also be copied individually.

Native USDC on Algorand is required. A manual payment must include the exact note so Fairground can associate it with
the intended deal, order, fan support or donation. If an exchange cannot include the note, transfer crypto into your
own Fairground wallet first and pay from there.

For external donations and fan support, paste the transaction ID from the sending wallet/exchange and select
**Confirm my payment**. Fairground checks the confirmed chain/asset, recipient, exact note, amount and request time.
Shared donation/support notes are not automatically credited from a public recent-transfer search. Orders/deals have
unique notes and retain automatic detection. Split donations reset payment state for each recipient; confirmed partial
payments are recorded if the rest of a donation is cancelled.

## Development fund readiness

These instructions do not activate another account's receiving wallet. The shared development fund must itself opt in
to USDC before development donations can be accepted. The operator must restore the Fairground account that owns the
configured fund, verify that its wallet address matches `DEVELOPMENT_ADDRESS`, and use the same ALGO setup flow.
No wallet key, fund balance or blockchain transaction was changed by implementing these instructions.

## Validation

The wallet browser test uses in-process chain/router/Meld fixtures. It checks funding and USDC readiness with Meld
disabled, address clipboard copying, mobile layout, direct external payments, rejection of a wrong note, no accidental
completion from another recent transfer, and completion of both recipients of a split donation. No real funds are used.

References checked 2026-10-30:

- [Coinbase: networks and how to select one](https://help.coinbase.com/en/coinbase/trading-and-funding/sending-or-receiving-cryptocurrency/assets-on-multiple-networks)
- [Coinbase: ALGO](https://www.coinbase.com/price/algorand)
- [Kraken: USDC funding on Algorand](https://blog.kraken.com/product/new-features/usdc-deposits-and-withdrawals-now-available-on-algorand)
- [Kraken: withdrawal minimums and fees](https://support.kraken.com/articles/360000767986-cryptocurrency-withdrawal-fees-and-minimums)
