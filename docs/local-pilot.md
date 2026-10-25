# First local interface trial

Run `npm run local:pilot` with Node 22.18+ from this repository. The launcher
reads only the staging credential fields from
`~/.config/evolvetech/transak.env`, starts a loopback-only relay and interface,
and prints `http://localhost:5186/#/wallet`. No DNS changes, public tunnel, paid
server, production credentials, or router port forwarding are required.

The wallet displays a clearly labelled **$25 demo balance**. It opens actual
Transak staging sessions. All wallet transfers and automatic settlement are
disabled in this preview. The balance does not reflect a blockchain account,
and staging transactions do not update it. Never fund a preview account with
real assets. Use Transak's sandbox identity and payment details for testing.

Choose **Skip and start** if onboarding is displayed. In Wallet, choose **Add
money**, enter an amount, then **Open Transak sandbox**. Cash out opens a
staging sale; the preview cannot send the crypto to complete it. You can browse
the rest of the interface and create local posts; those events stay on the
in-memory relay and disappear when the launcher restarts.

The gateway sends requests directly through this computer's internet connection.
It checks the public IPv4 at startup; restart after an ISP address change. This
local trial does not establish production IP/domain approval with Transak. The
launcher is intentionally not a public payment server.

When started as the `fairground-local-pilot` user service:

```sh
systemctl --user status fairground-local-pilot
systemctl --user restart fairground-local-pilot
systemctl --user stop fairground-local-pilot
journalctl --user -u fairground-local-pilot -n 20
```

That transient service does not start automatically after a reboot. You can
always restart the preview with `npm run local:pilot`. Stop the existing
instance first if port 5186 or relay port 7799 is already in use.

Verified 2026-10-24: local wallet loaded with the demo balance; the Add money
button opened the real Transak staging checkout for USDC on Algorand; no app
browser errors were reported and relay connections stayed local.
