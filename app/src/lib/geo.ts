import { encodeGeohash } from '@core/geohash.ts';

/** The reader's area as a geohash, rounded to about 5 km so a listing never pinpoints someone's home. */
export function currentArea(precision = 5): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('Location isn’t available on this device.'));
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve(encodeGeohash(pos.coords.latitude, pos.coords.longitude, precision)),
      () => reject(new Error('Location permission was declined.')),
      { maximumAge: 600_000, timeout: 10_000, enableHighAccuracy: false },
    );
  });
}
