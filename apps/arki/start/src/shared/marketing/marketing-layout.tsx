import type { ReactNode } from 'react';

import { MarketingNav } from './marketing-nav';
import { MarketingStatusBar } from './marketing-status-bar';

type Props = {
  children: ReactNode;
  activeHref?: string;
};

export function MarketingLayout({ children, activeHref }: Readonly<Props>) {
  return (
    <div className="marketing">
      <MarketingNav activeHref={activeHref} />
      <main>{children}</main>
      <MarketingStatusBar />
    </div>
  );
}
