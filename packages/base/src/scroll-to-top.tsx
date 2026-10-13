'use client';

import { ArrowCircleUp } from '@arki/icons/phosphor';

export const ScrollToTop = () => {
  const scrollToTop = () => window.scroll({ top: 0, behavior: 'smooth' });
  return (
    <button className="w-6 shrink-0 text-center" title="Scroll back to the top" onClick={scrollToTop}>
      <ArrowCircleUp className="hover:stroke-[3]" weight="regular" />
    </button>
  );
};
