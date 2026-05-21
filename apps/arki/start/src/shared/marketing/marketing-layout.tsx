import type { ReactNode } from 'react';

import { KineticBand } from './kinetic-band';
import { MarketingStatusBar } from './marketing-status-bar';

type Props = {
  children: ReactNode;
};

export function MarketingLayout({ children }: Readonly<Props>) {
  return (
    <div className="marketing">
      <main>{children}</main>
      <MarketingStatusBar />
      <KineticBand />
    </div>
  );
}
