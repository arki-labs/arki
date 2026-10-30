import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Preview } from './preview';

afterEach(() => {
  vi.resetModules();
  vi.doUnmock('unified');
});

describe('Preview', () => {
  it('renders the markdown', async () => {
    render(<Preview md="hello **world**" />);
    const strong = await screen.findByText('world', {}, { timeout: 30_000 });
    expect(strong.tagName).toBe('STRONG');
  }, 40_000);

  it('shows an alert with Retry when the markdown pipeline rejects, instead of an empty box', async () => {
    vi.doMock('unified', () => ({
      unified: () => {
        const chain = { use: () => chain, process: () => Promise.reject(new Error('plugin broke')) };
        return chain;
      },
    }));
    const { Preview: BrokenPreview } = await import('./preview');
    render(<BrokenPreview md="x" />);
    expect(await screen.findByRole('alert', {}, { timeout: 15_000 })).toHaveProperty('textContent', expect.stringContaining('could not be rendered'));
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  }, 40_000);
});
