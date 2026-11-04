/** Server-only configuration shared by the production service and local sandbox preview. */
import type { RampOptions } from '../src/ramp.ts';

export function meldOptions(settings: Record<string, string | undefined>, environment: 'sandbox' | 'production'): RampOptions {
  const required = (name: string) => {
    const value = settings[name]?.trim();
    if (!value) throw new Error(`missing setting: ${name}`);
    return value;
  };
  // Cash-outs are optional: set all three to turn them on, so buying can open before a cash-out supplier is approved.
  const sell = ['MELD_SELL_PROVIDER', 'MELD_USDC_CURRENCY_CODE', 'MELD_SELL_PAYMENT_METHOD'];
  const selling = sell.some((name) => settings[name]?.trim());
  return {
    apiKey: required(environment === 'sandbox' ? 'MELD_SANDBOX_API_KEY' : 'MELD_API_KEY'), environment,
    buyProvider: required('MELD_BUY_PROVIDER'), algoCurrencyCode: required('MELD_ALGO_CURRENCY_CODE'),
    ...(selling ? { sellProvider: required(sell[0]), usdcCurrencyCode: required(sell[1]), sellPaymentMethod: required(sell[2]) } : {}),
    ...(settings.MELD_CHECKOUT_ORIGINS ? { checkoutOrigins: settings.MELD_CHECKOUT_ORIGINS.split(',').map((s) => s.trim()) } : {}),
  };
}
