# Payment hosting near $0

Research and proposed architecture, 2026-10-24. This updates the hosting
recommendation; a gateway pool is not implemented or operating yet.

## Recommendation

Keep social data, feed ranking, wallet keys, and blockchain payments distributed.
Make bank/card access an optional service provided by approved gateway operators.
Start with one eligible free-tier instance or an existing contributor's server;
add independently operated gateways as contributors become available. Keep the
prepared Lightsail deployment as a paid fallback, not the default next step.

This can bring EvolveTech's incremental hosting bill close to zero. Someone still
provides computation, bandwidth, uptime, and maintenance. Donated hosting is a
contribution, not cost-free infrastructure for the whole network. Transaction,
conversion, and provider fees remain separate from hosting cost.

## Practical options

| Option | Added hosting cost to EvolveTech | Limits |
| --- | --- | --- |
| Existing trusted contributor server | Potentially $0 | Needs a stable IP, permission to operate the service, uptime, and Transak approval. |
| Oracle Always Free instance | Potentially $0 within eligibility and allowances | Home-region capacity, account verification, idle reclamation, maintenance, and reserved-IP/billing checks before provisioning. |
| Multiple independent contributor gateways | Potentially $0 plus optional donations | Needs real operators, provider approval, identity/trust management, and gateway-selection work. |
| Different hosted payment widget | Potentially no dedicated server | Must verify Algorand asset support, partner pricing, and production requirements. No verified drop-in replacement found in this review. |
| Prepared Lightsail service | $5/month base price | Reliable reserved-IP allocation at a small recurring cost; remains optional. |

Oracle documents Always Free compute with a public IP and warns that idle
instances may be reclaimed. Reserved IPs are persistent across instance
replacement. Confirm the actual tenancy's eligibility, available shapes, disk
limits, reserved-IP availability, and estimate before creating resources. Do not
use trial credits as proof of a permanent $0 configuration, and do not generate
artificial traffic to evade idle reclamation.

- https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm
- https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier.htm
- https://www.oracle.com/cloud/networking/virtual-cloud-network/faq/

## What a contributor gateway network would require

1. Operators publish signed descriptions containing their identity, HTTPS
   endpoint, supported provider/environment/assets, and a validity period.
   Initial operators are explicitly trusted; a signature alone does not make a
   gateway trustworthy. Payment providers approve each relevant server IP and
   operating arrangement.
2. Each independent operator holds its own approved provider credentials, unless
   the provider explicitly authorizes another arrangement. Never distribute
   EvolveTech's production secret, access tokens, or bridge secret to arbitrary
   relay operators. Provider contractual approval remains an external prerequisite.
3. The client chooses an available trusted gateway before starting checkout.
   Record the gateway identity with the checkout/order and retain it for that
   order. Do not silently retry an existing checkout or cash-out against a
   different operator, and never fan out an order to multiple gateways.
4. The provider performs identity checks and bank/card processing; gateways only
   create sessions and verify orders. Wallet keys stay on the device. Pin wallet
   destinations and verify order ownership and amounts before signing transfers.
5. Show clear operator identity and privacy information: a gateway sees request
   metadata and wallet-related details. It must not receive signing keys or
   collect card/bank details. The existing authenticated edge-to-server bridge
   is a starting point; public multi-operator discovery and direct client routing
   need additional implementation and review.
6. Operators may receive voluntary infrastructure donations. Do not reward node
   counts, self-generated requests, or duplicated traffic. Keep any operator fee
   explicit and optional; do not promise donations cover operating expenses.
7. If every bank gateway is unavailable, preserve social access and ordinary
   wallet transfers and offer the existing external exchange instructions.

Transak requires backend session creation, approved static egress IPs, and
origin restrictions. A distributed set of gateways can satisfy this with an
approved IP per gateway; rotating arbitrary user devices cannot satisfy that
requirement. The banking provider remains a centralized external dependency.

- https://docs.transak.com/guides/mandatory-security-changes
- https://docs.transak.com/guides/migration-to-api-based-transak-widget-url

## Other providers checked

Ramp Network documents a hosted widget using a frontend integration key. Its
public asset API returned 125 buy assets and 91 sell assets at the time of this
review, with no Algorand matches. This is a current observation, not a permanent
statement about coverage; partner-specific access could differ. Replacing the
chain or requiring cross-chain bridging solely to save a small hosting cost
would expand both complexity and risk.

- https://docs.rampnetwork.com/web/quick-start-hosted
- https://api.rampnetwork.com/api/host-api/v3/assets
- https://api.rampnetwork.com/api/host-api/v3/offramp/assets

Onramper supports hosted widget integration, but its published business model
includes a subscription. Its current signing documentation also requires private
keys to remain on servers. It is not a verified zero-cost replacement.

- https://docs.onramper.com/docs/integration-steps
- https://knowledge.onramper.com/pricing
- https://docs.onramper.com/docs/feature-overview

## Next concrete step

Check whether an eligible Oracle Always Free account or a contributor-owned
fixed-IP server is available. Deploy the prepared small gateway there without a
paid plan, verify actual billing and egress identity, and obtain Transak approval.
Then implement a second trusted operator and order-pinned selection once a
second approved node exists. No paid resource has been created for this plan.
