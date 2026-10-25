/** Explicit, local-only staging preview. Not enabled by ordinary builds. */
export const LOCAL_PILOT = import.meta.env.VITE_LOCAL_PILOT === '1';
export function requireRealPayments(): void {
  if (LOCAL_PILOT) throw new Error('This is a staging preview. Real transfers are disabled.');
}
