/**
 * Dollars in and out, through Transak, a licensed on- and off-ramp that handles identity checks, cards and bank
 * transfers. Buying sends crypto straight to the person's own wallet; selling has the person's wallet send USDC to
 * Transak, which pays their bank. Fairground never holds money or bank details, and these server calls only create
 * widget sessions and read the person's own orders, with the partner credentials kept on the gateway.
 */

export interface RampOptions {
  apiKey: string;
  apiSecret: string;
  environment: 'staging' | 'production';
  /** The site the widget is opened from, as registered with Transak. */
  referrerDomain: string;
  fetch?: typeof fetch;
}

export interface RampOrder {
  id: string;
  status: string;
  side: 'BUY' | 'SELL';
  cryptoCurrency: string;
  network: string;
  cryptoAmount: number;
  fiatAmount: number;
  fiatCurrency: string;
  /** For a sale, where the person's wallet sends the USDC. */
  walletAddress: string;
  customer?: string;
}

const HOSTS = {
  staging: { api: 'https://api-stg.transak.com', gateway: 'https://api-gateway-stg.transak.com' },
  production: { api: 'https://api.transak.com', gateway: 'https://api-gateway.transak.com' },
};

/** Statuses of a sale that is waiting for the person's USDC. */
export const AWAITING_CRYPTO = ['AWAITING_PAYMENT_FROM_USER', 'PROCESSING'];

export function createRamp(opts: RampOptions) {
  const hosts = HOSTS[opts.environment];
  const fetchImpl = opts.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  let token: { value: string; expires: number } | undefined;

  /** The partner access token, valid for a week; refreshed only when it expires. */
  async function accessToken(): Promise<string> {
    if (token && token.expires > Date.now() / 1000 + 300) return token.value;
    const res = await fetchImpl(`${hosts.api}/partners/api/v2/refresh-token`, {
      method: 'POST', headers: { 'x-api-key': opts.apiKey, 'api-secret': opts.apiSecret, 'Content-Type': 'application/json' }, body: JSON.stringify({ apiKey: opts.apiKey }),
    });
    if (!res.ok) throw new Error(`Transak refused the partner credentials (${res.status})`);
    const body = (await res.json()) as { data?: { accessToken?: string; expiresAt?: number }; accessToken?: string; expiresAt?: number };
    const value = body.data?.accessToken ?? body.accessToken;
    if (!value) throw new Error('Transak returned no access token');
    token = { value, expires: body.data?.expiresAt ?? body.expiresAt ?? Date.now() / 1000 + 86400 };
    return value;
  }

  return {
    /**
     * A single-use widget link, valid for five minutes. A wallet's first deposit buys ALGO, which it needs before it can
     * hold USDC; after that, deposits buy USDC.
     */
    async session(p: { side: 'BUY' | 'SELL'; walletAddress: string; customer: string; fiatAmount?: number; cryptoAmount?: number; redirectURL: string; userIp: string; email?: string; asset?: 'USDC' | 'ALGO' }): Promise<string> {
      const widgetParams: Record<string, unknown> = {
        apiKey: opts.apiKey, referrerDomain: opts.referrerDomain, productsAvailed: p.side, network: 'algorand', cryptoCurrencyCode: p.side === 'BUY' ? p.asset ?? 'USDC' : 'USDC',
        fiatCurrency: 'USD', partnerCustomerId: p.customer, redirectURL: p.redirectURL, hideMenu: true, themeColor: 'd9480f',
      };
      if (p.side === 'BUY') Object.assign(widgetParams, { walletAddress: p.walletAddress, disableWalletAddressForm: true, ...(p.fiatAmount ? { fiatAmount: p.fiatAmount } : {}) });
      else Object.assign(widgetParams, { walletRedirection: true, ...(p.cryptoAmount ? { cryptoAmount: p.cryptoAmount } : {}) });
      if (p.email) widgetParams.email = p.email;
      const res = await fetchImpl(`${hosts.gateway}/api/v2/auth/session`, {
        method: 'POST',
        headers: { 'x-api-key': opts.apiKey, 'access-token': await accessToken(), 'x-user-ip': p.userIp, 'Content-Type': 'application/json' },
        body: JSON.stringify({ widgetParams }),
      });
      if (!res.ok) throw new Error(`Transak couldn’t start a session (${res.status})`);
      const url = ((await res.json()) as { data?: { widgetUrl?: string } }).data?.widgetUrl;
      if (!url?.startsWith('https://')) throw new Error('Transak returned no widget link');
      return url;
    },

    async order(id: string): Promise<RampOrder> {
      if (!/^[A-Za-z0-9-]{6,80}$/.test(id)) throw new Error('not an order id');
      const res = await fetchImpl(`${hosts.api}/partners/api/v2/order/${id}`, { headers: { 'x-api-key': opts.apiKey, 'access-token': await accessToken() } });
      if (!res.ok) throw new Error(`Transak couldn’t find the order (${res.status})`);
      const d = (((await res.json()) as { data?: Record<string, unknown> }).data ?? {}) as Record<string, unknown>;
      return {
        id, status: String(d.status ?? ''), side: d.isBuyOrSell === 'SELL' ? 'SELL' : 'BUY', cryptoCurrency: String(d.cryptoCurrency ?? ''), network: String(d.network ?? ''),
        cryptoAmount: Number(d.cryptoAmount ?? 0), fiatAmount: Number(d.fiatAmount ?? 0), fiatCurrency: String(d.fiatCurrency ?? ''), walletAddress: String(d.walletAddress ?? ''),
        customer: typeof d.partnerCustomerId === 'string' ? d.partnerCustomerId : undefined,
      };
    },
  };
}

/** Why a sale shouldn't be paid into, if anything: it must be this person's, waiting for USDC on Algorand. */
export function sellOrderProblem(order: RampOrder, customer: string): string | undefined {
  if (order.side !== 'SELL') return 'that isn’t a cash-out order';
  if (order.customer && order.customer !== customer) return 'that order belongs to someone else';
  if (order.cryptoCurrency.toUpperCase() !== 'USDC' || order.network.toLowerCase() !== 'algorand') return 'that order isn’t for USDC on Algorand';
  if (!AWAITING_CRYPTO.includes(order.status)) return `that order isn’t waiting for payment (${order.status.toLowerCase().replace(/_/g, ' ')})`;
  if (!(order.cryptoAmount > 0) || !order.walletAddress) return 'that order has no amount or address';
}
