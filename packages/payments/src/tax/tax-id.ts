/**
 * Tax ID format checks
 *
 * A format check says whether a value has the shape a country's registry gives out. It cannot say
 * the number is registered: that takes the registry (VIES, HMRC, the IRS). Types are Stripe's tax
 * ID types (`eu_vat`, `us_ein`, ...), the same names `customerDetails.taxIds` carries.
 */

/** Greece writes its VAT numbers with `EL`, not its ISO code `GR`. */
const euVatPrefix: Record<string, string> = { GR: 'EL' };

/** The shape of an EU VAT number after the country prefix, by ISO country code. */
const euVatBody: Record<string, RegExp> = {
  AT: /^U\d{8}$/,
  BE: /^[01]\d{9}$/,
  BG: /^\d{9,10}$/,
  CY: /^\d{8}[A-Z]$/,
  CZ: /^\d{8,10}$/,
  DE: /^\d{9}$/,
  DK: /^\d{8}$/,
  EE: /^\d{9}$/,
  ES: /^[A-Z0-9]\d{7}[A-Z0-9]$/,
  FI: /^\d{8}$/,
  FR: /^[A-Z0-9]{2}\d{9}$/,
  GR: /^\d{9}$/,
  HR: /^\d{11}$/,
  HU: /^\d{8}$/,
  IE: /^(\d{7}[A-Z]{1,2}|\d[A-Z+*]\d{5}[A-Z])$/,
  IT: /^\d{11}$/,
  LT: /^(\d{9}|\d{12})$/,
  LU: /^\d{8}$/,
  LV: /^\d{11}$/,
  MT: /^\d{8}$/,
  NL: /^\d{9}B\d{2}$/,
  PL: /^\d{10}$/,
  PT: /^\d{9}$/,
  RO: /^\d{2,10}$/,
  SE: /^\d{12}$/,
  SI: /^\d{8}$/,
  SK: /^\d{10}$/,
};

/** Types whose shape does not depend on the country. Applied to the value as written, after trim and upper-casing. */
const typePatterns: Record<string, RegExp> = {
  us_ein: /^\d{2}-\d{7}$/,
  gb_vat: /^GB(\d{9}|\d{12}|GD\d{3}|HA\d{3})$/,
  ca_bn: /^\d{9}$/,
  ca_gst_hst: /^\d{9}RT\d{4}$/,
  au_abn: /^\d{11}$/,
  ch_vat: /^CHE-\d{3}\.\d{3}\.\d{3} (MWST|TVA|IVA)$/,
  no_vat: /^\d{9}MVA$/,
  nz_gst: /^\d{8,9}$/,
};

export type TaxIdFormat = {
  /** `unknown` when no format is known for the type, or for the country under `eu_vat`: nothing was checked. */
  format: 'valid' | 'invalid' | 'unknown';
};

/** What `checkTaxIdFormat` takes. `country` is the ISO 3166-1 alpha-2 code the ID was issued in. */
export type TaxIdInput = { type: string; value: string; country: string };

/**
 * Check a tax ID against the format of its type and country.
 * - `valid`: the value has the registry's shape.
 * - `invalid`: it does not.
 * - `unknown`: no format is known for this type (or this country, for `eu_vat`), so the value was not checked.
 */
export function checkTaxIdFormat(taxId: TaxIdInput): TaxIdFormat {
  const type = taxId.type.trim().toLowerCase();
  const country = taxId.country.trim().toUpperCase();
  const value = taxId.value.trim().toUpperCase();

  if (type === 'eu_vat') {
    const body = euVatBody[country];
    if (!body) return { format: 'unknown' };
    const prefix = euVatPrefix[country] ?? country;

    return { format: value.startsWith(prefix) && body.test(value.slice(prefix.length)) ? 'valid' : 'invalid' };
  }

  const pattern = typePatterns[type];
  if (!pattern) return { format: 'unknown' };
  // `us_ein` is a US number: filed under another country it is wrong, whatever its shape
  if (type.slice(0, 2).toUpperCase() !== country) return { format: 'invalid' };

  return { format: pattern.test(value) ? 'valid' : 'invalid' };
}
