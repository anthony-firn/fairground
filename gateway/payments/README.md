# Fixed-IP payment gateway

The app calls its usual same-origin `/fairground/wallet/*` and `/fairground/ramp/*`
URLs. Netlify Edge forwards those requests over HTTPS to this small service,
authenticating with a private shared secret and forwarding the visitor IP from
Netlify's request context. Signed member requests are checked against their
original public URL. All Transak API calls originate from the service's reserved
IPv4. It never signs wallet transactions or holds user funds.

Only payment routes move here. Social events, feeds, podcast downloads, and the
static app keep their existing hosting. A payment-service outage disables bank
on/off-ramping; it does not stop access to an existing wallet. This single server
is not a highly available payment service. Anyone operating a compatible gateway
can deploy this component with their own approved Transak credentials.

## Hosting choice and cost

The preferred next step is now the [near-$0 hosting plan](../../docs/payment-hosting-options.md):
an existing contributor server or eligible free-tier host, followed by multiple
approved operators. The gateway container is portable to either. Lightsail below
is a paid fallback; no paid server is required merely to build or test the app.

Use an existing trusted server with a reserved IP if one is available. Otherwise,
the smallest Linux Lightsail instance with public IPv4 is $5/month, including
512 MB RAM, a 20 GB disk, and a transfer allowance. Keep its static IPv4 attached;
unattached IPs, transfer overages, taxes, and optional backups can add charges.
No NAT gateway, load balancer, or paid Netlify upgrade is needed. Pricing checked
2026-10-24: https://aws.amazon.com/lightsail/pricing/

An IP from a home internet connection or the edge's observed outgoing address is
not a reserved server IP. The old Transak query-string widget integration is
deprecated. Transak requires backend session creation and IP approval:
https://docs.transak.com/guides/mandatory-security-changes

## Provisioning (creates billable resources)

`lightsail.json` is a reviewable CloudFormation template with only a VM and an
attached static IPv4. It contains no secrets. Before applying it:

1. Authenticate the EvolveTech AWS profile (not a personal/employer profile).
2. Confirm `ubuntu_24_04` exists in the chosen region with
   `aws --profile evolvetech --region us-west-2 lightsail get-blueprints`.
3. Confirm `nano_3_0` is the $5 Linux IPv4 bundle using `lightsail get-bundles`.
4. Import an SSH public key into Lightsail; supply its name and your current
   public IPv4 `/32` as `KeyPairName` and `AdminCidr`.
5. Validate the template, review the CloudFormation change set and cost, then
   create the stack. Do not add secrets to CloudFormation parameters or UserData.

Example after reviewing those settings and approving the cost:

```sh
aws --profile evolvetech --region us-west-2 cloudformation deploy \
  --stack-name fairground-payments \
  --template-file gateway/payments/lightsail.json \
  --parameter-overrides KeyPairName=YOUR_LIGHTSAIL_KEY AdminCidr=YOUR_IPV4/32 \
  --no-execute-changeset
```

The command above creates a change set for review; execute that change set to
provision the server. The template installs Docker and Compose. Wait for
`cloud-init status --wait` on the server before deploying the containers.

## Deploy the service

1. Publish a DNS **A** record `payments.evolvetech.dev` pointing to the stack's
   `StaticIPv4` output. Do not add an AAAA record: outbound Transak connections
   must use the approved IPv4. Website and email DNS stay as they are.
2. Copy the repository source to `/opt/fairground` on the server. Alternatively,
   build the Docker image locally, export it, and load it on the server. Keep
   credentials out of images, archives, the repository, and build contexts.
3. Copy `.env.example` to `gateway/payments/.env`, owned by the administrator,
   mode `0600`. Fill in the production API credentials locally from private
   storage. Generate a random bridge secret of at least 32 characters. Keep
   `PAYMENTS_ENABLED=false` initially.
4. Run `sudo docker compose --env-file gateway/payments/.env -f
   gateway/payments/compose.yaml up --build -d` from the repository root.
   Caddy provisions and renews HTTPS; port 8080 is not published externally.
5. Check `https://payments.evolvetech.dev/health`. It is a process liveness check,
   not proof of Transak approval or relay health. Confirm the VM's actual
   outgoing IPv4 matches the reserved address before submitting it to Transak.
6. Complete Transak's partner checklist with that IPv4, web referrer domain
   `www.evolvetech.dev`, and the production app identifiers as applicable. Obtain
   domain and IP approval and complete business verification. Staging and
   production credentials authenticating successfully alone do not prove this.
7. Test creation and loading of staging widget sessions separately with test
   wallets. Do not enable staging sessions in the public mainnet wallet. Verify
   that Transak currently supports ALGO/USDC on Algorand for the required buy
   and sell flows and customer regions before offering them.
8. Once approved, set `PAYMENTS_ENABLED=true` and recreate the payments service.
   Configure **only** `PAYMENTS_ORIGIN=https://payments.evolvetech.dev` and
   `PAYMENTS_PROXY_SECRET` on Netlify, then redeploy the website edge function.
   Transak's API secrets stay on this server. Netlify's free plan requires all
   scopes for private site environment settings.
9. Check the public `/fairground/wallet/config`, rejected foreign origins,
   anonymous rejection, signed session creation, and widget loading from the
   real app domain. Obtain explicit approval before a real-money test.

## Operations and rollback

Monitor `/health`, container restarts, disk space, OS updates, and certificate
expiry. Logs omit request bodies and provider credentials. The bridge limits
body sizes and requests per visitor; member signatures still authorize calls.
Install security updates regularly. Pin and review container image digests for
production releases. Back up the private settings and Caddy volumes privately.

To disable banking, set `PAYMENTS_ENABLED=false` and recreate the service, or
remove the two payment-bridge settings from Netlify and redeploy. The wallet
returns to its exchange instructions. To stop charges permanently, delete the
CloudFormation stack and verify the instance and reserved IP are both removed;
stopping the instance alone does not eliminate all charges.
