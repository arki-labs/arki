/** Every area of the hostile-input gate. The completeness check reads the cases from here. */
import { coreDataArea } from './core-data.cases.js';
import { coreServicesArea } from './core-services.cases.js';
import { coreWebhooksArea } from './core-webhooks.cases.js';
import { dunningRepositoryArea } from './dunning-repository.cases.js';
import { dunningServicesArea } from './dunning-services.cases.js';
import { refundsArea } from './refunds.cases.js';
import { stripeArea } from './stripe.cases.js';
import { taxArea } from './tax.cases.js';

export const areas = [
  coreDataArea,
  coreServicesArea,
  coreWebhooksArea,
  stripeArea,
  dunningRepositoryArea,
  dunningServicesArea,
  taxArea,
  refundsArea,
] as const;
