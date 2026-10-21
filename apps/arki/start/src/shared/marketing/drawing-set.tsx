import type { ReactNode } from 'react';

import '~/styles/drawing-set.css';

import { GlossaryProvider } from './glossary-term';

/**
 * Homepage drawings (sheets, the journal chapter) inside a `.site` page. The stylesheet is imported here, not linked
 * from a route: a route file ships in the main bundle, and only the pages that draw these should load it.
 */
export function DrawingSet({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <GlossaryProvider>
      <div className="home home-inset">{children}</div>
    </GlossaryProvider>
  );
}
