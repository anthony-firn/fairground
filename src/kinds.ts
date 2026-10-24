/** Event kinds used by Fairground. Provisional until the protocol is proposed as a NIP; none collide with the registry. */
export const KIND = {
  note: 1,
  pqBinding: 3470,
  acceptance: 3471,
  payment: 3472,
  donation: 3473,
  indexValue: 3474,
  survey: 3475,
  tokenRequest: 3476,
  tokenIssue: 3477,
  answer: 3478,
  review: 3479,
  credential: 3480,
  comment: 1111,
  reaction: 7,
  report: 1984,
  listing: 30402,
  supportPage: 13470,
  relayPayout: 13471,
  feedRecipe: 33475,
  mediaKit: 33476,
  store: 33477,
  offer: 33470,
} as const;

/** Domain-separation string for every post-quantum signature Fairground makes. */
export const PROTOCOL = 'fairground/v1';
