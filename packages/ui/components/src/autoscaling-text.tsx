'use client';

import { useLayoutEffect, useRef, useState } from 'react';

export const AutoScalingText = ({ children }: { children: React.ReactNode }) => {
  const nodeRef = useRef<HTMLDivElement>(null);

  const [scale, setScale] = useState(1);
  useLayoutEffect(() => {
    const node = nodeRef.current;
    const parentNode = node?.parentNode;

    if (!parentNode) return;

    const availableWidth = (parentNode as HTMLDivElement).offsetWidth;
    const actualWidth = node.offsetWidth;
    const actualScale = availableWidth / actualWidth;

    if (scale !== actualScale) {
      if (actualScale < 1) {
        setScale(actualScale);
      } else if (scale < 1) {
        setScale(1);
      }
    }
  });

  return (
    <div
      className="absolute right-0 px-6"
      style={{ transform: `scale(${scale},${scale})`, transformOrigin: 'right' }}
      ref={nodeRef}
    >
      {children}
    </div>
  );
};
