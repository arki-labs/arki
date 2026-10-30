/**
 * Tax exemptions: review, dates, and the sale they change
 *
 * An exemption keeps tax off a sale, so it must not take effect before someone
 * approved it, and a sale priced for an exempt customer must show no tax. These
 * tests run the real repositories on PGlite and the real StripeProvider on a
 * fake HTTP layer.
 */
import type { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { instant } from '@arki/date';
import { InvalidInput, orThrow } from '@arki/failure';
import { money } from '@arki/money';

import { StripeProvider } from '../core/providers/stripe-provider.js';
import { createFakeStripeHttp } from '../core/providers/stripe-test-support.js';
import { customerId, openDb, schema } from '../test-support.js';
import { createExemptionSchema, createJurisdictionSchema } from './contracts.js';
import { TaxReferenceNotFound } from './failures.js';
import { createTaxConfigId, createTaxExemptionId, createTaxJurisdictionId } from './primitives.js';
import { createTaxRepositories } from './repository.js';
import { jurisdictionOwnsLine, TaxService } from './service.js';
import { createTaxTables } from './tables.js';

const tax = createTaxTables({ schema });

let client: PGlite;
let db: ReturnType<typeof drizzle>;
let repos: ReturnType<typeof createTaxRepositories>;

/** Stripe answers 19% on 100 EUR in Germany, whatever is asked. */
type StripeJurisdiction = { display_name: string; level: string; country: string; state: string | null };

const GERMANY: StripeJurisdiction = { display_name: 'Germany', level: 'country', country: 'DE', state: null };

function serviceWithStripe(jurisdiction: StripeJurisdiction = GERMANY) {
  const http = createFakeStripeHttp(() => ({
    body: {
      object: 'tax.calculation',
      currency: 'eur',
      amount_total: 11_900,
      tax_amount_exclusive: 1900,
      tax_amount_inclusive: 0,
      line_items: {
        data: [
          {
            tax_breakdown: [
              {
                amount: 1900,
                jurisdiction,
                tax_rate_details: { percentage_decimal: '19' },
              },
            ],
          },
        ],
      },
    },
  }));
  const provider = new StripeProvider(
    { apiKey: 'sk_test_fake', webhookSecret: 'whsec_fake', environment: 'sandbox' },
    { httpClient: http.client, maxNetworkRetries: 0 },
  );

  return { service: new TaxService(provider, repos), requests: http.requests };
}

const sale = {
  customerId,
  currency: 'EUR',
  lineItems: [{ amount: money('100', 'EUR'), description: 'Pro', reference: 'line_1', taxCode: 'txcd_10103000' }],
};

const past = instant('2020-01-01T00:00:00Z');

beforeAll(async () => {
  const opened = await openDb({
    ...tax.enums,
    taxConfigurations: tax.taxConfigurations,
    taxJurisdictions: tax.taxJurisdictions,
    taxExemptions: tax.taxExemptions,
    taxRecords: tax.taxRecords,
  });
  client = opened.client;
  db = drizzle({ client });
  repos = createTaxRepositories(db, tax);
});

afterAll(async () => {
  await client.close();
});

describe('a new exemption', () => {
  it('waits for review, and only approving makes it active', async () => {
    const created = orThrow(await repos.exemptions.createExemption({
      type: 'customer',
      customerId: 'cus_review',
      exemptionCode: 'NONPROFIT',
      reason: 'Registered charity',
      validFrom: past,
    }));

    expect(created.status).toBe('pending_review');
    expect(await repos.exemptions.findApplicableExemptions('cus_review')).toEqual([]);

    orThrow(await repos.exemptions.approveExemption(created.id, 'usr_admin'));

    const applicable = await repos.exemptions.findApplicableExemptions('cus_review');
    expect(applicable.map(e => e.id)).toEqual([created.id]);
  });

  it('cannot end before it starts: the contract and the table both say no', async () => {
    const input = {
      type: 'customer' as const,
      customerId: 'cus_dates',
      exemptionCode: 'X',
      reason: 'r',
      validFrom: instant('2026-06-01T00:00:00Z'),
      validTo: instant('2026-05-01T00:00:00Z'),
    };

    expect(createExemptionSchema.safeParse(input).success).toBe(false);
    expect(createExemptionSchema.safeParse({ ...input, validTo: input.validFrom }).success).toBe(true);
    await expect(repos.exemptions.createExemption(input)).rejects.toThrow();
  });
});

describe('an id with no row', () => {
  // An admin route passes the id it was given; a stale or mistyped one must come back as a failure the route can answer with 404
  it('is refused as TaxReferenceNotFound by every update, and nothing is written', async () => {
    const exemptionId = orThrow(createTaxExemptionId());
    for (const refused of [
      await repos.exemptions.updateExemption(exemptionId, { reason: 'x' }),
      await repos.exemptions.approveExemption(exemptionId, 'usr_admin'),
      await repos.exemptions.revokeExemption(exemptionId),
    ]) {
      expect(TaxReferenceNotFound.is(refused) && refused.data).toEqual({ kind: 'exemption', id: exemptionId });
    }

    const jurisdictionId = orThrow(createTaxJurisdictionId());
    const jurisdiction = await repos.jurisdictions.updateJurisdiction(jurisdictionId, { name: 'x' });
    expect(TaxReferenceNotFound.is(jurisdiction) && jurisdiction.data).toEqual({ kind: 'jurisdiction', id: jurisdictionId });

    const configId = orThrow(createTaxConfigId());
    const config = await repos.configurations.updateConfiguration(configId, { name: 'x' });
    expect(TaxReferenceNotFound.is(config) && config.data).toEqual({ kind: 'configuration', id: configId });
  });

  it('as the new default configuration, keeps the current default', async () => {
    const current = await repos.configurations.createConfiguration({ name: 'Current default', isDefault: true });

    const refused = await repos.configurations.setDefaultConfiguration(orThrow(createTaxConfigId()));

    expect(TaxReferenceNotFound.is(refused)).toBe(true);
    const kept = await repos.configurations.findDefaultConfiguration();
    expect(kept?.id).toBe(current.id);
  });
});

describe('a jurisdiction hierarchy', () => {
  // `parentId` can be updated to point anywhere, so a stored chain may loop; reading it must still end
  it('stops where a parent chain comes back to itself', async () => {
    const country = await repos.jurisdictions.createJurisdiction({ name: 'Loopland', code: 'LP', type: 'country', countryCode: 'LP' });
    const state = await repos.jurisdictions.createJurisdiction({
      name: 'Loop State',
      code: 'LS',
      type: 'state',
      countryCode: 'LP',
      parentId: country.id,
    });
    orThrow(await repos.jurisdictions.updateJurisdiction(country.id, { parentId: state.id }));

    const hierarchy = await repos.jurisdictions.findJurisdictionHierarchy(state.id);

    expect(hierarchy.map(jurisdiction => jurisdiction.id)).toEqual([country.id, state.id]);
  });
});

describe('a jurisdiction rate', () => {
  const jurisdiction = { name: 'Germany', code: 'DE', type: 'country' as const, countryCode: 'DE' };

  it('refuses a negative or absurd rate, in the standard rate and in reduced rates', () => {
    expect(createJurisdictionSchema.safeParse({ ...jurisdiction, standardRate: '19' }).success).toBe(true);
    expect(createJurisdictionSchema.safeParse({ ...jurisdiction, standardRate: '7.5' }).success).toBe(true);
    for (const standardRate of ['-5', '-0.1', '101', 'abc', '']) {
      expect(createJurisdictionSchema.safeParse({ ...jurisdiction, standardRate }).success).toBe(false);
    }
    const reducedRates = [{ rate: '-7', description: 'books', applicableTo: ['books'] }];
    expect(createJurisdictionSchema.safeParse({ ...jurisdiction, reducedRates }).success).toBe(false);
  });
});

describe('exemption stats', () => {
  it('count as numbers, not as the strings the driver returns for count(*)', async () => {
    const stats = await repos.exemptions.getExemptionStats();

    for (const count of Object.values(stats)) expect(typeof count).toBe('number');
    expect(stats.totalActive).toBeGreaterThanOrEqual(1);
    expect(stats.totalPendingReview).toBe(0);
  });
});

const line = (displayName: string, level: string, state: string | null) => ({
  amount: money('1', 'USD'),
  rate: 1,
  jurisdiction: displayName,
  country: 'US',
  state: state ?? undefined,
  level,
});

describe('calculateTax with exemptions', () => {
  it('charges tax when nothing exempts the customer', async () => {
    const { service } = serviceWithStripe();

    const result = orThrow(await service.calculateTax(sale));

    expect(result.taxAmount.toDecimalString()).toBe('19.00');
    expect(result.total.toDecimalString()).toBe('119.00');
    expect(result.appliedExemptionIds).toEqual([]);
  });

  it('charges no tax to a customer with an approved exemption, and does not ask Stripe', async () => {
    const exemption = orThrow(await repos.exemptions.createExemption({
      type: 'customer',
      customerId,
      exemptionCode: 'NONPROFIT',
      reason: 'Registered charity',
      validFrom: past,
    }));
    const { service, requests } = serviceWithStripe();

    const pending = orThrow(await service.calculateTax(sale));
    expect(pending.taxAmount.toDecimalString()).toBe('19.00');

    orThrow(await repos.exemptions.approveExemption(exemption.id, 'usr_admin'));
    const result = orThrow(await service.calculateTax(sale));

    expect(result.taxAmount.toDecimalString()).toBe('0.00');
    expect(result.subtotal.toDecimalString()).toBe('100.00');
    expect(result.total.toDecimalString()).toBe('100.00');
    expect(result.breakdown).toEqual([]);
    expect(result.appliedExemptionIds).toEqual([exemption.id]);
    expect(requests).toHaveLength(1);

    orThrow(await repos.exemptions.revokeExemption(exemption.id));
    const taxed = orThrow(await service.calculateTax(sale));
    expect(taxed.taxAmount.toDecimalString()).toBe('19.00');
  });

  it('never lets a global exemption with no product exempt anyone: it cannot even be created', async () => {
    const global = { type: 'customer' as const, exemptionCode: 'ALL', reason: 'oops', validFrom: past };

    const refused = await repos.exemptions.createExemption(global);
    expect(InvalidInput.is(refused) && refused.data.issues[0]?.message).toMatch(/needs a customer/);
    expect(await db.select().from(tax.taxExemptions).where(eq(tax.taxExemptions.exemptionCode, 'ALL'))).toEqual([]);
    expect(createExemptionSchema.safeParse(global).success).toBe(false);
    // The table refuses it too, for a writer that skips the repository
    await expect(db.insert(tax.taxExemptions).values({ ...global, status: 'active' })).rejects.toThrow();
  });

  it('exempts the customer who owns a blanket exemption, and not another customer', async () => {
    const exemption = orThrow(await repos.exemptions.createExemption({
      type: 'customer',
      customerId: 'cust_owner',
      exemptionCode: 'NONPROFIT',
      reason: 'Registered charity',
      validFrom: past,
    }));
    orThrow(await repos.exemptions.approveExemption(exemption.id, 'usr_admin'));
    const { service } = serviceWithStripe();

    const owner = orThrow(await service.calculateTax({ ...sale, customerId: 'cust_owner' }));
    const stranger = orThrow(await service.calculateTax({ ...sale, customerId: 'cust_stranger' }));

    expect(owner.taxAmount.toDecimalString()).toBe('0.00');
    expect(stranger.taxAmount.toDecimalString()).toBe('19.00');
    expect(stranger.appliedExemptionIds).toEqual([]);
  });

  it('exempts only the lines of the exempt product', async () => {
    const exemption = orThrow(await repos.exemptions.createExemption({
      type: 'product',
      productCode: 'txcd_10501000',
      exemptionCode: 'BOOKS',
      reason: 'Zero-rated',
      validFrom: past,
    }));
    orThrow(await repos.exemptions.approveExemption(exemption.id, 'usr_admin'));
    const { service } = serviceWithStripe();

    const result = orThrow(await service.calculateTax({
      ...sale,
      lineItems: [
        ...sale.lineItems,
        { amount: money('40', 'EUR'), description: 'Book', reference: 'line_2', taxCode: 'txcd_10501000' },
      ],
    }));

    // Stripe priced the taxable line only (100 EUR + 19 tax); the 40 EUR book is added tax-free
    expect(result.subtotal.toDecimalString()).toBe('140.00');
    expect(result.taxAmount.toDecimalString()).toBe('19.00');
    expect(result.total.toDecimalString()).toBe('159.00');
    expect(result.appliedExemptionIds).toEqual([exemption.id]);
  });

  it('removes the tax of an exempt jurisdiction from the breakdown', async () => {
    const germany = await repos.jurisdictions.createJurisdiction({
      name: 'Germany',
      code: 'DE',
      type: 'country',
      countryCode: 'DE',
    });
    const exemption = orThrow(await repos.exemptions.createExemption({
      type: 'jurisdiction',
      jurisdictionId: germany.id,
      customerId,
      exemptionCode: 'DE-EXEMPT',
      reason: 'Reverse charge',
      validFrom: past,
    }));
    orThrow(await repos.exemptions.approveExemption(exemption.id, 'usr_admin'));
    const { service } = serviceWithStripe();

    const result = orThrow(await service.calculateTax({
      ...sale,
      lineItems: [{ amount: money('100', 'EUR'), description: 'Pro', reference: 'line_1', taxCode: 'txcd_other' }],
    }));

    expect(result.breakdown).toEqual([]);
    expect(result.taxAmount.toDecimalString()).toBe('0.00');
    expect(result.total.toDecimalString()).toBe('100.00');
    expect(result.appliedExemptionIds).toEqual([exemption.id]);
  });

  it('tells same-named places in different countries apart: Georgia the country is exempt, Georgia the US state is not', async () => {
    const georgia = await repos.jurisdictions.createJurisdiction({
      name: 'Georgia',
      code: 'GE',
      type: 'country',
      countryCode: 'GE',
    });
    const exemption = orThrow(await repos.exemptions.createExemption({
      type: 'jurisdiction',
      jurisdictionId: georgia.id,
      customerId: 'cust_georgia',
      exemptionCode: 'GE-EXEMPT',
      reason: 'Diplomatic',
      validFrom: past,
    }));
    orThrow(await repos.exemptions.approveExemption(exemption.id, 'usr_admin'));
    const usState = { display_name: 'Georgia', level: 'state', country: 'US', state: 'GA' };
    const country = { display_name: 'Georgia', level: 'country', country: 'GE', state: null };
    const lines = [{ amount: money('100', 'EUR'), description: 'Pro', reference: 'line_1', taxCode: 'txcd_other' }];

    const inUs = orThrow(await serviceWithStripe(usState).service.calculateTax({
      ...sale,
      customerId: 'cust_georgia',
      lineItems: lines,
    }));
    const inGeorgia = orThrow(await serviceWithStripe(country).service.calculateTax({
      ...sale,
      customerId: 'cust_georgia',
      lineItems: lines,
    }));

    expect(inUs.taxAmount.toDecimalString()).toBe('19.00');
    expect(inUs.breakdown).toHaveLength(1);
    expect(inUs.appliedExemptionIds).toEqual([]);
    expect(inGeorgia.breakdown).toEqual([]);
    expect(inGeorgia.appliedExemptionIds).toEqual([exemption.id]);
  });

  it('matches a US state by its subdivision code, and a county only with the same name', async () => {
    const [california, alameda] = await Promise.all([
      repos.jurisdictions.createJurisdiction({
        name: 'California',
        code: 'US-CA',
        type: 'state',
        countryCode: 'US',
        stateCode: 'CA',
      }),
      repos.jurisdictions.createJurisdiction({
        name: 'Alameda County',
        code: 'ALAMEDA',
        type: 'county',
        countryCode: 'US',
        stateCode: 'CA',
      }),
    ]);
    const owns = jurisdictionOwnsLine;
    const stateLine = line('California', 'state', 'CA');
    const countyLine = line('Alameda County', 'county', 'CA');
    const otherCounty = line('Orange County', 'county', 'CA');
    const sameCountyOtherState = line('Alameda County', 'county', 'NY');

    expect(owns(california, stateLine)).toBe(true);
    expect(owns(california, countyLine)).toBe(false);
    expect(owns(alameda, countyLine)).toBe(true);
    expect(owns(alameda, otherCounty)).toBe(false);
    expect(owns(alameda, sameCountyOtherState)).toBe(false);
  });
});
