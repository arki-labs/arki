/**
 * Tax exemptions: review, dates, and the sale they change
 *
 * An exemption keeps tax off a sale, so it must not take effect before someone
 * approved it, and a sale priced for an exempt customer must show no tax. These
 * tests run the real repositories on PGlite and the real StripeProvider on a
 * fake HTTP layer.
 */
import type { PGlite } from '@electric-sql/pglite';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { instant } from '@arki/date';
import { FAILURE_ERROR_CODES, FailureError, InvalidInput, orThrow } from '@arki/failure';
import { money } from '@arki/money';

import { StripeProvider } from '../core/providers/stripe-provider.js';
import { createFakeStripeHttp } from '../core/providers/stripe-test-support.js';
import { customerId, openDb, rejectionOf, schema } from '../test-support.js';
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

/** The not-found answer of a tax repository method for `id`. */
function notFound(kind: string, id: string) {
  return { code: TaxReferenceNotFound.code, data: { kind, id } };
}

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

  it('cannot end before it starts: the contract, the repository and the table all say no', async () => {
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
    // A caller that skips the contract gets a failure it can answer with, not the table's raw CHECK error
    const refused = await repos.exemptions.createExemption(input);
    expect(refused).toMatchObject({ code: 'schema.invalid_input' });
    expect(InvalidInput.is(refused) && refused.data.issues[0]?.message).toMatch(/validTo must not be before validFrom/);
    expect(await db.select().from(tax.taxExemptions).where(eq(tax.taxExemptions.customerId, 'cus_dates'))).toEqual([]);
    await expect(db.insert(tax.taxExemptions).values(input)).rejects.toThrow();
  });
});

describe('an exemption update', () => {
  // An admin edits one field at a time; the row the edit leaves behind must still pass the table CHECKs
  it('that leaves no target, or an end before the start, returns schema.invalid_input and writes nothing', async () => {
    const created = orThrow(await repos.exemptions.createExemption({
      type: 'customer',
      customerId: 'cus_update',
      exemptionCode: 'UPDATE',
      reason: 'Registered charity',
      validFrom: instant('2026-06-01T00:00:00Z'),
    }));

    const noTarget = await repos.exemptions.updateExemption(created.id, {
      customerId: null,
      productCode: null,
      jurisdictionId: null,
      reason: 'cleared',
    });
    expect(noTarget).toMatchObject({ code: 'schema.invalid_input' });
    expect(InvalidInput.is(noTarget) && noTarget.data.issues[0]?.message).toMatch(/needs a customer/);

    const endsEarly = await repos.exemptions.updateExemption(created.id, { validTo: instant('2026-05-01T00:00:00Z') });
    expect(endsEarly).toMatchObject({ code: 'schema.invalid_input' });
    expect(InvalidInput.is(endsEarly) && endsEarly.data.issues[0]?.message).toMatch(/validTo must not be before/);

    // Moving the start past a stored end is the same refusal, read from the stored row
    orThrow(await repos.exemptions.updateExemption(created.id, { validTo: instant('2026-07-01T00:00:00Z') }));
    const startsLate = await repos.exemptions.updateExemption(created.id, { validFrom: instant('2026-08-01T00:00:00Z') });
    expect(startsLate).toMatchObject({ code: 'schema.invalid_input' });

    const stored = await repos.exemptions.findExemptionById(created.id);
    expect(stored).toMatchObject({ customerId: 'cus_update', reason: 'Registered charity' });
    expect(stored?.validFrom.toString()).toBe('2026-06-01T00:00:00Z');
    expect(stored?.validTo?.toString()).toBe('2026-07-01T00:00:00Z');

    // A valid edit that swaps the target in one update still goes through
    const moved = orThrow(await repos.exemptions.updateExemption(created.id, { customerId: null, productCode: 'txcd_moved' }));
    expect(moved).toMatchObject({ customerId: null, productCode: 'txcd_moved' });
    // Leave no pending review behind for the stats test
    orThrow(await repos.exemptions.revokeExemption(created.id));
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
    const current = orThrow(await repos.configurations.createConfiguration({ name: 'Current default', isDefault: true }));

    const refused = await repos.configurations.setDefaultConfiguration(orThrow(createTaxConfigId()));

    expect(TaxReferenceNotFound.is(refused)).toBe(true);
    const kept = await repos.configurations.findDefaultConfiguration();
    expect(kept?.id).toBe(current.id);
  });
});

describe('a jurisdiction id that names no jurisdiction', () => {
  // An admin form passes the id it was given; a stale or mistyped one must be a failure the route can answer with 404, never a raw Postgres 23503
  it('is refused as TaxReferenceNotFound by every jurisdiction and exemption write, and nothing is written', async () => {
    const missing = orThrow(createTaxJurisdictionId());
    const notFound = { code: 'payments.tax_reference_not_found', data: { kind: 'jurisdiction', id: missing } };

    const orphan = await repos.jurisdictions.createJurisdiction({
      name: 'Orphan State',
      code: 'OS',
      type: 'state',
      countryCode: 'OS',
      parentId: missing,
    });
    expect(orphan).toMatchObject(notFound);
    expect(await repos.jurisdictions.findJurisdictionByCode('OS', 'OS')).toBeNull();

    const country = orThrow(await repos.jurisdictions.createJurisdiction({ name: 'Refland', code: 'RF', type: 'country', countryCode: 'RF' }));
    expect(await repos.jurisdictions.updateJurisdiction(country.id, { parentId: missing })).toMatchObject(notFound);
    const unmoved = await repos.jurisdictions.findJurisdictionById(country.id);
    expect(unmoved?.parentId).toBeNull();

    const exemption = {
      type: 'jurisdiction' as const,
      customerId: 'cus_missing_place',
      exemptionCode: 'NOWHERE',
      reason: 'Exempt in a place that does not exist',
      validFrom: past,
    };
    expect(await repos.exemptions.createExemption({ ...exemption, jurisdictionId: missing })).toMatchObject(notFound);
    expect(await repos.exemptions.findCustomerExemptionsInRange('cus_missing_place', past, instant('2100-01-01T00:00:00Z'))).toEqual([]);

    const created = orThrow(await repos.exemptions.createExemption({ ...exemption, jurisdictionId: country.id }));
    expect(await repos.exemptions.updateExemption(created.id, { jurisdictionId: missing })).toMatchObject(notFound);
    const kept = await repos.exemptions.findExemptionById(created.id);
    expect(kept?.jurisdictionId).toBe(country.id);
    // The stats test below counts pending exemptions in this database
    await repos.exemptions.deleteExemption(created.id);
  });
});

describe('the exemptions about to expire', () => {
  // `days` is typed, so NaN or a huge count is the caller's bug: it must fail as an invariant before the query, never as `RangeError: Invalid Date`
  it.each([Number.NaN, 0, 366, 1e15])('refuses %s days with the invariant failure code', async days => {
    const error = await rejectionOf(repos.exemptions.findExpiringExemptions(days));

    expect(error).toBeInstanceOf(FailureError);
    expect(error).toMatchObject({ code: FAILURE_ERROR_CODES.invariant });
  });

  it('takes 1 and 365 days, the range the request schema allows', async () => {
    await expect(repos.exemptions.findExpiringExemptions(1)).resolves.toBeInstanceOf(Array);
    await expect(repos.exemptions.findExpiringExemptions(365)).resolves.toBeInstanceOf(Array);
  });
});

describe('a jurisdiction hierarchy', () => {
  // `parentId` can be updated to point anywhere, so a stored chain may loop; reading it must still end
  it('stops where a parent chain comes back to itself', async () => {
    const country = orThrow(await repos.jurisdictions.createJurisdiction({ name: 'Loopland', code: 'LP', type: 'country', countryCode: 'LP' }));
    const state = orThrow(await repos.jurisdictions.createJurisdiction({
      name: 'Loop State',
      code: 'LS',
      type: 'state',
      countryCode: 'LP',
      parentId: country.id,
    }));
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
    const germany = orThrow(await repos.jurisdictions.createJurisdiction({
      name: 'Germany',
      code: 'DE',
      type: 'country',
      countryCode: 'DE',
    }));
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
    const georgia = orThrow(await repos.jurisdictions.createJurisdiction({
      name: 'Georgia',
      code: 'GE',
      type: 'country',
      countryCode: 'GE',
    }));
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
      }).then(created => orThrow(created)),
      repos.jurisdictions.createJurisdiction({
        name: 'Alameda County',
        code: 'ALAMEDA',
        type: 'county',
        countryCode: 'US',
        stateCode: 'CA',
      }).then(created => orThrow(created)),
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

describe('an insert that returns no row', () => {
  it('createConfiguration fails with the invariant failure code', async () => {
    await db.execute(
      sql`CREATE FUNCTION pay.skip_row() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$`,
    );
    await db.execute(
      sql`CREATE TRIGGER skip_tax_config_insert BEFORE INSERT ON pay.tax_configurations FOR EACH ROW EXECUTE FUNCTION pay.skip_row()`,
    );

    try {
      const error = await rejectionOf(repos.configurations.createConfiguration({ name: 'Skipped' }));

      expect(error).toBeInstanceOf(FailureError);
      expect(error).toMatchObject({ code: FAILURE_ERROR_CODES.invariant });
    } finally {
      await db.execute(sql`DROP TRIGGER skip_tax_config_insert ON pay.tax_configurations`);
      await db.execute(sql`DROP FUNCTION pay.skip_row()`);
    }
  });
});

describe('a jurisdiction that rows still name', () => {
  // A delete that met a child or an exemption used to reject with a raw Postgres 23503; an admin screen must get an answer it can show
  it('is kept: deleteJurisdiction returns payments.tax_jurisdiction_in_use, and deletes it once nothing names it', async () => {
    const country = orThrow(await repos.jurisdictions.createJurisdiction({ name: 'Usedland', code: 'UL', type: 'country', countryCode: 'UL' }));
    const state = orThrow(await repos.jurisdictions.createJurisdiction({ name: 'Usedstate', code: 'UL-S', type: 'state', countryCode: 'UL', parentId: country.id }));
    const exemption = orThrow(await repos.exemptions.createExemption({
      type: 'jurisdiction',
      jurisdictionId: state.id,
      exemptionCode: 'USED',
      reason: 'Exempt in the state',
      validFrom: past,
    }));

    expect(await repos.jurisdictions.deleteJurisdiction(country.id)).toMatchObject({
      code: 'payments.tax_jurisdiction_in_use',
      status: 409,
      data: { id: country.id, usedBy: 'jurisdiction', usedById: state.id },
    });
    expect(await repos.jurisdictions.deleteJurisdiction(state.id)).toMatchObject({
      code: 'payments.tax_jurisdiction_in_use',
      data: { id: state.id, usedBy: 'exemption', usedById: exemption.id },
    });
    expect(await repos.jurisdictions.findJurisdictionById(state.id)).not.toBeNull();

    await repos.exemptions.deleteExemption(exemption.id);
    expect(await repos.jurisdictions.deleteJurisdiction(state.id)).toBeUndefined();
    expect(await repos.jurisdictions.deleteJurisdiction(country.id)).toBeUndefined();
    expect(await repos.jurisdictions.findJurisdictionById(country.id)).toBeNull();
    // An unknown id deletes nothing, and is no failure
    expect(await repos.jurisdictions.deleteJurisdiction(country.id)).toBeUndefined();
  });
});

describe('a value a tax column cannot store', () => {
  const nul = 'a\u0000b';
  const long = (length: number) => 'x'.repeat(length);
  const invalid = { code: InvalidInput.code };

  // U+0000, text over the column's length and a bigint in JSON used to reach Postgres and come back as raw 22021, 22001 or 22P05
  it('returns schema.invalid_input from every write, and nothing is written', async () => {
    expect(await repos.configurations.createConfiguration({ name: nul })).toMatchObject(invalid);
    const config = orThrow(await repos.configurations.createConfiguration({ name: 'Storable config' }));
    expect(await repos.configurations.updateConfiguration(config.id, { name: long(256) })).toMatchObject(invalid);
    expect(await repos.configurations.updateConfiguration(config.id, { description: nul })).toMatchObject(invalid);
    expect(await repos.configurations.findConfigurationById(config.id)).toMatchObject({ name: 'Storable config' });
    await repos.configurations.deleteConfiguration(config.id);

    expect(await repos.jurisdictions.createJurisdiction({ name: 'Nul', code: nul, type: 'country', countryCode: 'NL' })).toMatchObject(invalid);
    expect(await repos.jurisdictions.createJurisdiction({ name: 'Long', code: long(21), type: 'country', countryCode: 'LG' })).toMatchObject(invalid);
    const place = orThrow(await repos.jurisdictions.createJurisdiction({ name: 'Storeland', code: 'SL', type: 'country', countryCode: 'SL' }));
    expect(await repos.jurisdictions.updateJurisdiction(place.id, { reducedRates: [{ rate: '5', description: nul, applicableTo: [] }] })).toMatchObject(invalid);

    const exemption = { type: 'customer' as const, customerId: 'cus_storable', exemptionCode: 'OK', reason: 'Storable', validFrom: past };
    expect(await repos.exemptions.createExemption({ ...exemption, reason: nul })).toMatchObject(invalid);
    // A time past the year 9999 used to come back as a raw 22009
    expect(await repos.exemptions.createExemption({ ...exemption, validFrom: instant('+010000-01-01T00:00:00Z') })).toMatchObject(invalid);
    const created = orThrow(await repos.exemptions.createExemption(exemption));
    expect(await repos.exemptions.updateExemption(created.id, { exemptionCode: long(51) })).toMatchObject(invalid);
    expect(await repos.exemptions.approveExemption(created.id, long(256))).toMatchObject(invalid);
    expect(await repos.exemptions.findExemptionById(created.id)).toMatchObject({ exemptionCode: 'OK', status: 'pending_review' });

    await repos.exemptions.deleteExemption(created.id);
    expect(await repos.jurisdictions.deleteJurisdiction(place.id)).toBeUndefined();
  });

  // No stored row holds U+0000, so a read for it finds nothing; Postgres used to refuse the parameter with a raw 22021
  it('finds nothing when a read is asked for U+0000', async () => {
    expect(await repos.jurisdictions.findJurisdictionByCode(nul, 'DE')).toBeNull();
    expect(await repos.jurisdictions.findJurisdictionsByCountry(nul)).toEqual([]);
    expect(await repos.exemptions.findCustomerExemptions(nul)).toEqual([]);
    expect(await repos.exemptions.findCustomerExemptionsInRange(nul, past, instant('2100-01-01T00:00:00Z'))).toEqual([]);
    expect(await repos.exemptions.findApplicableExemptions(nul)).toEqual([]);
    expect(await repos.exemptions.findProductExemptions(nul)).toEqual([]);
  });

  // A typed id (`txc_${string}`) can hold U+0000 too. Each of these used to send it and reject with a raw 22021;
  // the not-found answer of the method comes back instead, and no query is sent
  it('answers not found for an id holding U+0000, by id and as a parent or jurisdiction', async () => {
    const configId = 'txc_a\u0000b' as const;
    const jurisdictionId = 'txj_a\u0000b' as const;
    const exemptionId = 'txe_a\u0000b' as const;

    expect(await repos.configurations.findConfigurationById(configId)).toBeNull();
    expect(await repos.configurations.updateConfiguration(configId, { name: 'X' })).toMatchObject(notFound('configuration', configId));
    expect(await repos.configurations.setDefaultConfiguration(configId)).toMatchObject(notFound('configuration', configId));
    await expect(repos.configurations.deleteConfiguration(configId)).resolves.toBeUndefined();

    expect(await repos.jurisdictions.findJurisdictionById(jurisdictionId)).toBeNull();
    expect(await repos.jurisdictions.findJurisdictionHierarchy(jurisdictionId)).toEqual([]);
    expect(await repos.jurisdictions.updateJurisdiction(jurisdictionId, { name: 'X' })).toMatchObject(notFound('jurisdiction', jurisdictionId));
    expect(await repos.jurisdictions.deleteJurisdiction(jurisdictionId)).toBeUndefined();
    expect(
      await repos.jurisdictions.createJurisdiction({ name: 'Child', code: 'CH0', type: 'state', countryCode: 'CH', parentId: jurisdictionId }),
    ).toMatchObject(notFound('jurisdiction', jurisdictionId));

    expect(await repos.exemptions.findExemptionById(exemptionId)).toBeNull();
    expect(await repos.exemptions.findJurisdictionExemptions(jurisdictionId)).toEqual([]);
    expect(await repos.exemptions.updateExemption(exemptionId, { reason: 'X' })).toMatchObject(notFound('exemption', exemptionId));
    expect(await repos.exemptions.approveExemption(exemptionId, 'usr_admin')).toMatchObject(notFound('exemption', exemptionId));
    expect(await repos.exemptions.revokeExemption(exemptionId)).toMatchObject(notFound('exemption', exemptionId));
    await expect(repos.exemptions.deleteExemption(exemptionId)).resolves.toBeUndefined();
    const exemption = { type: 'jurisdiction' as const, jurisdictionId, exemptionCode: 'NUL', reason: 'Nul', validFrom: past };
    expect(await repos.exemptions.createExemption(exemption)).toMatchObject(notFound('jurisdiction', jurisdictionId));
    expect(await repos.exemptions.findJurisdictionExemptions(jurisdictionId)).toEqual([]);
  });

  it('is refused by the request contracts first', () => {
    expect(createJurisdictionSchema.safeParse({ name: nul, code: 'X', type: 'country', countryCode: 'XX' }).success).toBe(false);
    expect(createJurisdictionSchema.safeParse({ name: 'X', code: 'X', type: 'country', countryCode: 'XX', standardRate: '19.00000001' }).success).toBe(false);
    expect(createExemptionSchema.safeParse({ type: 'customer', customerId: 'cus_1', exemptionCode: 'X', reason: nul, validFrom: past }).success).toBe(false);
  });
});

describe('a new tax row with an id another row has', () => {
  // An explicit id is allowed; one that is taken used to reject with a raw 23505
  it('returns payments.tax_row_exists, and the first row is kept', async () => {
    const config = orThrow(await repos.configurations.createConfiguration({ name: 'First config' }));
    expect(await repos.configurations.createConfiguration({ id: config.id, name: 'Second config' })).toMatchObject({
      code: 'payments.tax_row_exists',
      status: 409,
      data: { kind: 'configuration', id: config.id },
    });

    const place = orThrow(await repos.jurisdictions.createJurisdiction({ name: 'Firstland', code: 'FL', type: 'country', countryCode: 'FL' }));
    expect(await repos.jurisdictions.createJurisdiction({ id: place.id, name: 'Secondland', code: 'SL2', type: 'country', countryCode: 'SL' })).toMatchObject({
      code: 'payments.tax_row_exists',
      data: { kind: 'jurisdiction', id: place.id },
    });

    const exemption = { type: 'customer' as const, customerId: 'cus_twice', exemptionCode: 'ONE', reason: 'First', validFrom: past };
    const first = orThrow(await repos.exemptions.createExemption(exemption));
    expect(await repos.exemptions.createExemption({ ...exemption, id: first.id, exemptionCode: 'TWO' })).toMatchObject({
      code: 'payments.tax_row_exists',
      data: { kind: 'exemption', id: first.id },
    });

    expect(await repos.configurations.findConfigurationById(config.id)).toMatchObject({ name: 'First config' });
    expect(await repos.jurisdictions.findJurisdictionById(place.id)).toMatchObject({ name: 'Firstland' });
    expect(await repos.exemptions.findExemptionById(first.id)).toMatchObject({ exemptionCode: 'ONE' });
    await repos.exemptions.deleteExemption(first.id);
    expect(await repos.jurisdictions.deleteJurisdiction(place.id)).toBeUndefined();
    await repos.configurations.deleteConfiguration(config.id);
  });
});
