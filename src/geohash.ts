/**
 * Geohashes for "near me". Listings carry their geohash at several precisions as `g` tags, so a relay can answer
 * "everything in this area" with an exact tag match. Sellers' locations are rounded to about 5 km by default.
 */
const BASE32 = '0123456789bcdefghjkmnpqrstuvwxyz';

export function encodeGeohash(lat: number, lon: number, precision = 5): string {
  let [latLo, latHi, lonLo, lonHi] = [-90, 90, -180, 180];
  let hash = '';
  let bits = 0;
  let value = 0;
  let even = true;
  while (hash.length < precision) {
    if (even) {
      const mid = (lonLo + lonHi) / 2;
      value = value * 2 + (lon >= mid ? 1 : 0);
      if (lon >= mid) lonLo = mid;
      else lonHi = mid;
    } else {
      const mid = (latLo + latHi) / 2;
      value = value * 2 + (lat >= mid ? 1 : 0);
      if (lat >= mid) latLo = mid;
      else latHi = mid;
    }
    even = !even;
    if (++bits === 5) {
      hash += BASE32[value];
      bits = 0;
      value = 0;
    }
  }
  return hash;
}

export const isGeohash = (s: string): boolean => /^[0-9b-hjkmnp-z]{1,12}$/.test(s);

/** `g` tags for a geohash at precisions 2 (country-sized) through its own, for prefix-style area queries. */
export function geohashTags(hash: string): string[][] {
  if (!isGeohash(hash)) return [];
  return Array.from({ length: hash.length - 1 }, (_, i) => ['g', hash.slice(0, i + 2)]);
}

/** Approximate cell size, for showing "within about N km". */
export const GEOHASH_KM = [5000, 1250, 156, 39, 4.9, 1.2, 0.15];
