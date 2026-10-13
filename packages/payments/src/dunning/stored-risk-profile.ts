import { instantSchema } from '@arki/date/zod';

import type { CustomerRiskProfile } from './types.js';

const requiredInstant = instantSchema();
const optionalInstant = instantSchema().optional();

/**
 * Give a `customer_risk_profiles` row the types its columns claim.
 *
 * `riskScore`, `paymentHistory` and `engagementMetrics` are jsonb, so Postgres
 * returns their dates as ISO text although the column types say `Instant`.
 * Every read of the table passes through here. A write needs nothing: an
 * `Instant` serializes to the ISO text that this reads back.
 */
export function readCustomerRiskProfile(row: CustomerRiskProfile): CustomerRiskProfile {
  return {
    ...row,
    riskScore: { ...row.riskScore, lastCalculated: requiredInstant.parse(row.riskScore.lastCalculated) },
    paymentHistory: {
      ...row.paymentHistory,
      lastPaymentDate: optionalInstant.parse(row.paymentHistory.lastPaymentDate),
    },
    engagementMetrics: {
      ...row.engagementMetrics,
      lastActivity: optionalInstant.parse(row.engagementMetrics.lastActivity),
    },
  };
}
