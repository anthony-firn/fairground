/** Project-wide defaults every client starts with. Readers can change relays and index publishers in settings. */
import { DEFAULT_INDEX, type IndexPolicy } from './pricing.ts';

/** Free public relays, checked October 2026. */
export const DEFAULT_RELAYS = ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.primal.net', 'wss://offchain.pub'];

/** The project's CPI publisher (tools/publish-index.ts). Clients should add independent publishers as they appear. */
export const INDEX_PUBLISHER = 'd1243d5f1daabc712ad1366f4934797189e22805fad0e8b85146ea90d5535fca';

export const DEFAULT_INDEX_POLICY: IndexPolicy = { index: DEFAULT_INDEX, publishers: [INDEX_PUBLISHER], threshold: 1 };

/** Fairground's development fund. Until it is set, clients send the whole donation to relays or skip it. */
export const DEVELOPMENT_ADDRESS: string | undefined = undefined;
