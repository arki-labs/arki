import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { http, HttpResponse, setupMswServer } from './msw.js';

const server = setupMswServer();
const jobsSchema = z.object({ jobs: z.array(z.unknown()) });
const JOBS_URL = 'https://boards.example.test/v1/boards/:slug/jobs';

/** The code under test: it calls the real `fetch` with a real, encoded URL. */
async function fetchJobs(slug: string): Promise<number> {
  const response = await fetch(`https://boards.example.test/v1/boards/${encodeURIComponent(slug)}/jobs`);
  if (!response.ok) throw new Error(`jobs request failed with ${String(response.status)}`);
  return jobsSchema.parse(await response.json()).jobs.length;
}

describe('setupMswServer', () => {
  it('answers a request with the handler the test added', async () => {
    server.use(http.get(JOBS_URL, () => HttpResponse.json({ jobs: [{ id: 1 }] })));
    await expect(fetchJobs('acme')).resolves.toBe(1);
  });

  it('forgets that handler after the test, and fails an unmatched request', async () => {
    await expect(fetchJobs('acme')).rejects.toThrow();
  });

  it('lets the code see an error status', async () => {
    server.use(http.get(JOBS_URL, () => new HttpResponse(null, { status: 503 })));
    await expect(fetchJobs('acme')).rejects.toThrow(/503/);
  });

  it('matches the encoded path, so a slug with a slash stays one segment', async () => {
    let seen = '';
    server.use(
      http.get(JOBS_URL, ({ request }) => {
        seen = request.url;
        return HttpResponse.json({ jobs: [] });
      }),
    );
    await fetchJobs('weird slug/with-chars');
    expect(seen).toBe('https://boards.example.test/v1/boards/weird%20slug%2Fwith-chars/jobs');
  });
});
