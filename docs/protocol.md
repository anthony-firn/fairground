# Fairground protocol (draft)

Fairground is its own network built on Nostr's event format: everything here is an ordinary
[NIP-01](https://github.com/nostr-protocol/nips/blob/master/01.md) event, so any relay stores it, but Fairground clients
show only Fairground members (see Membership). The kind numbers are provisional and unregistered; none
collide with the [NIP registry](https://github.com/nostr-protocol/nips#event-kinds) as of October 2026.

| Kind | Event | Signed by |
|---|---|---|
| 3470 | Post-quantum key binding | Author (hybrid) |
| 33470 | Sponsorship offer (addressable) | Advertiser (hybrid) |
| 3471 | Acceptance | Creator (hybrid) |
| 1 | Sponsored post | Creator (hybrid optional) |
| 3472 | Payment receipt | Advertiser (hybrid) |
| 3473 | Donation receipt | Creator (hybrid) |
| 3474 | Index attestation | Index publisher (hybrid) |
| 3475 | Audience survey | Creator (hybrid) |
| 3476 | Survey token request | Participant's own account |
| 3477 | Survey token issue | Creator |
| 3478 | Survey answer | Throwaway key, one per answer |
| 13470 | Support page (replaceable) | Creator (hybrid) |
| 13471 | Relay payout (replaceable) | Relay operator (hybrid) |
| 33475 | Feed recipe (addressable) | Recipe author |
| 33476 | Media kit (addressable, `d` = `media-kit`) | Creator (hybrid) |
| 30078 | Sign-in vault (NIP-78 app data, `d` = `fairground/vault`) | Key derived from username and password |
| 33478 | Podcast show (addressable) | Creator |
| 54 | Podcast episode (NIP-F4, extended) | Creator |
| 33479 | Ad campaign (addressable) | Advertiser |
| 33480 | Ad placement (addressable, `d` = acceptance id) | Creator (hybrid optional) |
| 3481 | Read approval | Advertiser (hybrid) |

Amounts are decimal strings of integer micro-dollars (`500000000` is $500). Periods are `YYYY-MM`. Times are Unix seconds.

## Hybrid signatures

A hybrid event carries a normal Schnorr signature and a tag:

```
["pq", "ml-dsa-65", <base64 signature>]
```

The ML-DSA-65 signature ([FIPS 204](https://nvlpubs.nist.gov/nistpubs/FIPS/NIST.FIPS.204.pdf)) is over
`sha256(JSON.stringify([0, pubkey, created_at, kind, tags, content]))`, where `tags` excludes every `pq` and `pq-prev`
tag, with the FIPS 204 context string `fairground/v1`. The Schnorr signature then covers the whole event, including
the `pq` tag. An event with zero or several `pq` tags, or a different algorithm, has no valid post-quantum signature.

## Key binding (3470)

```
tags: [["alg", "ml-dsa-65"], ["key", <base64 public key>], ["e", <previous binding id>, "", "prev"]?]
```

The binding is signed hybrid with the key it publishes, which proves possession of that key. A rotation names the
binding it replaces and also carries `["pq-prev", "ml-dsa-65", <sig>]` made with the previous key.

To resolve an author's key, start from their oldest valid binding without `prev`. Then repeatedly move to the oldest
valid binding whose `prev` is the current one and whose `pq-prev` verifies under the current key. If more than one
starting binding or rotation competes, the client reports a conflict.

The ML-DSA seed must be generated independently of the Nostr key. A quantum attacker who recovers a Nostr secret key
from its public key would otherwise recover the ML-DSA key as well.

## Sponsorship offer (33470)

```
content: brief for the creator
tags: [
  ["d", <slug>],
  ["title", <title>],
  ["price", <micro-dollars>, "USD", <index id>, <base period>],
  ["rail", <rail id>],
  ["deadline", <unix seconds>],
  ["p", <creator pubkey>]?          // omitted: open to any creator
]
```

The advertiser may edit or withdraw an offer by republishing the same `d`. An edit doesn't affect a deal that has
already been accepted.

## Acceptance (3471)

```
content: the accepted offer event, as JSON
tags: [
  ["e", <offer event id>, "", "offer"],
  ["a", "33470:<advertiser>:<slug>"],
  ["p", <advertiser>],
  ["payto", <rail id>, <address>]
]
```

An acceptance is valid when all of the following hold:

- It references the exact offer event id.
- The creator is not the advertiser.
- It matches the offer's `p` tag, when the offer has one.
- The address is valid for the offer's rail.
- It was published by the deadline.

Relays keep only the newest version of an addressable event, so the accepted version is embedded in the content.

## Sponsored post (kind 1)

```
content: must contain "#ad"
tags: [["e", <acceptance id>, "", "sponsorship"], ["p", <advertiser>], ["t", "ad"]]
```

The post must be published by the creator after the acceptance and by the deadline. The `#ad` disclosure is
mandatory, because US law (the FTC Endorsement Guides, 16 CFR 255) requires sponsored content to be labeled. If the
post has a `pq` tag, it must verify.

## Payment receipt (3472)

```
tags: [
  ["e", <acceptance id>, "", "acceptance"],
  ["e", <sponsored post id>, "", "delivery"],
  ["p", <creator>],
  ["tx", <rail id>, <transaction id>],
  ["amount", <micro-dollars>],
  ["period", <index period used>]
]
```

A payment is verified when the rail shows a confirmed transfer that meets all of these:

1. It went to the acceptance's `payto` address.
2. Its memo is exactly `fairground:deal:<acceptance id>`.
3. Its amount equals the receipt's `amount`.
4. Its amount is at least `max(nominal, ceil(nominal × index[period] / index[base period]))`.

With the index id `fixed`, no attestations are needed: the nominal amount is owed and `period` is the base period.
Otherwise `period` must be one of the two latest periods resolved from attestations published before the transfer confirmed,
and no earlier than the base period. The second-latest period is allowed because a new index value may come out
while the advertiser is paying.

## Index attestation (3474)

```
tags: [["index", <index id>], ["period", <period>], ["value", <decimal, ≤3 places>], ["r", <source URL>]]
```

Each client configures an index policy: the index id, a list of trusted publisher pubkeys and a threshold. A value for
a period resolves only when at least `threshold` trusted publishers attest the same value. If any trusted publisher
attests a different value, or contradicts itself, the period does not resolve. `us-cpi-u` is BLS series CUUR0000SA0
(all items, not seasonally adjusted), which BLS does not revise after publication.

## Payment memos

Every transfer carries a memo naming its purpose, so flows can be totalled and verified from the chain:

| Memo | Purpose |
|---|---|
| `fairground:deal:<acceptance id>` | A sponsorship payment; one transfer settles exactly one deal |
| `fairground:support:<creator pubkey>` | Fan support, or a relay passing support on to a creator |
| `fairground:relay:<normalized relay URL>` | A donation to the operator of that relay |
| `fairground:development` | A donation to Fairground's development |

Relay URLs are normalized to a lowercase host without a trailing slash.

## Donation receipt (3473)

```
tags: [["e", <payment receipt id>, "", "payment"]?, ["tx", <rail id>, <transaction id>, <micro-dollars>, <recipient>]...]
```

`recipient` is `development` or the relay URL whose operator was paid. This event is optional, and so is the `e` tag:
anyone may donate at any time. Clients may suggest a donation only after money changes hands (a verified payout, a
payment made, a paid order). They must show the split between development and relays and which relays
receive it, never pre-select it, and never take it from the payment it follows.

## Relay payout (13471)

```
content: optional message
tags: [["r", <relay URL>]..., ["payto", <rail id>, <address>], ["passon", <percent 0–100>]]
```

A payout counts for a relay only when that relay's NIP-11 document (`GET https://<host>` with
`Accept: application/nostr+json`) names the payout's author as `pubkey`.

When a donor gives to relays, each operator is weighted by:

- the events the donor saw that one of the operator's relays delivered first (credit for re-delivered events goes to
  whichever relay was first);
- a bonus when the operator follows the donor.

Successive donations go to the operator furthest below their weighted share of what the donor has given so far.

`passon` is a public pledge: in each month, the operator sends at least that percentage of the previous month's relay
donations (memos naming their relays) as support to creators (memo `fairground:support:`). Support sent to the
operator's own creator account or own address doesn't count.

## Media kit (33476)

```
content: what the creator makes
tags: [["d", "media-kit"], ["price", <micro-dollars>, "USD", <index id>, <base period>], ["t", <topic>]...,
       ["e", <survey id>, "", "survey"]?, ["format", "post" | "podcast" | "video"]..., ["audience", <per episode>]?,
       ["cpm", <micro-dollars per thousand>]?]
```

The price is the creator's rate per sponsored post; `cpm` prices host-reads by the audience the creator reports. Advertisers' records are computed from public acceptances,
sponsored posts and receipts.

## Sign-in vault (30078)

The username (normalized to lowercase) and password go through Argon2id (64 MiB, 2 passes, 32-byte output). The salt is
`sha256("fairground/v1/vault/user:<username>")`. HKDF-SHA256 then derives two keys from the result:

- `locator:<n>`: a Nostr secret key that publishes and finds the vault. `n` counts from 0 until the key is a valid
  scalar.
- `wrap`: the password key.

```json
{ "v": 1,
  "wraps": [{ "kind": "password" | "passkey" | "recovery", "nonce": "…", "ct": "…", "credentialId": "…", "prfSalt": "…" }],
  "body": { "nonce": "…", "ct": "…" } }
```

The body is the account's settings, encrypted with XChaCha20-Poly1305 under a random data key, with the locator
pubkey as associated data. Each wrap encrypts the data key under `HKDF(passwordKey [|| factor secret],
"fairground/v1/vault/factor:<kind>")`, with `<locator>:<kind>` as associated data. The factor secret is a passkey's
WebAuthn PRF output, or the 20-byte recovery code. When a second factor is on, there is no `password` wrap.

## Audience survey (3475)

```
content: what the answers are for, in plain language
tags: [
  ["title", <title>],
  ["closes", <unix seconds>],
  ["question", <id>, <prompt>, <choice>, <choice>, ...],   // per question
  ["tokenkey", <id>, <base64 SPKI>]                        // per question: RSA-2048, RSABSSA-SHA384-PSS-Randomized
]
```

A survey is a regular event, so it can't be edited after tokens are issued. Standard question ids (`age`, `region`)
have fixed prompts and choices, so results compare across creators.

The token message for a question is the UTF-8 string `fairground/v1:survey:<survey id>:<question id>`. RFC 9474's
randomized preparation prefixes it with 32 random bytes, and that prefix makes every token unique.

**Token request (3476).** The request is signed by the participant's real account, so taking part is public. It
carries `["e", <survey id>, "", "survey"]`, `["p", <creator>]` and a `["blinded", <question id>, <base64>]` tag for
every question. Requesting a token for every question keeps the request from revealing which ones will be answered.

**Token issue (3477).** The creator's reply carries `["e", <survey id>, "", "survey"]`,
`["e", <request id>, "", "request"]`, `["p", <participant>]` and a `["blindsig", <question id>, <base64>]` tag per
question. A creator issues tokens to each account at most once.

**Answer (3478).** Each answer is signed by a fresh key that is used once:

```
tags: [["e", <survey id>, "", "survey"], ["question", <id>], ["choice", <choice>],
       ["token", <base64 prepared message>, <base64 signature>]]
```

An answer counts when all of these hold:

- It was published before `closes`.
- Its choice is one of the question's choices.
- Its prepared message ends with that question's token message.
- Its signature verifies under that question's key.
- Its token hasn't been counted already; the oldest answer using a token wins.

Clients publish each answer at an independent random time before `closes`.

**Recount.** A participant is an account with both a valid request and a matching issue. The reader may filter
participants by their own test of which accounts are real. If any question has more counted answers than
participants, the survey is flagged.

## Support page (13470)

```
content: what support pays for
tags: [
  ["title", <title>],
  ["price", <micro-dollars per month>, "USD", <index id>, <base period>],
  ["payto", <rail id>, <address>],
  ["goal", <micro-dollars per month>]?,
  ["adfree", "after-goal"]?
]
```

A supporter pays the `payto` address with the memo `fairground:support:<creator pubkey>`. A month's support is
every confirmed transfer to that address with that memo prefix, between the month's UTC boundaries. If the page
carries `adfree`, a month in which support meets the indexed goal obliges the creator to publish no acceptance in the
following month.

## Feed recipe (33475)

```
content: JSON recipe
tags: [["d", <slug>], ["title", <name>], ["t", <topic>]...]
```

The default recipe every new reader starts with:

```json
{
  "name": "For you",
  "description": "The best of the whole network, learning what you like as you go. It all happens on your device.",
  "sources": { "follows": true, "trusted": true, "everyone": true, "topics": [] },
  "weights": { "recency": 0.3, "trust": 0.2, "engagement": 0.5, "topic": 0.4, "similarity": 0.8 },
  "halfLifeHours": 24,
  "sponsored": "show",
  "maxPerAuthor": 3,
  "mutedWords": [],
  "model": "transformers.js:Xenova/all-MiniLM-L6-v2"
}
```

The candidate posts come from the sources the recipe turns on:

- `follows`: accounts the reader follows.
- `trusted`: accounts with a positive web-of-trust score.
- `topics`: posts with a matching `t` tag.
- `everyone`: every post the client fetched. A new reader with no follows needs this.

A recipe is data, never code. Clients enforce these limits:

- Weights are between 0 and 1.
- `sponsored` is `show`, `downrank` or `hide`.
- Strings are at most 500 characters and lists at most 100 items.
- Unknown fields are dropped.

The ranking signals, each between 0 and 1:

| Signal | Value |
|---|---|
| recency | `0.5^(age / halfLife)` |
| trust | 1 for accounts the reader follows, otherwise the client's web-of-trust score |
| engagement | `n / (n + 3)`, where `n` counts reactions and zaps from trusted accounts |
| topic | 1 if a `t` tag matches one of the recipe's topics |
| similarity | Cosine similarity between the post's embedding and the reader's interest vector, both from a local model |

The score is the weighted mean of the signals. It is halved for sponsored posts under `downrank`. Posts beyond
`maxPerAuthor` from one author move to the end.

## Comments and votes

Replies to kind-1 notes are kind-1 notes with NIP-10 `root` and `reply` markers. Comments on anything else (photos,
videos, episodes, listings) are NIP-22 kind-1111 comments, scoped by `A` (addressable roots, so edits keep their thread) or `E`. Votes are NIP-25 reactions
(`-` down, anything else up, empty withdraws), and only each voter's latest reaction counts. "Best" is the lower bound
of the Wilson interval at 80% confidence, and "Controversial" is `(up + down) ^ (min/max)`.

## Media

Standard formats, so other Nostr apps' media appears too:

| Format | Kinds | Media |
| --- | --- | --- |
| Photos | 20 (NIP-68) | one `imeta` per image: `url`, `m`, optional `dim` and `alt` |
| Videos | 21, and addressable 34235 (NIP-71) | `imeta` with `url`, `m`, `image` (poster), `duration`, `dim` |
| Shorts | 22, and addressable 34236 (NIP-71) | as videos |
| Episodes | 54 (NIP-F4) | `["audio", url, type]`, optional `["image", url]` and `["description", …]` |

Each also carries `title` and the hashtags in its text as `t` tags. Kind-1 notes are shown in a format too, by the
first `https` link in their content: a video file makes a video, an audio file an episode (with an image link as its
cover), and image files a photo post. Only `https` media is shown, and HLS (`.m3u8`) is not played yet. Safety rules
read `title`, `summary`, `description` and `alt` (including `alt` inside `imeta`) along with the content.

## Search

Search covers members only: hashtags use `#t` filters with the members as `authors`; free text is matched on the device
against members' recent events. Clients apply the same safety rules to results as to the feed. Relays that support
NIP-50 may be used too, with the same `authors` restriction.

## Membership

Fairground is its own network. An account is a member when it has published a key binding (3470) with an ML-DSA-65
key; clients show content only from members. Relays are storage: a client fetches the bindings to know who is on
Fairground, and checks unknown authors' bindings when it meets them.

## Podcasts

### Show (33478)

Addressable, signed with Nostr only. `content` is the description.

- `["d", <slug>]`, `["title", …]`, `["image", <square artwork, 1400–3000 px, .jpg or .png>]`, `["author", …]`
- `["category", <Apple category>, <subcategory>?]`, `["explicit", "true" | "false"]`, `["language", <ISO 639>]`
- `["type", "episodic" | "serial"]`, `["guid", <podcast:guid>]`: UUID v5 of the first feed URL, kept if the show moves
- Optional: `["owner", <name>, <email>]`, `["r", <website>]`, `["copyright", …]`

### Episode (NIP-F4 kind 54, extended)

- `["a", "33478:<pubkey>:<slug>"]`: the show; it must be the author's own.
- `["guid", <uuid>]`: stays the same across edits; the newest event with a GUID is the episode.
- `["audio", <url>, <mime>]`, `["size", <bytes>]`, `["duration", <seconds>]`, `["title", …]`, `["description", …]`
- Optional: `["episode", n]`, `["season", n]`, `["episode_type", "trailer" | "bonus"]`, `["explicit", "true"]`,
  `["image", url]`, `["hls", url]`, `["transcript", url, mime]`
- `["mp3", <version>, <sample rate>, <channels>, <id3 end>, <audio start>, <audio end>]`: the file's MP3 layout.
- `["break", <seconds>, <byte offset>?]`: a mid-roll point; the offset is the MP3 frame boundary at that time.

### RSS

A gateway renders RSS 2.0 with the `itunes` and `podcast` namespaces: `itunes:image`, `itunes:category`,
`itunes:explicit`, `itunes:owner`, `podcast:guid`, `podcast:locked` (when there is an owner email), and per item a
non-permalink `guid`, an `enclosure` with length and type, `itunes:duration`, episode and season numbers, and HLS as
`podcast:alternateEnclosure`. Enclosures point at the gateway, which redirects to the file or streams a stitched copy.

## Host-read ads

### Campaign (33479)

The advertiser's plan, signed with Nostr only (offers made from it are the contracts). `content` is a free-text brief.
`["d"]`, `["title"]`, `["objective", "awareness" | "consideration" | "conversions"]`, `["product"]`, `["offer"]`,
`["r", <landing page>]`, `["code", <promo base>]`, `["flight", <start>, <end>]`, `["budget", <micros>]`,
`["cpm", <micros>]`, and lists of `point`, `avoid`, `format`, `media`, `slot`, `t`, `region`, `language`, `exclude`;
`["approval", "read"]` when the advertiser approves reads.

### Offer terms

An offer (33470) may carry `["format", "post" | "host-read"]`, `media`, `slot`, `["flight", start, end]`, `point`,
`avoid`, `["r", <tracked link>]`, `["code", <this creator's promo code>]`, `["approval", "read"]` and
`["a", <campaign address>]`. The acceptance embeds the offer, so the terms are fixed with it.

### Placement (33480)

The creator's delivery for a host-read deal, replaceable per deal (`d` is the acceptance id); hybrid-signed when the
creator has a post-quantum key. `content` is the script.

- `["e", <acceptance>, "", "sponsorship"]`, `["p", <advertiser>]`, `["flight", <start>, <end>]`, `["label", …]`
  (must disclose the sponsorship), one or more `["slot", "pre" | "mid" | "post"]`
- `["spot", <url>, <mime>, <seconds>, <version>?, <sample rate>?, <channels>?, <audio start>?, <audio end>?]`: the
  recording; the MP3 fields let gateways splice it in.
- `["a", <show>]` to restrict it to shows (all shows when absent), `["scope", "video"]` to include videos,
  `["r", <link>]`, `["code", <promo code>]`, `["t", "ad"]`

It counts as the deal's delivery when it is by the creator, references the acceptance, names the advertiser, was
published between acceptance and deadline, stays within the offer's flight (a day's grace either side) and uses only the
offer's slots. The payment receipt's `delivery` is the placement version that was paid for.

### Approval (3481)

The advertiser's verdict on one exact placement version, hybrid-signed: `["e", <placement id>, "", "placement"]`,
`["a", <placement address>]`, `["p", <creator>]`, `["status", "approved" | "changes"]`, `content` the note. The newest
verdict counts; re-recording needs a new approval.

### Playing ads

A placement plays while now is inside its flight, its acceptance exists (by the creator, embedding an offer from the
advertiser), and, if the offer asks for approval, the advertiser approved this version and hasn't since asked for
changes. Pre-rolls play at the start, mid-rolls at the episode's break marks, post-rolls at the end, at most three per
break, earliest flight first. Audio reads play in episodes; video reads (or audio over a card) in videos when the
placement includes them. Players label each ad with the placement's label and let listeners skip.

A gateway stitches MP3 downloads as: the episode's ID3 tag, pre-roll reads, the episode's audio frames split at each
break's byte offset with the reads between, then post-roll reads. Xing/Info header frames are left out. Reads whose
MPEG version, sample rate or channels differ from the episode's are skipped. Downloads with nothing to insert redirect
to the file.


## Built-in wallet

An account's wallet is the Algorand Ed25519 account whose seed is `HKDF-SHA256(ikm = Nostr secret key, salt =
"fairground", info = "algorand-wallet/v1", 32 bytes)`. Payments from it are ordinary USDC transfers with the same memos
as payment links.

### Starting a wallet

A gateway may sponsor new wallets. The wallet builds and signs, and the sponsor rebuilds and checks, one atomic group:

1. a payment of 250,000 micro-ALGO from the sponsor to the wallet, fee twice the minimum, note
   `fairground:starter:<member pubkey>`;
2. the wallet's USDC opt-in (a zero-amount USDC transfer to itself), fee 0.

Both use the opt-in's validity window and genesis. The sponsor refuses an opt-in that differs in any field from the one
it would build, a wallet that already holds USDC or 0.2 ALGO, a member who already has a starter payment (found by note
prefix), and anything past its daily cap (counted the same way).

### Gateway requests

Wallet and ramp calls carry a NIP-98 `Authorization: Nostr <base64 event>` header: kind 27235, `u` the exact URL,
`method`, and `payload` (SHA-256 of the body) when there is one, created within 60 seconds. Only members (accounts
with a key binding) are served.

- `GET /wallet/config` → `{ starter: <sponsor address> | null, ramp: boolean }`
- `POST /wallet/start` `{ optIn: <base64 signed opt-in> }` → `{ txid }`
- `POST /ramp/session` `{ side: "BUY" | "SELL", walletAddress, amount?, redirectURL }` → `{ url }`, a single-use
  Transak widget link; the member's pubkey is the order's `partnerCustomerId`.
- `GET /ramp/order/<id>` → `{ order, problem }`. A wallet pays into a sale only when `problem` is null: the order is
  the member's own, a sale of USDC on Algorand, and waiting for the USDC. The payment's memo is
  `fairground:cashout:<order id>`.

## Listings (NIP-99, kind 30402)

Standard NIP-99 tags, plus:

- `["type", item | food | service | request | rental]`
- `["payto", <rail id>, <address>]`
- `["fulfillment", pickup | delivery | shipping | onsite | remote …]`
- `["a", "33477:<pubkey>:<slug>"]`, the store
- `g` tags at every precision from 2 up

Listings are hybrid-signed. Clients take payment in-app only for USD prices with a post-quantum-verified `payto`.

## Storefront (33477)

```
content: about
tags: [["d", <slug>], ["name", …], ["type", shop | restaurant | services], ["payto", …], ["status", open | closed],
       ["hours", …]?, ["location", …]?, ["image", …]?, ["fulfillment", …]?, ["g", …]...]
```

## Orders, quotes and updates

These are private NIP-17 messages (kind 14, sealed and gift-wrapped). The readable text goes in the content, and the
structured data in a `["fairground", <json>]` tag:

- `fairground/order`: `orderId`, `lines` (`listing`, `title`, `quantity`, `unitPrice` in micro-dollars), `total`
  (which must equal the lines), `fulfillment`, `note`, `payTo`.
- `fairground/quote`: a helper's price for a request (`listing`, `title`, `amount`, `payTo`).
- `fairground/order-status`: `accepted`, `declined`, `ready`, `on-the-way`, `completed` or `cancelled`, sent by the
  seller.
- `fairground/order-paid`: `txid`, sent by the buyer.

`orderId = sha256("<buyer pubkey>:<nonce>")`, and the payment memo is `fairground:order:<orderId>`.

## Review (3479)

```
content: text
tags: [["p", <seller>], ["rating", 1–5], ["tx", <rail id>, <txid>], ["order", <orderId>, <nonce>], ["a", <listing>]?]
```

A review counts when all of these hold:

- It is hybrid-signed.
- `sha256("<reviewer pubkey>:<nonce>")` equals `orderId`.
- The transfer's memo is the order's memo.
- The transfer went to one of the seller's addresses.
- The transfer isn't already claimed by an earlier review.

## Credential (3480)

```
content: note
tags: [["p", <subject>], ["credential", <type>], ["expires", <unix>]?, ["r", <evidence>]?]
```

Credentials are hybrid-signed. Each reader decides what a credential is worth:

- **Verified:** the issuer is one the reader trusts.
- **Vouched:** the issuer is someone the reader follows.
- **Self-declared:** the issuer is the subject.

Credentials from anyone else don't count. Expired ones are ignored.

## Reports (NIP-56, kind 1984)

`["e", <id>, <reason>]` and `["p", <pubkey>, <reason>]`. Clients hide reported accounts for the reporter. They may use
other people's reports as one signal, but never alone, since reports can be weaponised.

## Rails

| Id | Asset | Addresses | Verification |
|---|---|---|---|
| `algorand:usdc` | USDC, ASA 31566704, 6 decimals | Base32 with checksum; creators should use Falcon-1024 accounts | Any mainnet indexer: `GET /v2/transactions/{id}` for deals; `GET /v2/transactions?address=…&address-role=receiver&note-prefix=…` for support. Genesis hash must be mainnet. |
