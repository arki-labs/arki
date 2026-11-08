/** Resizable: panels the user can drag to resize. */
'use client';

import type { PanelGroupStorage } from 'react-resizable-panels';
import * as React from 'react';
import * as ResizablePrimitive from 'react-resizable-panels';
import { z } from 'zod';

import { DotsSixVerticalIcon } from '@arki/icons/phosphor';
import { getLogger } from '@arki/log';
import { is } from '@arki/schema';

import { cn } from './cn.js';

/** Enable with `DEBUG=arki:ui:resizable`. */
const layoutLog = getLogger('arki:ui:resizable');

type PanelGroupProps = React.ComponentProps<typeof ResizablePrimitive.PanelGroup>;

/** What react-resizable-panels saves under `autoSaveId`: one entry per set of panels. */
const savedLayoutsSchema = z.record(
  z.string(),
  z.object({ expandToSizes: z.record(z.string(), z.number()), layout: z.array(z.number()) }),
);

/** localStorage, read only when the library asks: absent during SSR; a throw from blocked storage is caught by the library. */
const browserStorage: PanelGroupStorage = {
  getItem: name => (typeof localStorage === 'undefined' ? null : localStorage.getItem(name)),
  setItem: (name, value) => {
    if (typeof localStorage !== 'undefined') localStorage.setItem(name, value);
  },
};

function readJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/**
 * Storage that hands the library a saved layout only when it matches `savedLayoutsSchema`. The library
 * restores it without checking, and a wrong shape throws during commit, which unmounts the page. A
 * value that does not match reads as nothing saved, so the group starts from its default layout and
 * the next save replaces it. With `ignoreSaved` every read is empty.
 */
function checkedStorage(storage: PanelGroupStorage, ignoreSaved: boolean): PanelGroupStorage {
  return {
    getItem: name => {
      if (ignoreSaved) return null;
      const raw = storage.getItem(name);
      if (raw === null || is(readJson(raw), savedLayoutsSchema)) return raw;
      layoutLog.debug('Ignoring the saved layout {name}: it does not match the expected shape', { name });
      return null;
    },
    setItem: (name, value) => storage.setItem(name, value),
  };
}

type SavedLayoutBoundaryState = { caught: { error: unknown } | null; ignoreSaved: boolean };

/**
 * Catches the one failure the schema cannot see: a saved layout with a different number of panels
 * than the page has, which the library rejects with "Invalid N panel layout". The group mounts again
 * without the saved layout. A failure after that is not about the saved layout, so it propagates.
 */
class SavedLayoutBoundary extends React.Component<
  { children: (ignoreSaved: boolean) => React.ReactNode },
  SavedLayoutBoundaryState
> {
  override state: SavedLayoutBoundaryState = { caught: null, ignoreSaved: false };

  static getDerivedStateFromError(error: unknown): Partial<SavedLayoutBoundaryState> {
    return { caught: { error } };
  }

  override componentDidUpdate() {
    if (this.state.caught && !this.state.ignoreSaved) {
      layoutLog.debug('The saved layout does not fit the panels; mounting with the default layout');
      this.setState({ caught: null, ignoreSaved: true });
    }
  }

  override render() {
    const { caught, ignoreSaved } = this.state;
    if (caught) {
      if (ignoreSaved) throw caught.error;
      return null;
    }
    return this.props.children(ignoreSaved);
  }
}

function SavedLayoutPanelGroup({
  storage,
  ignoreSaved,
  ...props
}: PanelGroupProps & { ignoreSaved: boolean }) {
  const checked = React.useMemo(() => checkedStorage(storage ?? browserStorage, ignoreSaved), [storage, ignoreSaved]);
  return <ResizablePrimitive.PanelGroup storage={checked} {...props} />;
}

/**
 * A panel group. With `autoSaveId`, the layout is saved to `storage` (default localStorage) and
 * restored on mount; a saved layout that does not fit (wrong shape, or a different panel count) is
 * ignored and the default layout is used.
 */
function ResizablePanelGroup({ className, ...props }: PanelGroupProps) {
  const groupProps = {
    'data-slot': 'resizable-panel-group',
    className: cn('flex h-full w-full data-[panel-group-direction=vertical]:flex-col', className),
    ...props,
  };
  if (props.autoSaveId == null) return <ResizablePrimitive.PanelGroup {...groupProps} />;
  return (
    <SavedLayoutBoundary>
      {ignoreSaved => <SavedLayoutPanelGroup ignoreSaved={ignoreSaved} {...groupProps} />}
    </SavedLayoutBoundary>
  );
}

function ResizablePanel({ ...props }: React.ComponentProps<typeof ResizablePrimitive.Panel>) {
  return <ResizablePrimitive.Panel data-slot="resizable-panel" {...props} />;
}

function ResizableHandle({
  withHandle,
  className,
  ...props
}: React.ComponentProps<typeof ResizablePrimitive.PanelResizeHandle> & {
  withHandle?: boolean;
}) {
  return (
    <ResizablePrimitive.PanelResizeHandle
      data-slot="resizable-handle"
      className={cn(
        'bg-border focus-visible:ring-ring relative flex w-px items-center justify-center after:absolute after:inset-y-0 after:left-1/2 after:w-1 after:-translate-x-1/2 focus-visible:ring-1 focus-visible:ring-offset-1 focus-visible:outline-hidden data-[panel-group-direction=vertical]:h-px data-[panel-group-direction=vertical]:w-full data-[panel-group-direction=vertical]:after:left-0 data-[panel-group-direction=vertical]:after:h-1 data-[panel-group-direction=vertical]:after:w-full data-[panel-group-direction=vertical]:after:-translate-y-1/2 data-[panel-group-direction=vertical]:after:translate-x-0 [&[data-panel-group-direction=vertical]>div]:rotate-90',
        className,
      )}
      {...props}
    >
      {withHandle && (
        <div className="bg-border z-10 flex h-4 w-3 items-center justify-center rounded-xs border">
          <DotsSixVerticalIcon className="size-2.5" weight="regular" />
        </div>
      )}
    </ResizablePrimitive.PanelResizeHandle>
  );
}

export { ResizableHandle, ResizablePanel, ResizablePanelGroup };
