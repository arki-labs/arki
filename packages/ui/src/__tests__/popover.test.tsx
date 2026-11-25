import type { Popover as PopoverPrimitive } from '@base-ui/react/popover';
import type { ComponentProps } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, expectTypeOf, it } from 'vitest';

import { Popover, PopoverContent, PopoverTrigger } from '../popover';

// jsdom has no layout, so every real element measures 0×0. A virtual element (one of the anchor
// forms Base UI accepts, used to place a panel at a point or a range) carries its own size.
const rowAnchor = {
  getBoundingClientRect: () => DOMRect.fromRect({ x: 20, y: 600, width: 248, height: 50 }),
};

function positionerOf(panel: HTMLElement): HTMLElement {
  const positioner = panel.parentElement;
  if (!positioner) throw new Error('the popup renders inside its positioner');
  return positioner;
}

// Why: a small trigger (an initials button) must be able to open a panel as wide as the row it sits
// in. The panel's width reads `--anchor-width`, so that variable has to follow the anchor, not the trigger.
describe('PopoverContent anchor', () => {
  it('takes every anchor form Base UI takes', () => {
    expectTypeOf<ComponentProps<typeof PopoverContent>['anchor']>().toEqualTypeOf<
      PopoverPrimitive.Positioner.Props['anchor']
    >();
  });

  it('measures the anchor it is given, not the trigger', async () => {
    render(
      <Popover defaultOpen>
        <PopoverTrigger>Account</PopoverTrigger>
        <PopoverContent anchor={rowAnchor} aria-label="Account card">
          Card
        </PopoverContent>
      </Popover>,
    );
    const positioner = positionerOf(await screen.findByRole('dialog', { name: 'Account card' }));
    await waitFor(() => expect(positioner.style.getPropertyValue('--anchor-width')).toBe('248px'));
  });

  it('measures the trigger when no anchor is given', async () => {
    render(
      <Popover defaultOpen>
        <PopoverTrigger>Account</PopoverTrigger>
        <PopoverContent aria-label="Account card">Card</PopoverContent>
      </Popover>,
    );
    const positioner = positionerOf(await screen.findByRole('dialog', { name: 'Account card' }));
    await waitFor(() => expect(positioner.style.getPropertyValue('--anchor-width')).toBe('0px'));
  });
});
