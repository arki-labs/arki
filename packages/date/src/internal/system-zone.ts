import { Temporal } from '../types.js';

/** Is this a time zone the runtime knows (IANA name or fixed offset)? Re-exported from `zone`. */
export function isValidTimeZone(id: string): boolean {
  try {
    new Temporal.ZonedDateTime(0n, id);
    return true;
  } catch {
    return false;
  }
}

let systemZone: string | undefined;
let systemZoneCheckedAt = 0;
const SYSTEM_ZONE_TTL_MS = 1000;

/**
 * The runtime's IANA time zone (e.g. `Europe/Bucharest`). The lookup costs
 * ~0.2 ms on the polyfill, so the answer is reused for one second; the zone
 * can change at runtime (`process.env.TZ`, a travelling laptop) and a change
 * shows up within that second.
 */
export function systemTimeZone(): string {
  const now = Date.now();
  if (systemZone === undefined || now - systemZoneCheckedAt > SYSTEM_ZONE_TTL_MS) {
    systemZone = Temporal.Now.timeZoneId();
    systemZoneCheckedAt = now;
  }
  return systemZone;
}
