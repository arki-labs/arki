'use client';

import type { ImperativePanelGroupHandle, ImperativePanelHandle } from 'react-resizable-panels';
import * as React from 'react';
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';

import { DotsSixVertical, CornersOut, CornersIn } from '@arki/icons/phosphor';
import { cn } from './cn';

// ─── Context ──────────────────────────────────────────────────────────────────

type ToolPanelGroupCtx = {
  maximizedPanelId: string | null;
  maximize: (id: string) => void;
  restore: () => void;
  registerPanel: (id: string, ref: React.RefObject<ImperativePanelHandle | null>) => void;
  unregisterPanel: (id: string) => void;
};

const ToolPanelGroupContext = createContext<ToolPanelGroupCtx>({
  maximizedPanelId: null,
  maximize: () => {},
  restore: () => {},
  registerPanel: () => {},
  unregisterPanel: () => {},
});

function useToolPanelGroup() {
  return useContext(ToolPanelGroupContext);
}

// ─── ToolPanelGroup ───────────────────────────────────────────────────────────

/**
 * A context-providing wrapper around `react-resizable-panels` `PanelGroup`.
 *
 * Adds maximize/restore semantics so any panel within the group can be
 * expanded to fill 100% while the rest collapse, then restored to the
 * previously saved layout.  Layout is auto-persisted to localStorage using
 * `"${storagePrefix}-${id}"` as the key.
 */
function ToolPanelGroup({
  id,
  direction,
  className,
  children,
  storagePrefix = 'arki',
}: {
  id: string;
  direction: 'horizontal' | 'vertical';
  className?: string;
  children: React.ReactNode;
  /** Prefix for the localStorage persistence key. Pass the app name to avoid collisions. */
  storagePrefix?: string;
}) {
  const [maximizedPanelId, setMaximizedPanelId] = useState<string | null>(null);
  const groupRef = useRef<ImperativePanelGroupHandle>(null);
  const savedLayout = useRef<number[] | null>(null);
  const panelRefs = useRef(new Map<string, React.RefObject<ImperativePanelHandle | null>>());

  const registerPanel = useCallback((panelId: string, ref: React.RefObject<ImperativePanelHandle | null>) => {
    panelRefs.current.set(panelId, ref);
  }, []);

  const unregisterPanel = useCallback((panelId: string) => {
    panelRefs.current.delete(panelId);
  }, []);

  const maximize = useCallback((panelId: string) => {
    savedLayout.current = groupRef.current?.getLayout() ?? null;
    setMaximizedPanelId(panelId);
    for (const [regId, ref] of panelRefs.current) {
      if (regId === panelId) {
        ref.current?.resize(100);
      } else {
        ref.current?.collapse();
      }
    }
  }, []);

  const restore = useCallback(() => {
    setMaximizedPanelId(null);
    if (savedLayout.current) {
      groupRef.current?.setLayout(savedLayout.current);
      savedLayout.current = null;
    }
  }, []);

  return (
    <ToolPanelGroupContext.Provider value={{ maximizedPanelId, maximize, restore, registerPanel, unregisterPanel }}>
      <PanelGroup
        ref={groupRef}
        direction={direction}
        autoSaveId={`${storagePrefix}-${id}`}
        className={cn('flex h-full w-full', direction === 'vertical' && 'flex-col', className)}
      >
        {children}
      </PanelGroup>
    </ToolPanelGroupContext.Provider>
  );
}

// ─── ToolPanel ────────────────────────────────────────────────────────────────

/**
 * A resizable panel that auto-registers itself with the parent `ToolPanelGroup`
 * context to enable maximize/restore behaviour.
 */
function ToolPanel({
  id,
  defaultSize,
  minSize = 10,
  className,
  children,
}: {
  id: string;
  defaultSize: number;
  minSize?: number;
  className?: string;
  children: React.ReactNode;
}) {
  const { registerPanel, unregisterPanel } = useToolPanelGroup();
  const panelRef = useRef<ImperativePanelHandle>(null);

  useEffect(() => {
    registerPanel(id, panelRef);
    return () => unregisterPanel(id);
  }, [id, registerPanel, unregisterPanel]);

  return (
    <Panel
      ref={panelRef}
      defaultSize={defaultSize}
      minSize={minSize}
      collapsible
      collapsedSize={0}
      className={cn('flex flex-col overflow-hidden', className)}
    >
      {children}
    </Panel>
  );
}

// ─── ToolPanelHandle ──────────────────────────────────────────────────────────

/**
 * A styled resize handle with a grip icon, placed between two `ToolPanel`
 * instances inside a `ToolPanelGroup`.
 */
function ToolPanelHandle({ className }: { className?: string }) {
  return (
    <PanelResizeHandle
      className={cn(
        'group relative flex items-center justify-center',
        'bg-border data-[panel-group-direction=vertical]:h-px data-[panel-group-direction=horizontal]:w-px',
        'data-[panel-group-direction=horizontal]:after:absolute data-[panel-group-direction=horizontal]:after:inset-y-0 data-[panel-group-direction=horizontal]:after:left-1/2 data-[panel-group-direction=horizontal]:after:w-2 data-[panel-group-direction=horizontal]:after:-translate-x-1/2',
        'data-[panel-group-direction=vertical]:after:absolute data-[panel-group-direction=vertical]:after:inset-x-0 data-[panel-group-direction=vertical]:after:top-1/2 data-[panel-group-direction=vertical]:after:h-2 data-[panel-group-direction=vertical]:after:-translate-y-1/2',
        'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
        className,
      )}
    >
      <div
        className={cn(
          'z-10 flex items-center justify-center rounded border border-border bg-background shadow-sm transition-colors',
          'h-5 w-3.5',
          'data-[panel-group-direction=vertical]:rotate-90',
          'group-hover:border-primary/40 group-hover:bg-muted',
          'group-data-[resize-handle-state=drag]:border-primary/60 group-data-[resize-handle-state=drag]:bg-primary/5',
        )}
      >
        <DotsSixVertical className="h-3 w-3 text-muted-foreground group-hover:text-foreground" weight="regular" />
      </div>
    </PanelResizeHandle>
  );
}

// ─── PanelExpandButton ────────────────────────────────────────────────────────

/**
 * Small maximize/restore button for panel headers.
 * Renders nothing when another panel in the group is already maximized.
 */
function PanelExpandButton({ panelId }: { panelId: string }) {
  const { maximizedPanelId, maximize, restore } = useToolPanelGroup();
  const isMaximized = maximizedPanelId === panelId;
  const isOtherMaximized = maximizedPanelId !== null && maximizedPanelId !== panelId;

  if (isOtherMaximized) return null;

  return (
    <button
      type="button"
      onClick={() => (isMaximized ? restore() : maximize(panelId))}
      className="flex h-5 w-5 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      title={isMaximized ? 'Restore panel' : 'Expand panel'}
    >
      {isMaximized ? <CornersIn className="h-3 w-3" weight="regular" /> : <CornersOut className="h-3 w-3" weight="regular" />}
    </button>
  );
}

// ─── PanelSkeleton ────────────────────────────────────────────────────────────

/**
 * Animated placeholder rendered inside panels while the workbench is
 * restoring persisted state on mount, to avoid a layout flash.
 */
function PanelSkeleton() {
  return (
    <div className="flex flex-1 animate-pulse flex-col gap-2 p-4">
      <div className="h-3 w-4/5 rounded bg-muted" />
      <div className="h-3 w-3/5 rounded bg-muted" />
      <div className="h-3 w-full rounded bg-muted" />
      <div className="ml-4 h-3 w-3/4 rounded bg-muted" />
      <div className="ml-4 h-3 w-1/2 rounded bg-muted" />
      <div className="ml-4 h-3 w-2/3 rounded bg-muted" />
      <div className="h-3 w-5/6 rounded bg-muted" />
      <div className="h-3 w-4/5 rounded bg-muted" />
      <div className="ml-4 h-3 w-3/5 rounded bg-muted" />
      <div className="ml-8 h-3 w-1/3 rounded bg-muted" />
      <div className="ml-8 h-3 w-2/5 rounded bg-muted" />
      <div className="ml-4 h-3 w-2/3 rounded bg-muted" />
      <div className="h-3 w-full rounded bg-muted" />
      <div className="h-3 w-3/4 rounded bg-muted" />
    </div>
  );
}

export {
  PanelExpandButton,
  PanelSkeleton,
  ToolPanel,
  ToolPanelGroup,
  ToolPanelHandle,
  useToolPanelGroup,
};
