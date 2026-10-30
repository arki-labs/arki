/** feature.test-d.ts of the two-file fixture: the feature imports its reaction, as a real feature file does. */
import type { DepsOf } from '@arki/dot/feature';
import { defineFeature } from '@arki/dot/feature';
import { infra } from '@arki/dot/unit';

import { journalHandlers } from '../../dot.js';
import { sendReceipt } from './reaction.test-d.js';

export type Mailer = { readonly send: (id: string) => void };

const mailer = infra({ name: 'mailer', provides: { mailer: (): Mailer => ({ send: id => void id }) } });

export const core = defineFeature('load-order').infra(mailer);

/** The stage before `.usecases()`: what a reaction may ask for. */
export type Deps = DepsOf<typeof core>;

export const reactions = journalHandlers(core, { effects: [sendReceipt] });
