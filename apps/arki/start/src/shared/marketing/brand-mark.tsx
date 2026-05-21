/* arki brand mark — L01 Monospace wordmark from the arki Design System.
   JetBrains Mono 500 · amber `.dev` accent · -0.02em tracking.
   Single source of truth for the wordmark across nav, footer, etc. */

type Props = {
  /** Visual size variant. `nav` ≈ 18px, `hero` ≈ clamp(56→128px). */
  size?: 'nav' | 'hero';
  /** Optional override for the anchor href. Defaults to `/`. */
  href?: string;
  className?: string;
};

export function BrandMark({ size = 'nav', href = '/', className }: Readonly<Props>) {
  return (
    <a href={href} className={'brand-mark brand-mark--' + size + (className ? ' ' + className : '')}>
      <span>arki</span>
      <span className="brand-mark-accent">.dev</span>
    </a>
  );
}
