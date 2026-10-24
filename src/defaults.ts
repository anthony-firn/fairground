/** Project-wide defaults every client starts with. Readers can change relays and index publishers in settings. */
import { DEFAULT_INDEX, type IndexPolicy } from './pricing.ts';

/**
 * Where Fairground's events are stored: free public relays, checked October 2026. Fairground is its own network (see
 * network.ts): these relays are storage, and the app shows only Fairground accounts from them. Relays run by
 * Fairground members join the list as they sign up for donations.
 */
export const DEFAULT_RELAYS = ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.primal.net', 'wss://offchain.pub'];

/** The project's CPI publisher (tools/publish-index.ts). Clients should add independent publishers as they appear. */
export const INDEX_PUBLISHER = 'd1243d5f1daabc712ad1366f4934797189e22805fad0e8b85146ea90d5535fca';

export const DEFAULT_INDEX_POLICY: IndexPolicy = { index: DEFAULT_INDEX, publishers: [INDEX_PUBLISHER], threshold: 1 };

/**
 * Fairground's development fund, a USDC account on Algorand. Clients check that it can receive USDC before offering
 * it, and send the whole donation to relays when it can't.
 */
export const DEVELOPMENT_ADDRESS: string | undefined = 'UUUBTFPPZGTNNVO5YFYCHDCALODLLS3FWZAZOFWJ7R4KHUGTPAR6WEVSDE';

/**
 * The public podcast gateway: RSS feeds for Apple Podcasts, Spotify and every other podcast app, with host-read ads
 * stitched into downloads. Anyone can run one (gateway.ts); this is the one that serves new shows by default.
 */
export const DEFAULT_GATEWAY = 'https://www.evolvetech.dev/fairground';
