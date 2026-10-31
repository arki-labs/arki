import { instantSchema } from '@arki/date/zod';
import { ensure } from '@arki/schema';

import type { CustomerRiskProfile } from './types.js';

const requiredInstant = instantSchema();
const optionalInstant = instantSchema().optional();

/**
 * Give a `customer_risk_profiles` row the types its columns claim.
 *
 * `riskScore`, `paymentHistory` and `engagementMetrics` are jsonb, so Postgres
 * returns their dates as ISO text although the column types say `Instant`.
 * Every read of the table passes through here. A write needs nothing: an
 * `Instant` serializes to the ISO text that this reads back. A stored date that is not an
 * instant is corrupt data, a bug: it throws `AssertError` (`ensure` from `@arki/schema`).
 */
export function readCustomerRiskProfile(row: CustomerRiskProfile): CustomerRiskProfile {
  return {
    ...row,
    riskScore: { ...row.riskScore, lastCalculated: ensure(row.riskScore.lastCalculated, requiredInstant, { at: 'riskScore.lastCalculated' }) },
    paymentHistory: {
      ...row.paymentHistory,
      lastPaymentDate: ensure(row.paymentHistory.lastPaymentDate, optionalInstant, { at: 'paymentHistory.lastPaymentDate' }),
    },
    engagementMetrics: {
      ...row.engagementMetrics,
      lastActivity: ensure(row.engagementMetrics.lastActivity, optionalInstant, { at: 'engagementMetrics.lastActivity' }),
    },
  };
}
