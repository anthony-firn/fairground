# Optional private Meld payment service

The main website now uses Meld directly from Netlify Edge. This standalone Node service is an alternative for
operators running their own gateway; it is not needed for the website integration.
It accepts only authenticated bridge requests, reconstructs the signed public URL, and forwards trusted client IP
metadata to the shared gateway. It never holds wallet keys or collects card/bank details.

Copy `.env.example` to a private `.env`, fill the production Meld credentials and supplier/asset settings, and keep
`PAYMENTS_ENABLED=false` until routes have been verified. Set a random `PAYMENTS_PROXY_SECRET` of at least 32
characters, and arrange an HTTPS reverse proxy. `compose.yaml` includes Caddy as one option. `/health` checks
process liveness, not supplier eligibility. See [Meld integration](../../docs/meld-integration.md).

The old Lightsail template remains optional infrastructure. It provisions billable resources and is not necessary
for Meld or local testing. No infrastructure should be provisioned solely because this template exists. This code
migration does not destroy existing resources or revoke credentials; those are independent operational actions.
