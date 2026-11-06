/** Aspect ratio: a box that keeps a fixed width-to-height ratio. */
import * as React from 'react';

type AspectRatioProps = {
  ratio?: number;
} & React.ComponentProps<'div'>;

function AspectRatio({ ratio = 1, style, ...props }: AspectRatioProps) {
  return (
    <div
      data-slot="aspect-ratio"
      style={{ position: 'relative', width: '100%', paddingBottom: `${(1 / ratio) * 100}%`, ...style }}
    >
      <div style={{ position: 'absolute', inset: 0 }} {...props} />
    </div>
  );
}

export { AspectRatio };
