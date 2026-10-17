/** `IconSVG`: the type of an icon component that renders an SVG. */
import type { ForwardRefExoticComponent, SVGProps } from 'react';

export type IconSVG = ForwardRefExoticComponent<SVGProps<SVGSVGElement>>;
