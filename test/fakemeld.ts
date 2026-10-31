/** Documented Meld payloads, served in-process; no credentials, provider calls or real funds. */
import type { RampOptions } from '../src/ramp.ts';

export const MELD_TEST_OPTIONS: RampOptions = {
  apiKey: 'test-key', environment: 'production', buyProvider: 'TEST_BUY', sellProvider: 'TEST_SELL',
  algoCurrencyCode: 'ALGO', usdcCurrencyCode: 'USDC_ALGORAND', sellPaymentMethod: 'ACH',
};

export function fakeMeld(deposit: string) {
  const calls: { url: string; headers: Headers; body?: Record<string, unknown> }[] = [];
  const sessions = new Map<string, Record<string, unknown>>();
  const fake = {
    calls, sessions,
    transactionPatch: {} as Record<string, unknown>,
    detailsPatch: {} as Record<string, unknown>,
    quotePatch: {} as Record<string, unknown>,
    currencyPatch: {} as Record<string, unknown>,
    responsePatch: {} as Record<string, unknown>,
    emptyQuotes: false,
    fetch: (async (input, init) => {
      const url = String(input);
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
      calls.push({ url, body, headers: new Headers(init?.headers) });
      if (url.includes('/network-partner/supported/currencies?')) return Response.json({ currencies: [
        { currencyCode: 'ALGO', chainCode: 'ALGO', ...fake.currencyPatch },
        { currencyCode: 'USDC_ALGORAND', chainCode: 'ALGO', contract: '31566704', ...fake.currencyPatch },
      ] });
      if (url.endsWith('/payments/crypto/quote')) {
        const buy = body!.sourceCurrencyCode === 'USD';
        return Response.json({ quotes: fake.emptyQuotes ? [] : [{
          transactionType: buy ? 'CRYPTO_PURCHASE' : 'CRYPTO_SELL',
          sourceCurrencyCode: body!.sourceCurrencyCode, destinationCurrencyCode: body!.destinationCurrencyCode,
          sourceAmount: body!.sourceAmount, destinationAmount: Number(body!.sourceAmount) * 0.98,
          serviceProvider: (body!.serviceProviders as string[])[0], paymentMethodType: body!.paymentMethodType,
          totalFee: Number(body!.sourceAmount) * 0.02, ...fake.quotePatch,
        }] });
      }
      if (url.endsWith('/crypto/session/widget')) {
        const id = `session-${sessions.size + 1}`;
        sessions.set(id, body!);
        return Response.json({ id, externalSessionId: body!.externalSessionId, externalCustomerId: body!.externalCustomerId, widgetUrl: `https://meldcrypto.com?token=${id}`, ...fake.responsePatch });
      }
      const match = /\/payments\/transactions\/sessions\/([A-Za-z0-9_-]+)$/.exec(url);
      if (match && sessions.has(match[1])) {
        const session = sessions.get(match[1])!;
        const data = session.sessionData as Record<string, unknown>;
        const sell = session.sessionType === 'SELL';
        return Response.json({ transaction: {
          id: `transaction-${match[1]}`, sessionId: match[1], externalSessionId: session.externalSessionId,
          externalCustomerId: session.externalCustomerId, serviceProvider: data.serviceProvider,
          transactionType: sell ? 'CRYPTO_SELL' : 'CRYPTO_PURCHASE', status: 'PENDING',
          sourceAmount: Number(data.sourceAmount), destinationAmount: Number(data.sourceAmount) * 0.98,
          sourceCurrencyCode: data.sourceCurrencyCode, destinationCurrencyCode: data.destinationCurrencyCode,
          cryptoDetails: { sourceWalletAddress: sell ? data.walletAddress : deposit, destinationWalletAddress: sell ? deposit : data.walletAddress, ...fake.detailsPatch },
          ...fake.transactionPatch,
        } });
      }
      return Response.json({ code: 'NOT_FOUND' }, { status: 404 });
    }) as typeof fetch,
  };
  return fake;
}
