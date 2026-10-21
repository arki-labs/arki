import { createServerFn } from '@tanstack/react-start';

import { readProtocolPage, readResultsText } from './-agents-data.server';

/** What `/agents` shows: the protocol as html and the raw results text (null until the benchmark has run). */
export const getAgentsPageFn = createServerFn({ method: 'GET' }).handler(async () => ({
  protocol: await readProtocolPage(),
  resultsText: readResultsText(),
}));
