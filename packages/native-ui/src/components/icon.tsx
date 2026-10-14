import { cn } from '../lib/cn';
import type { Icon as PhosphorIcon, IconProps as PhosphorIconProps } from 'phosphor-react-native';
import { styled } from 'nativewind';

type IconProps = PhosphorIconProps & {
  as: PhosphorIcon;
  /**
   * Nativewind className. Phosphor RN's `IconProps` doesn't declare it because the
   * upstream package is unaware of Nativewind, but `styled()` rewrites it to `style`
   * at runtime, so the Icon wrapper must surface it on the public API.
   */
  className?: string;
};

function IconImpl({ as: IconComponent, ...props }: IconProps) {
  return <IconComponent {...props} />;
}

const StyledIconImpl = styled(IconImpl, {
  className: {
    target: 'style',
    nativeStyleMapping: {
      height: 'size',
      width: 'size',
    },
  },
});

/**
 * A wrapper component for Phosphor React Native icons with Nativewind `className` support
 * via `styled`.
 *
 * This component allows you to render any Phosphor icon while applying utility classes
 * using `nativewind`. It avoids the need to wrap or configure each icon individually.
 *
 * @component
 * @example
 * ```tsx
 * import { ArrowRight } from 'phosphor-react-native';
 * import { Icon } from '@/registry/components/ui/icon';
 *
 * <Icon as={ArrowRight} className="text-red-500" size={16} />
 * ```
 *
 * @param as - The Phosphor icon component to render.
 * @param className - Utility classes to style the icon via Nativewind.
 * @param size - Icon size (defaults to 14).
 * @param props - Additional Phosphor icon props (`weight`, `color`, `mirrored`, …) passed to the `as` icon.
 */
function Icon({ as: IconComponent, className, size = 14, ...props }: IconProps) {
  return (
    <StyledIconImpl
      as={IconComponent}
      className={cn('text-foreground', className)}
      size={size}
      {...props}
    />
  );
}

export { Icon };
