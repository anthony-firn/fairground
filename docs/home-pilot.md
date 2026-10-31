# Home-hosted payment pilot

The website integration now calls Meld directly from its server-side edge gateway. It no longer forwards wallet
requests through the earlier home tunnel or fixed-IP provider transport. No new tunnel or paid server is needed
for the current code. This source change does not stop an existing service, revoke credentials or delete resources.

See [Meld integration](meld-integration.md) for the replacement configuration and sandbox preview.
If an old home pilot is still running, retire only its identified service/tunnel after deploying and checking the new
wallet configuration. Preserve private account backups and wallet keys; provider credentials are separate from them.
