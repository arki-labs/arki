/**
 * Tax ID formats
 *
 * A checkout that accepts a malformed VAT number sends it to Stripe and to the
 * tax authority on an invoice. Each country below has real valid examples (the
 * numbers published by the registries) and values that must be refused. The
 * old patterns were keyed `<country>_<type>` (`de_eu_vat`), so none matched
 * and every ID passed as valid.
 */
import { describe, expect, it } from 'vitest';

import { checkTaxIdFormat } from './tax-id.js';

const valid: [type: string, country: string, value: string][] = [
  ['eu_vat', 'DE', 'DE123456789'],
  ['eu_vat', 'FR', 'FR40303265045'],
  ['eu_vat', 'NL', 'NL123456789B01'],
  ['eu_vat', 'IT', 'IT12345678901'],
  ['eu_vat', 'ES', 'ESX1234567X'],
  ['eu_vat', 'RO', 'RO1234567890'],
  ['eu_vat', 'PL', 'PL1234567890'],
  ['eu_vat', 'AT', 'ATU12345678'],
  ['eu_vat', 'GR', 'EL123456789'],
  ['eu_vat', 'DE', ' de123456789 '],
  ['gb_vat', 'GB', 'GB123456789'],
  ['gb_vat', 'GB', 'GB123456789012'],
  ['gb_vat', 'GB', 'GBGD001'],
  ['us_ein', 'US', '12-3456789'],
  ['ca_bn', 'CA', '123456789'],
  ['ca_gst_hst', 'CA', '123456789RT0001'],
  ['au_abn', 'AU', '51824753556'],
  ['ch_vat', 'CH', 'CHE-123.456.789 MWST'],
];

const invalid: [type: string, country: string, value: string, why: string][] = [
  ['eu_vat', 'DE', 'DE12345678', 'one digit short'],
  ['eu_vat', 'DE', 'FR123456789', 'another country’s prefix'],
  ['eu_vat', 'DE', '123456789', 'no prefix'],
  ['eu_vat', 'NL', 'NL123456789B1', 'branch suffix is two digits'],
  ['eu_vat', 'GR', 'GR123456789', 'Greece uses EL'],
  ['gb_vat', 'GB', 'GB12345678', 'eight digits'],
  ['us_ein', 'US', '123456789', 'no dash'],
  ['us_ein', 'US', '12-345678', 'short'],
  ['us_ein', 'DE', '12-3456789', 'a US number filed under Germany'],
  ['ca_gst_hst', 'CA', '123456789', 'no RT part'],
  ['au_abn', 'AU', '5182475355', 'ten digits'],
  ['ch_vat', 'CH', 'CHE-123.456.789', 'no tax name'],
];

describe('checkTaxIdFormat', () => {
  it.each(valid)('accepts %s %s %s', (type, country, value) => {
    expect(checkTaxIdFormat({ type, country, value }).format).toBe('valid');
  });

  it.each(invalid)('refuses %s %s %s (%s)', (type, country, value) => {
    expect(checkTaxIdFormat({ type, country, value }).format).toBe('invalid');
  });

  it('says unknown, not valid, for a type or an EU country it has no format for', () => {
    expect(checkTaxIdFormat({ type: 'br_cnpj', country: 'BR', value: '12.345.678/0001-95' }).format).toBe('unknown');
    expect(checkTaxIdFormat({ type: 'eu_vat', country: 'US', value: 'US123' }).format).toBe('unknown');
  });
});
