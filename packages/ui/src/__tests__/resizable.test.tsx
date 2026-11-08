import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '../resizable';
import { PanelExpandButton, ToolPanel, ToolPanelGroup, ToolPanelHandle } from '../tool-panels';

const storageKey = 'react-resizable-panels:test-layout';

function TwoPanels() {
  return (
    <ResizablePanelGroup direction="horizontal" autoSaveId="test-layout">
      <ResizablePanel id="a" order={1} defaultSize={50} minSize={10}>
        A
      </ResizablePanel>
      <ResizableHandle />
      <ResizablePanel id="b" order={2} defaultSize={50} minSize={10}>
        B
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}

function panelSizes() {
  return [...document.querySelectorAll<HTMLElement>('[data-panel-size]')].map(panel => panel.dataset.panelSize);
}

afterEach(() => localStorage.clear());

// The saved layout is outside data: an older version, a hand edit or another app can leave anything under the key.
describe('ResizablePanelGroup with autoSaveId', () => {
  it('restores a saved layout that fits', () => {
    localStorage.setItem(storageKey, JSON.stringify({ 'a,b': { expandToSizes: {}, layout: [30, 70] } }));
    render(<TwoPanels />);
    expect(panelSizes()).toEqual(['30.0', '70.0']);
  });

  it.each([
    ['an empty entry', {}],
    ['an entry in the older array format', [30, 70]],
    ['a layout for a different number of panels', { expandToSizes: {}, layout: [100] }],
  ])('uses the default layout when the saved entry is %s', (_name, entry) => {
    localStorage.setItem(storageKey, JSON.stringify({ 'a,b': entry }));
    render(<TwoPanels />);
    expect(screen.getByText('A')).toBeTruthy();
    expect(panelSizes()).toEqual(['50.0', '50.0']);
  });
});

function Workbench({ withThird }: { withThird: boolean }) {
  return (
    <ToolPanelGroup id="bench" direction="horizontal">
      <ToolPanel id="left" defaultSize={50}>
        <PanelExpandButton panelId="left" />
        Left
      </ToolPanel>
      <ToolPanelHandle />
      <ToolPanel id="right" defaultSize={50}>
        Right
      </ToolPanel>
      {withThird && <ToolPanelHandle />}
      {withThird && (
        <ToolPanel id="third" defaultSize={20}>
          Third
        </ToolPanel>
      )}
    </ToolPanelGroup>
  );
}

describe('ToolPanelGroup', () => {
  it('uses the default layout when the layout it saved earlier was corrupted', async () => {
    const first = render(<Workbench withThird={false} />);
    await waitFor(() => expect(localStorage.getItem('react-resizable-panels:arki-bench')).not.toBeNull());
    first.unmount();
    const saved = localStorage.getItem('react-resizable-panels:arki-bench') ?? '{}';
    const corrupted = Object.fromEntries(Object.keys(JSON.parse(saved) as object).map(key => [key, {}]));
    localStorage.setItem('react-resizable-panels:arki-bench', JSON.stringify(corrupted));

    render(<Workbench withThird={false} />);
    expect(screen.getByText('Left')).toBeTruthy();
    expect(panelSizes()).toEqual(['50.0', '50.0']);
  });

  it('restores without throwing after a panel mounted while another was maximized', () => {
    const view = render(<Workbench withThird={false} />);
    fireEvent.click(screen.getByTitle('Expand panel'));
    view.rerender(<Workbench withThird />);
    // React reports a click handler's throw to window "error", not to the caller of fireEvent.
    const thrown: unknown[] = [];
    const onError = (event: ErrorEvent) => {
      thrown.push(event.error);
      event.preventDefault();
    };
    window.addEventListener('error', onError);
    fireEvent.click(screen.getByTitle('Restore panel'));
    window.removeEventListener('error', onError);
    expect(thrown).toEqual([]);
    expect(screen.getByTitle('Expand panel')).toBeTruthy();
    expect(panelSizes().every(size => Number(size) > 0)).toBe(true);
  });
});
