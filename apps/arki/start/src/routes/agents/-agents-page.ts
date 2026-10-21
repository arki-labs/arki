import { createServerFn } from '@tanstack/react-start';

import { readProtocolPage, readProtocolSummary, readResultsText } from './-agents-data.server';

/** What `/agents` shows: the protocol as html, its summary cards and the raw results text (null until the benchmark has run). */
export const getAgentsPageFn = createServerFn({ method: 'GET' }).handler(async () => ({
  protocol: await readProtocolPage(),
  summary: readProtocolSummary(),
  resultsText: readResultsText(),
}));
