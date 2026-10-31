/**
 * Meld's retail ramp API, version 2026-02-03. API credentials stay on the gateway; providers collect KYC and
 * card/bank details in their hosted checkout. Algorand wallet keys and signing stay on the user's device.
 * Contract: https://docs.meld.io/docs/stablecoins/white-label-api-integration/whitelabel-api-guide/index
 */
import { isAlgorandAddress } from './rails/algorand.ts';
import { parseUsd } from './pricing.ts';

export interface RampOptions {
  apiKey: string;
  environment: 'sandbox' | 'production';
  /** Named suppliers and canonical Algorand currency IDs confirmed with Meld. No automatic supplier fallback. */
  buyProvider: string;
  sellProvider: string;
  algoCurrencyCode: string;
  usdcCurrencyCode: string;
  sellPaymentMethod: string;
  /** Optional account-specific Meld checkout origins, for a white-labelled checkout domain. */
  checkoutOrigins?: string[];
  fetch?: typeof fetch;
}

export interface RampSession {
  id: string;
  externalSessionId: string;
  url: string;
  environment: 'sandbox' | 'production';
}

export interface RampOrder {
  id: string;
  sessionId: string;
  externalSessionId: string;
  status: string;
  side: 'BUY' | 'SELL' | 'UNKNOWN';
  cryptoCurrency: string;
  network: string;
  /** Decimal strings preserve the exact amount used for a cash-out transfer. */
  cryptoAmount: string;
  fiatAmount: number;
  fiatCurrency: string;
  walletAddress: string;
  sourceWalletAddress: string;
  customer: string;
  provider: string;
  environment: 'sandbox' | 'production';
}

export interface RampRequest {
  side: 'BUY' | 'SELL';
  walletAddress: string;
  customer: string;
  amount: number;
  redirectURL: string;
  userIp: string;
  asset: 'USDC' | 'ALGO';
  countryCode: string;
  subdivision?: string;
}

const HOSTS = { sandbox: 'https://api-sb.meld.io', production: 'https://api.meld.io' };
const identifier = /^[A-Za-z0-9_-]{6,128}$/;
export const sessionPrefix = (customer: string) => `fairground-${customer}-`;
const record = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
const text = (v: unknown) => typeof v === 'string' ? v : '';

export function createRamp(opts: RampOptions) {
  if (!HOSTS[opts.environment]) throw new Error('invalid Meld environment');
  for (const value of [opts.buyProvider, opts.sellProvider, opts.algoCurrencyCode, opts.usdcCurrencyCode, opts.sellPaymentMethod]) {
    if (!/^[A-Z0-9_:-]+$/.test(value)) throw new Error('configure the approved Meld suppliers, payment method and Algorand currency IDs');
  }
  if (opts.algoCurrencyCode === opts.usdcCurrencyCode) throw new Error('ALGO and Algorand USDC need distinct Meld currency IDs');
  const fetchImpl = opts.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const origins = opts.checkoutOrigins ?? ['https://meldcrypto.com'];
  const assetChecks = new Map<string, number>();

  async function call(path: string, body?: unknown): Promise<Record<string, unknown>> {
    const response = await fetchImpl(HOSTS[opts.environment] + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: `BASIC ${opts.apiKey}`, 'Meld-Version': '2026-02-03', Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: 'error', signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) {
      // Provider response bodies can contain private data. Return only a stable error and support reference.
      const error = record(await response.json().catch(() => ({})));
      const code = /^[A-Z0-9_]{1,100}$/.test(text(error.code)) ? `: ${error.code}` : '';
      const ref = /^[A-Za-z0-9_-]{1,100}$/.test(text(error.requestId)) ? ` (reference ${error.requestId})` : '';
      throw new Error(`Meld could not complete this request (${response.status}${code})${ref}`);
    }
    return record(await response.json());
  }

  async function checkAsset(p: RampRequest, currency: string, provider: string): Promise<void> {
    const category = p.side === 'BUY' ? 'CRYPTO_ONRAMP' : 'CRYPTO_OFFRAMP';
    const query = new URLSearchParams({ category, country: p.countryCode, type: 'CRYPTO', partner: provider });
    const key = `${query}:${currency}`;
    if ((assetChecks.get(key) ?? 0) > Date.now()) return;
    const catalog = await call(`/network-partner/supported/currencies?${query}`);
    const matches = (Array.isArray(catalog.currencies) ? catalog.currencies : []).map(record).filter((c) => c.currencyCode === currency);
    // A ticker alone cannot distinguish native Algorand USDC from an identically named token on another chain.
    if (!matches.length || matches.some((c) =>
      !['ALGO', 'ALGORAND'].includes(text(c.chainCode).toUpperCase()) ||
      (p.asset === 'USDC' ? String(c.contract) !== '31566704' : !!c.contract),
    )) throw new Error('Meld currency metadata does not uniquely identify the requested native Algorand asset');
    assetChecks.set(key, Date.now() + 300_000);
  }

  return {
    async session(p: RampRequest): Promise<RampSession> {
      if (!isAlgorandAddress(p.walletAddress) || !Number.isFinite(p.amount) || p.amount <= 0 || p.amount > 1_000_000 || !/^[A-Z]{2}$/.test(p.countryCode)) throw new Error('invalid checkout request');
      try { if (parseUsd(String(p.amount)) <= 0n) throw new Error(); } catch { throw new Error('invalid checkout amount'); }
      const buy = p.side === 'BUY';
      if (!buy && p.asset !== 'USDC') throw new Error('cash out USDC on Algorand only');
      const currency = p.asset === 'ALGO' ? opts.algoCurrencyCode : opts.usdcCurrencyCode;
      const provider = buy ? opts.buyProvider : opts.sellProvider;
      await checkAsset(p, currency, provider);
      const paymentMethodType = buy ? 'CREDIT_DEBIT_CARD' : opts.sellPaymentMethod;
      const pair = { sourceCurrencyCode: buy ? 'USD' : currency, destinationCurrencyCode: buy ? currency : 'USD' };
      // Ask only the configured supplier. Never silently switch networks, suppliers or introduce a bridge/swap.
      const quotes = await call('/payments/crypto/quote', {
        ...pair, countryCode: p.countryCode, ...(p.subdivision ? { subdivision: p.subdivision } : {}),
        sourceAmount: p.amount, paymentMethodType, walletAddress: p.walletAddress, externalCustomerId: p.customer,
        serviceProviders: [provider],
      });
      const quote = (Array.isArray(quotes.quotes) ? quotes.quotes : []).map(record).find((q) =>
        q.serviceProvider === provider && q.transactionType === (buy ? 'CRYPTO_PURCHASE' : 'CRYPTO_SELL') &&
        q.sourceCurrencyCode === pair.sourceCurrencyCode && q.destinationCurrencyCode === pair.destinationCurrencyCode &&
        q.paymentMethodType === paymentMethodType && Number(q.destinationAmount) > 0,
      );
      if (!quote) throw new Error('No eligible Meld quote for this amount, location and Algorand asset. Try a different amount or contact support.');
      const externalSessionId = sessionPrefix(p.customer) + crypto.randomUUID();
      const result = await call('/crypto/session/widget', {
        sessionType: p.side, externalCustomerId: p.customer, externalSessionId,
        sessionData: {
          ...pair, countryCode: p.countryCode, sourceAmount: String(p.amount), paymentMethodType, serviceProvider: provider,
          walletAddress: p.walletAddress, clientIpAddress: p.userIp, redirectUrl: p.redirectURL,
          lockFields: ['walletAddress', 'sourceCurrencyCode', 'destinationCurrencyCode', 'sourceAmount', 'paymentMethodType'],
          ...(!buy ? { redirectFlow: true } : {}),
        },
      });
      const url = new URL(text(result.widgetUrl));
      if (url.protocol !== 'https:' || url.username || url.password || !origins.includes(url.origin)) throw new Error('Meld returned an unexpected checkout origin');
      if (!identifier.test(text(result.id)) || result.externalSessionId !== externalSessionId || result.externalCustomerId !== p.customer) throw new Error('Meld returned a different checkout session');
      return { id: text(result.id), externalSessionId, url: url.href, environment: opts.environment };
    },

    /** Look up by the Meld session saved before checkout; redirects do not supply authoritative order information. */
    async order(sessionId: string): Promise<RampOrder> {
      if (!identifier.test(sessionId)) throw new Error('not a Meld session id');
      const result = await call(`/payments/transactions/sessions/${encodeURIComponent(sessionId)}`);
      const d = record(result.transaction);
      const details = record(d.cryptoDetails);
      if (!text(d.id) || d.sessionId !== sessionId) throw new Error('Meld returned a different transaction session');
      const side = d.transactionType === 'CRYPTO_SELL' ? 'SELL' : d.transactionType === 'CRYPTO_PURCHASE' ? 'BUY' : 'UNKNOWN';
      const currency = side === 'SELL' ? d.sourceCurrencyCode : d.destinationCurrencyCode;
      return {
        id: text(d.id), sessionId, externalSessionId: text(d.externalSessionId), status: text(d.status), side,
        cryptoCurrency: currency === opts.usdcCurrencyCode ? 'USDC' : currency === opts.algoCurrencyCode ? 'ALGO' : text(currency),
        network: currency === opts.usdcCurrencyCode || currency === opts.algoCurrencyCode ? 'algorand' : '',
        cryptoAmount: String((side === 'SELL' ? d.sourceAmount : d.destinationAmount) ?? ''),
        fiatAmount: Number(side === 'SELL' ? d.destinationAmount : d.sourceAmount),
        fiatCurrency: text(side === 'SELL' ? d.destinationCurrencyCode : d.sourceCurrencyCode),
        walletAddress: text(details.destinationWalletAddress), sourceWalletAddress: text(details.sourceWalletAddress),
        customer: text(d.externalCustomerId), provider: text(d.serviceProvider), environment: opts.environment,
      };
    },
    sellProvider: opts.sellProvider,
  };
}

/** A cash-out must be owned, pending, in the exact configured Algorand asset, with a real provider deposit address. */
export function sellOrderProblem(order: RampOrder, customer: string): string | undefined {
  if (order.side !== 'SELL') return 'that isn’t a cash-out order';
  if (order.customer !== customer || !order.externalSessionId.startsWith(sessionPrefix(customer))) return 'that order belongs to someone else or has no verified owner';
  if (order.cryptoCurrency !== 'USDC' || order.network !== 'algorand' || order.fiatCurrency !== 'USD') return 'that order isn’t for USDC on Algorand to USD';
  if (order.status !== 'PENDING') return `that order isn’t waiting for payment (${order.status.toLowerCase().replace(/_/g, ' ')})`;
  if (!isAlgorandAddress(order.walletAddress) || !isAlgorandAddress(order.sourceWalletAddress) || order.walletAddress === order.sourceWalletAddress) return 'that order has no valid provider deposit address';
  try { if (parseUsd(order.cryptoAmount) <= 0n) return 'that order has no valid crypto amount'; }
  catch { return 'that order has no valid crypto amount'; }
  if (!Number.isFinite(order.fiatAmount) || order.fiatAmount <= 0) return 'that order has no fiat payout';
}
