/** Server-only configuration shared by the production service and local sandbox preview. */
import type { RampOptions } from '../src/ramp.ts';

export function meldOptions(settings: Record<string, string | undefined>, environment: 'sandbox' | 'production'): RampOptions {
  const required = (name: string) => {
    const value = settings[name]?.trim();
    if (!value) throw new Error(`missing setting: ${name}`);
    return value;
  };
  return {
    apiKey: required(environment === 'sandbox' ? 'MELD_SANDBOX_API_KEY' : 'MELD_API_KEY'), environment,
    buyProvider: required('MELD_BUY_PROVIDER'), sellProvider: required('MELD_SELL_PROVIDER'),
    algoCurrencyCode: required('MELD_ALGO_CURRENCY_CODE'), usdcCurrencyCode: required('MELD_USDC_CURRENCY_CODE'),
    sellPaymentMethod: required('MELD_SELL_PAYMENT_METHOD'),
    ...(settings.MELD_CHECKOUT_ORIGINS ? { checkoutOrigins: settings.MELD_CHECKOUT_ORIGINS.split(',').map((s) => s.trim()) } : {}),
  };
}
