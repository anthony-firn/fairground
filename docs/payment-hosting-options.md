# Payment hosting

The website's Meld integration runs directly in the existing Netlify Edge function; it does not route through the
old home tunnel or require the prepared fixed-IP server. API secrets stay in private server-side environment settings.
The app remains static and wallets sign locally. No paid resources were provisioned by this migration.

A portable Node payment service and authenticated bridge remain available for operators who want separate hosting.
The Lightsail template is optional legacy infrastructure, not required for Meld. Running it can incur charges.
Do not create it merely to test the integration. Any supplier-specific egress or domain restrictions must be
confirmed with Meld; none are inferred from the previous provider's requirements.

See [Meld integration](meld-integration.md) for setup, verification and current limitations.
