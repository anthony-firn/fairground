import { algorandUsdc, RAIL as ALGORAND_USDC } from './algorand.ts';
import type { Rail } from './rail.ts';

/** Rails a client accepts, by the id offers name them with. */
export const RAILS: Record<string, Rail> = { [ALGORAND_USDC]: algorandUsdc };
