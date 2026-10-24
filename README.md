# Fairground

A social network with no company in the middle. Advertisers and fans pay creators directly, every deal is a signed
public record anyone can check, readers control their own feed algorithm, and nothing runs on servers the project has
to pay for.

**Status: early release.** The protocol core, the web app and the Android and iOS projects are built and tested. Try it
at **[evolvetech.dev/play/fairground](https://www.evolvetech.dev/play/fairground/)**. Payments are real USDC; use small
amounts while it matures.

## Easy first

Most decentralized networks lose people at the start, because new users have to understand keys, relays and wallets
before they see anything good. Fairground is designed for the least technical reader and has to be enjoyable within
seconds:

- **No setup.** Opening the app creates an account silently. Readers never see keys, relays or wallets; a wallet comes
  up only when someone gets paid. A username and password, for using the account on other devices, are offered later.
- **A good feed immediately.** The default is an AI "For you" feed drawn from the whole network, so a newcomer with no
  follows still sees the best posts. One optional tap on a few topics points it in the right direction.
- **It learns from normal use.** Likes, posts read for a few seconds and "less like this" tune the reader's profile on
  their device. There are no settings to learn, though every setting is there for those who want it.
- **One kind of account.** Anyone can post, earn, advertise, run a survey or run a relay, and creators keep the same
  feed as everyone else.

## How it works

**Its own network, built on Nostr's plumbing.** A post is an event signed by its author's key and stored on
independent relays that anyone can run, the way [Nostr](https://github.com/nostr-protocol/nips) works. But Fairground
is its own network: the app shows only Fairground accounts (every account joins by publishing its post-quantum key
binding on first start), never the wider Nostr network, so its spam and abuse never arrive and the first creators
here aren't drowned out. The app is a static site, and the same code ships as the iOS and Android apps (Capacitor).
Creators own their identity and audience: there's no account to be banned from and no cut.

**Readers own their algorithm.** Ranking runs on the reader's device from a recipe they control:

- which signals count and how much (newness, people they trust, engagement, topics, AI similarity);
- whether sponsored posts show, sink or disappear;
- how varied the feed is;
- which words to mute.

Recipes are plain data, so they can be shared, forked and safely run from anyone, and every post shows why it's there.
The default ranks with a small embedding model that runs in the browser (Transformers.js, about 23 MB, downloaded
once); readers can switch to their own Ollama model or turn AI off. Nothing about their reading leaves the device.

**Sponsorships are four signed events:** an advertiser's offer, the creator's acceptance, the creator's post (disclosed
with `#ad`) and the advertiser's payment receipt. The acceptance pins and embeds the exact offer, so terms can't change
afterwards. Anyone can advertise, including a creator cross-promoting with another creator. Creators publish media
kits (rate, topics, audience survey) so advertisers can find them, and advertisers' payment records (delivered, paid,
overdue, days to pay) are public, so creators can see who pays before accepting.

**A wallet built in, and dollars in and out of a bank.** Every account has a wallet: an Algorand account whose key is
derived from the account's own key, so the backup code and the username-and-password vault restore it, and payments
are signed on the device in one tap. Nobody else, Fairground included, can move the money. Turning it on is free: a
small sponsor run by the project sends the ALGO Algorand requires (0.2 for the account and its USDC holding, plus fees
for about 50 payments) in one atomic group with the wallet's USDC opt-in, once per member and capped per day, with
both limits read from the chain. Money comes in and goes out through Transak, a licensed on- and off-ramp (card or
bank transfer to buy, bank payout to sell), opened from the wallet; the gateway creates Transak sessions with the
partner secret, and checks a sale with Transak before the wallet pays into it. Where that isn't available, exchanges
such as Kraken send to and receive from the wallet directly. People who prefer their own wallet, including a
quantum-safe Falcon account in Pera, can still pay through an ARC-26 link or QR code and be paid there.

**Payment goes straight to the recipient's wallet,** in USDC on Algorand, from the built-in wallet or through an ARC-26
link that opens the payer's own wallet. The project never holds or splits funds. Each transfer's memo names what it's for (a deal, fan support, a
donation), so the app finds it on the public chain and anyone can verify every flow.

**Prices hold their purchasing power.** Offers, rates and support amounts are set in dollars of a base month and scaled
by the US CPI-U when paid, never below nominal. Index values arrive as signed attestations, published monthly from the
BLS by `tools/publish-index.ts`; each client chooses which publishers it trusts and how many must agree.

**Contracts are quantum-resistant.** Contract events carry an ML-DSA-65 (FIPS 204) signature alongside Nostr's Schnorr
signature, so a future quantum computer that can forge Schnorr signatures still can't forge a deal. Creators receive
into Algorand accounts that can sign with Falcon-1024, live on mainnet since August 2026.

**Audience surveys replace tracking.** Fairground is anonymous by default. A creator who wants to show sponsors their
audience asks in plain language, with standard questions (age range, region). Each answer goes out separately, at a
random time, from a throwaway key, carrying a token the creator signed without seeing it (blind RSA, RFC 9474). Nobody
can link an answer to a person, while advertisers can recount the answers and see if there are more than participants.

**Fans can pay for work without ads.** A support page offers a suggested monthly amount, an optional goal, and an
optional ad-free pledge: after a month when supporters meet the goal, no sponsorships the next month. Supporters pay
anonymously, and anyone can total the month and check the pledge from the chain.

**A marketplace for goods, food and services.** Listings use NIP-99 classifieds, so other Nostr marketplaces show
up too. They can be things for sale, menu items, services (rides, grocery runs, meal pickup, tasks, cleaning) or
requests for help that people answer with a price. Sellers can open a shop, a restaurant with a menu, or a services
page. Orders and offers travel as end-to-end encrypted messages (NIP-17), and buyers pay the seller's wallet directly.
Only someone who paid can review: the payment memo carries an order id that commits to the buyer. Reliability shows
verified orders and ratings, weighted towards reviewers the reader trusts. Credentials (licence, insurance, food
handler card, background check) show as verified by organisations the reader trusts, vouched by people they follow,
or self-declared.

**Every format in one app.** Posts read like Twitter, Photos like Instagram, Videos like YouTube (a grid, then a
watch page with what's next), Shorts like TikTok (full-screen, swipe, plays what's on screen) and Listen like a
podcast app, with the Market alongside. They use the standard formats (NIP-68 pictures, NIP-71 videos, NIP-F4
podcast episodes), and ordinary posts with a photo, video or audio link show in the matching format, so there's
something to watch from the first day. Anyone can post in any format: photos are shrunk and stripped of location data
on the device, and videos are uploaded with their length, size and a poster frame read on the device. On a computer
the app has a sidebar, wide grids and a side column, rather than a stretched phone layout.

**Podcasts in every podcast app.** A creator starts a show (artwork, category, explicit flag) and uploads episodes,
marking natural pauses where mid-roll ads can go. Each show gets a standard RSS feed with the iTunes and Podcasting 2.0
tags, served by a podcast gateway, that they paste once into Apple Podcasts, Spotify, YouTube Music and Podcast Index.
The gateway (`src/gateway.ts`, about 100 KB bundled) is a stateless request handler that reads signed events from
relays, so anyone can run one; the one at evolvetech.dev/fairground runs as a Netlify edge function. It serves only
Fairground accounts, applies the same always-blocked rules as the app, and lets its operator take a show down.
Episodes are ordinary MP3 or M4A files, which every app accepts from any publisher. HLS streams play in the app and
are listed as a Podcasting 2.0 alternate enclosure; Apple Podcasts' own HLS video is open only to hosting providers
Apple has approved, through a private API, so the feed never depends on it.

**Host-read ads, inserted dynamically.** An advertiser plans a campaign (goal, offer and promo code, talking points,
what not to say, formats and slots, audience, budget at a price per thousand listens, dates and brand-safety
exclusions) and the app matches it to creators' media kits. Each creator gets an offer with their own promo code and
tracked link. A creator who accepts reads the ad in their own voice, recorded in the app or uploaded, and publishes a
placement: the recording, its slots (pre-, mid- or post-roll), its dates and the shows or videos it runs on. If the
offer asks, the advertiser approves that exact recording first. Nothing is baked in: Fairground's player inserts the
read while it plays (labelled with the sponsor, skippable, as Apple also requires of ads), and the gateway stitches it
into MP3 downloads for every other app, splicing MPEG frames at the creator's marks without re-encoding and supporting
the HEAD and byte-range requests Apple requires. So a read runs across the whole back catalogue, starts and stops on
its dates, and gives way to the next sponsor. Reads recorded in the app are converted on the device to MP3 matching the
show's episodes. The campaign page tracks every creator from offer to paid, and turns the orders and revenue each
promo code brought in into cost per order and return on spend.

**Search.** Search covers Fairground accounts only: the app fetches their recent posts, profiles and listings and
matches on the device, so what a reader searches for stays with them. Results go through the same safety rules as the
feed.

**Reddit-style comments everywhere.** Posts, photos, videos, shorts, episodes and listings have threaded replies with up and down votes, Best, Top, New
and Controversial sorting, and collapsible branches.

**Safe by default.** Nostr relays carry everything anyone posts, so the app decides what to show:

- Sexual content involving minors, bestiality and intimate imagery shared without consent are never shown, and their
  authors are blocked.
- Safe search hides explicit content by default. Adults can turn it off after confirming they are 18 or older; in the
  phone apps that's only possible on the web, as the app stores require.
- Only Fairground accounts appear, which keeps out the spam and abuse that circulate on the wider Nostr network.
- Slurs, threats, spam and bots are hidden, and every post can be hidden or reported. Titles and image descriptions
  are checked as well as the text.
- Posts are in the reader's languages: their device's, plus any they keep reading, liking or writing in, detected on
  the device. That keeps the start feeling like their own community rather than the whole world at once. Languages
  can be added or removed in settings, or the filter turned off.

**The commons loop.** After money changes hands (a creator's payout, an advertiser's payment, a seller's paid order,
a month of fan support) the person is offered an optional donation, never pre-selected, and anyone can give from You
or About at any time. Development donations go to the project's public USDC account on Algorand, which the app offers
only once it can receive USDC.
Donors see exactly how it splits between development and relays, and which relays get it: the ones that actually served
them, starting with relays run by their own followers. Anyone can run a relay and receive donations by publishing a
payout address that their relay's NIP-11 document confirms. Relays can pledge to pass a share back to creators. The
loop is damped so it can't be farmed: relays are credited only for events they delivered first to readers who saw
them, credit is grouped by operator, and each hop passes on a small share (about 0.2% of a deal per round trip).

**Sign in anywhere without a server.** A username and password derive, through Argon2id, a key that finds and decrypts
the account's vault on relays: keys, settings, AI interests, subscriptions, payout details, survey keys. A passkey
(WebAuthn PRF) can be required as a real second factor, with a recovery code as fallback.

## Limits

- **"No hosting cost" applies to the project.** Relays and media hosts are run by others. Free relays may drop old
  events and video is expensive to store, so serious creators will want a paid relay or their own.
- **Phones can't be relays.** Relays must accept connections around the clock, so running one means a server, a home
  machine or a hosting service. The app does everything else in one step.
- **Quantum resistance doesn't yet cover the whole stack.** It covers the contracts and the creator's own account.
  Algorand's consensus (target 2027) and USDC's issuer keys are still classical, and ordinary posts are Schnorr-only.
  Once Schnorr can be forged, deciding which key binding came first needs a timestamp anchored before then (NIP-03);
  that is not implemented yet.
- **USDC holds dollar value, not purchasing power.** Indexing protects the deal, not a balance kept afterwards. No
  cost-of-living stablecoin is liquid and stable enough to pay with today; the settlement rail is named in each offer.
- **Index publishers are trusted.** A value counts only when the client's threshold of trusted publishers agree and
  none disagree. Until independent publishers exist, the default trusts one (the project's), which could set a value.
- **No escrow, no verified listen counts.** The advertiser pays after the post goes up or the read runs, with the
  public payment record as the enforcement. Deals are a flat fee; listen counts in media kits are what creators report,
  and promo codes are how an advertiser checks them. The gateway doesn't count downloads yet.
- **The built-in wallet uses Ed25519 keys, not post-quantum ones.** Algorand's native Falcon-1024 accounts use a
  deterministic Falcon signature that general-purpose JavaScript libraries don't produce (we checked: Algorand rejects
  a standard Falcon signature). The wallet can be rekeyed to a Falcon key, keeping its address, once a compatible
  signer exists. Contracts stay hybrid-signed, and anyone can be paid into a Falcon account in Pera instead.
- **Starting wallets costs the project a little ALGO** (0.25 per wallet, capped per day), from a small hot wallet whose
  phrase lives in the gateway's environment. A determined abuser could use up a day's cap with fake accounts.
- **In-app buying and selling need a Transak partner account** (a business sign-up with their verification) and its
  API key and secret in the gateway. Until then the wallet explains how to use an exchange. Transak's fees, limits and
  countries apply, and they check identity the first time.
- **The iOS app** will need publishing from an Apple developer account enrolled as an organization, which Apple
  requires of apps with wallets.
- **The public gateway has costs.** Feeds are small and cached, and plain downloads redirect to the creator's file, but
  stitched downloads stream through the gateway, which uses its bandwidth. It runs on Netlify only, so during a
  failover to the backup host feeds are unavailable. Relay operators can run gateways too.
- **Stitching needs MP3.** M4A episodes play reads in the app but not in other apps' downloads, and a read is spliced
  in only when its sample rate and channels match the episode's (the app converts recordings to match). Video reads
  play in the app only; video podcast apps get the video without them.
- **Media hosting is free Blossom servers.** They take podcast-sized files today, but nothing obliges them to keep
  them; serious shows should mirror their files or link their own hosting.
- **The network starts small.** Branching from Nostr means the first readers see only what Fairground's first
  members post.
- **Surveys hide answers, not participation.** Who took part is public; that list is what lets advertisers check the
  count. A creator can fill in answers only for participants who didn't answer. Answers are sent while the app is open.
- **Support totals count money and addresses, not people,** and a support memo links the paying address to the creator.
- **No authenticator-app codes.** With no server to enforce them, anyone holding a copy of the vault could skip the
  check. A passkey's hardware secret does protect it. Passkeys in the iOS and Android apps need the evolvetech.dev
  domain verified for them (associated domains / asset links), which isn't set up yet.
- **Wallet links open the payer's wallet one payment at a time** (ARC-26 has no grouped payments), so a donation split
  across several recipients takes several confirmations.
- **The marketplace has no escrow and no dispute process.** Reviews can't be faked without paying, but a seller could pay
  themselves, at the cost of a fee. That's why reviews from strangers count for less. Drivers and food sellers are
  responsible for their own licences, insurance and permits; the app shows safety guidance and credentials, not
  guarantees.
- **Private messages use NIP-17 (secp256k1), so they aren't post-quantum yet.** Swapping in a hybrid ML-KEM layer is a
  planned change.
- **Moderation reads text, titles and hashtags, not images or audio.** An explicit image with an innocent caption can
  get past it. Keeping to Fairground accounts does most of the work against spam.
- Fairground doesn't give legal or tax advice. Creators and advertisers remain responsible for their disclosures and
  taxes.

## Development

Node.js 22.18 or later. The protocol core runs as TypeScript with no build step; the app builds with Vite.

```sh
npm install
npm test                  # protocol core: 102 unit tests
npm run typecheck
npm run app:dev           # the app on http://localhost:5173
npm run app:build         # static build in app/dist
node tools/dev-relay.ts   # an empty local relay; open the app with ?relay=ws://localhost:7777
node e2e/smoke.ts         # end-to-end test of the built app in Chrome, against labelled test fixtures
node e2e/market.ts        # two people: comments, safety, buying, requests, offers and orders
node e2e/media.ts         # photos, videos, shorts, listening, search, languages, and the desktop and phone layouts
node e2e/podcast.ts       # a show and episode, a campaign, a recorded read, approval, playback, RSS and stitching, donating
node e2e/wallet.ts        # turning a wallet on, adding money, paying in one tap, cashing out, donating (stand-in chain)
npm run gateway:build     # bundles the podcast gateway into dist-gateway/fairground-gateway.js
```

The app reads public relays by default. `?relay=` (repeatable) points it elsewhere, and a build with
`VITE_READONLY=1` reads real relays without publishing anything, for testing.

### Mobile apps

`app/android` and `app/ios` are Capacitor projects that load the same web build.

```sh
npm run app:build && (cd app && npx cap sync)
(cd app/android && ./gradlew assembleDebug)   # needs the Android SDK and JDK 21
(cd app && npx cap open ios)                  # needs macOS and Xcode
```

Store releases need signing keys and developer accounts, which aren't part of this repository.

### Operations

- **CPI attestations:** `.github/workflows/index.yml` publishes mid-month. Generate the publisher key once with
  `node tools/publish-index.ts --keygen > publisher.json`, store it as the `FAIRGROUND_INDEX_KEY` secret, and keep the
  public key in `src/defaults.ts` in step.
- **Development fund:** `DEVELOPMENT_ADDRESS` in `src/defaults.ts` is unset until the project's wallet exists; until
  then donations go only to relays.

| Path | Contents |
|---|---|
| `src/pq.ts` | Hybrid Schnorr + ML-DSA-65 signatures, key bindings and rotation |
| `src/pricing.ts` | Indexed prices, index attestations and the k-of-n trust rule |
| `src/sponsorship.ts` | Offer, acceptance, sponsored post, payment receipt; deal and payment checks |
| `src/mediakit.ts` | Creators' media kits and advertisers' public payment records |
| `src/survey.ts` | Audience surveys: blind tokens, throwaway-key answers and an independent recount |
| `src/support.ts` | Fan support pages, monthly totals and the ad-free pledge check |
| `src/commons.ts` | Donations to development and relays, relay payouts, anti-farming credit, pass-on pledges |
| `src/comments.ts` | Threads (NIP-10 and NIP-22), votes (NIP-25), Reddit-style ranking |
| `src/commerce.ts` | Listings (NIP-99), storefronts, orders, quotes, verified reviews, credentials, reports |
| `src/safety.ts` | Illegal-content blocking, safe search, spam and bots, languages |
| `src/network.ts` | Fairground membership: the key bindings that make an account part of the network |
| `src/podcast.ts` | Shows, episodes, Apple categories and RSS feeds |
| `src/ads.ts` | Campaigns, host-read placements, approvals and dynamic ad breaks |
| `src/mp3.ts` | MP3 frame layout, for splicing reads in without re-encoding |
| `src/gateway.ts` | The gateway: podcast feeds, stitched downloads with Range support, wallet starts, Transak sessions, health |
| `src/walletkey.ts`, `src/wallet.ts` | The built-in wallet: key derivation, balances, USDC payments signed on the device |
| `src/starter.ts` | Starting new wallets: the sponsor's ALGO and the USDC opt-in in one group |
| `src/ramp.ts` | Transak sessions and cash-out order checks |
| `src/httpauth.ts` | Signed HTTP requests (NIP-98) to the gateway |
| `src/geohash.ts` | Approximate locations for "near me" |
| `src/feed.ts` | Feed recipes, local ranking with explanations, cold start, local AI embedders |
| `src/vault.ts` | Username-and-password vaults with passkey and recovery-code factors |
| `src/memos.ts` | Payment memos that tie each transfer to its purpose |
| `src/rails/algorand.ts` | USDC on Algorand: addresses, opt-in checks, payment links, transfer verification |
| `src/defaults.ts` | Default relays, index publisher, development address and gateway |
| `app/` | The React app, its on-device model worker, and the Capacitor iOS and Android projects |
| `gateway/` | The gateway as one bundled module for edge platforms |
| `tools/` | Dev relay (with simple NIP-50 search) and the CPI publisher |
| `e2e/` | End-to-end tests, their test fixtures and tiny generated test media, and the demo-video recorder (real posts only) |
| `docs/protocol.md` | Event formats and verification rules |

## License

[Apache License 2.0](LICENSE)
