# Fairground protocol (draft)

Fairground adds direct sponsorships to Nostr. Everything here is an ordinary [NIP-01](https://github.com/nostr-protocol/nips/blob/master/01.md)
event, so any relay stores it and any client can read it. The kind numbers are provisional and unregistered; none
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
tags: [["e", <payment receipt id>, "", "payment"], ["tx", <rail id>, <transaction id>, <micro-dollars>, <recipient>]...]
```

`recipient` is `development` or the relay URL whose operator was paid. This event is optional. Clients may suggest a
donation only after a verified payment. They must show the split between development and relays and which relays
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
       ["e", <survey id>, "", "survey"]?]
```

The price is the creator's rate per sponsored post. Advertisers' records are computed from public acceptances,
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

## Rails

| Id | Asset | Addresses | Verification |
|---|---|---|---|
| `algorand:usdc` | USDC, ASA 31566704, 6 decimals | Base32 with checksum; creators should use Falcon-1024 accounts | Any mainnet indexer: `GET /v2/transactions/{id}` for deals; `GET /v2/transactions?address=…&address-role=receiver&note-prefix=…` for support. Genesis hash must be mainnet. |
