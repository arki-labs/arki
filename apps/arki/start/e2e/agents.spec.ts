import { expect, test } from '@playwright/test';

test.describe('agent files and the agent benchmark page', () => {
  test('/llms.txt is plain text and at most 80 lines', async ({ request }) => {
    const response = await request.get('/llms.txt');
    expect(response.ok()).toBe(true);
    expect(response.headers()['content-type']).toContain('text/plain');
    const text = await response.text();
    const lines = text.trimEnd().split('\n');
    expect(lines.length).toBeLessThanOrEqual(80);
    expect(lines[0]).toBe('# Arki');
  });

  test('/llms-full.txt is plain text and starts with the glossary', async ({ request }) => {
    const response = await request.get('/llms-full.txt');
    expect(response.ok()).toBe(true);
    expect(response.headers()['content-type']).toContain('text/plain');
    const text = await response.text();
    expect(text.startsWith('# Glossary')).toBe(true);
  });

  test('/agents shows the protocol and either results or the empty state', async ({ page }) => {
    await page.goto('/agents');
    await expect(page.getByRole('heading', { level: 1, name: 'Agent benchmark' })).toBeVisible();
    await expect(page.getByTestId('agents-protocol')).toContainText('Agent Benchmark Protocol');
    const results = page.getByTestId('agents-results');
    const empty = page.getByTestId('agents-empty');
    await expect(results.or(empty)).toBeVisible();
    await expect(page.getByTestId('agents-library-benchmarks').getByRole('row').nth(1)).toBeVisible();
  });
});
