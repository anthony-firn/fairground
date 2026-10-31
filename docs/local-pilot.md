# Local Meld sandbox preview

See [Meld integration](meld-integration.md#local-sandbox) for configuration and `npm run local:pilot`.
This preview uses Meld sandbox credentials and a disposable local relay. The displayed wallet balance is simulated;
real wallet transfers and automatic settlement are disabled. No production provider configuration is loaded.

Run `npm run app:build && node e2e/wallet.ts` for an entirely local browser test using in-process fixtures.
