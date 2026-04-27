import type { VariantProps } from 'class-variance-authority';
import * as React from 'react';
import { cva } from 'class-variance-authority';

import { cn } from './cn';
import { Slot } from './slot';

export const glassTones = [
  'default',
  'slate',
  'gray',
  'zinc',
  'stone',
  'red',
  'orange',
  'amber',
  'yellow',
  'lime',
  'green',
  'emerald',
  'teal',
  'cyan',
  'sky',
  'blue',
  'indigo',
  'violet',
  'purple',
  'fuchsia',
  'pink',
  'rose',
] as const;

export type GlassTone = (typeof glassTones)[number];

const glassCardVariants = cva(
  cn(
    'group group/glass relative isolate flex overflow-hidden rounded-2xl border backdrop-blur-xl',
    'shadow-[0_1px_2px_rgba(15,23,42,0.04),inset_0_1px_0_0_rgba(255,255,255,0.5)]',
    'transition-all duration-300 ease-out',
    'before:pointer-events-none before:absolute before:inset-x-4 before:top-px before:h-px',
    'before:bg-gradient-to-r before:from-transparent before:via-white/50 before:to-transparent',
    'before:content-[""]',
    'dark:shadow-[0_1px_2px_rgba(0,0,0,0.3),inset_0_1px_0_0_rgba(255,255,255,0.06)]',
    'dark:before:via-white/10',
  ),
  {
    variants: {
      tone: {
        default: 'bg-card border-border',
        slate:
          'bg-card bg-gradient-to-b from-slate-50/50 to-slate-50/10 border-slate-200/70 dark:from-slate-950/30 dark:to-slate-950/10 dark:border-slate-800/40',
        gray: 'bg-card bg-gradient-to-b from-gray-50/50 to-gray-50/10 border-gray-200/70 dark:from-gray-950/30 dark:to-gray-950/10 dark:border-gray-800/40',
        zinc: 'bg-card bg-gradient-to-b from-zinc-50/50 to-zinc-50/10 border-zinc-200/70 dark:from-zinc-950/30 dark:to-zinc-950/10 dark:border-zinc-800/40',
        stone:
          'bg-card bg-gradient-to-b from-stone-50/50 to-stone-50/10 border-stone-200/70 dark:from-stone-950/30 dark:to-stone-950/10 dark:border-stone-800/40',
        red: 'bg-card bg-gradient-to-b from-red-50/50 to-red-50/10 border-red-200/70 dark:from-red-950/30 dark:to-red-950/10 dark:border-red-800/40',
        orange:
          'bg-card bg-gradient-to-b from-orange-50/50 to-orange-50/10 border-orange-200/70 dark:from-orange-950/30 dark:to-orange-950/10 dark:border-orange-800/40',
        amber:
          'bg-card bg-gradient-to-b from-amber-50/50 to-amber-50/10 border-amber-200/70 dark:from-amber-950/30 dark:to-amber-950/10 dark:border-amber-800/40',
        yellow:
          'bg-card bg-gradient-to-b from-yellow-50/50 to-yellow-50/10 border-yellow-200/70 dark:from-yellow-950/30 dark:to-yellow-950/10 dark:border-yellow-800/40',
        lime: 'bg-card bg-gradient-to-b from-lime-50/50 to-lime-50/10 border-lime-200/70 dark:from-lime-950/30 dark:to-lime-950/10 dark:border-lime-800/40',
        green:
          'bg-card bg-gradient-to-b from-green-50/50 to-green-50/10 border-green-200/70 dark:from-green-950/30 dark:to-green-950/10 dark:border-green-800/40',
        emerald:
          'bg-card bg-gradient-to-b from-emerald-50/50 to-emerald-50/10 border-emerald-200/70 dark:from-emerald-950/30 dark:to-emerald-950/10 dark:border-emerald-800/40',
        teal: 'bg-card bg-gradient-to-b from-teal-50/50 to-teal-50/10 border-teal-200/70 dark:from-teal-950/30 dark:to-teal-950/10 dark:border-teal-800/40',
        cyan: 'bg-card bg-gradient-to-b from-cyan-50/50 to-cyan-50/10 border-cyan-200/70 dark:from-cyan-950/30 dark:to-cyan-950/10 dark:border-cyan-800/40',
        sky: 'bg-card bg-gradient-to-b from-sky-50/50 to-sky-50/10 border-sky-200/70 dark:from-sky-950/30 dark:to-sky-950/10 dark:border-sky-800/40',
        blue: 'bg-card bg-gradient-to-b from-blue-50/50 to-blue-50/10 border-blue-200/70 dark:from-blue-950/30 dark:to-blue-950/10 dark:border-blue-800/40',
        indigo:
          'bg-card bg-gradient-to-b from-indigo-50/50 to-indigo-50/10 border-indigo-200/70 dark:from-indigo-950/30 dark:to-indigo-950/10 dark:border-indigo-800/40',
        violet:
          'bg-card bg-gradient-to-b from-violet-50/50 to-violet-50/10 border-violet-200/70 dark:from-violet-950/30 dark:to-violet-950/10 dark:border-violet-800/40',
        purple:
          'bg-card bg-gradient-to-b from-purple-50/50 to-purple-50/10 border-purple-200/70 dark:from-purple-950/30 dark:to-purple-950/10 dark:border-purple-800/40',
        fuchsia:
          'bg-card bg-gradient-to-b from-fuchsia-50/50 to-fuchsia-50/10 border-fuchsia-200/70 dark:from-fuchsia-950/30 dark:to-fuchsia-950/10 dark:border-fuchsia-800/40',
        pink: 'bg-card bg-gradient-to-b from-pink-50/50 to-pink-50/10 border-pink-200/70 dark:from-pink-950/30 dark:to-pink-950/10 dark:border-pink-800/40',
        rose: 'bg-card bg-gradient-to-b from-rose-50/50 to-rose-50/10 border-rose-200/70 dark:from-rose-950/30 dark:to-rose-950/10 dark:border-rose-800/40',
      },
    },
    defaultVariants: {
      tone: 'default',
    },
  },
);

const interactiveBaseClasses = 'cursor-pointer hover:-translate-y-0.5 hover:shadow-lg';

const interactiveToneClasses: Record<GlassTone, string> = {
  default: 'hover:border-foreground/20',
  slate: 'hover:shadow-slate-200/50 hover:border-slate-300 dark:hover:shadow-slate-900/40 dark:hover:border-slate-700',
  gray: 'hover:shadow-gray-200/50 hover:border-gray-300 dark:hover:shadow-gray-900/40 dark:hover:border-gray-700',
  zinc: 'hover:shadow-zinc-200/50 hover:border-zinc-300 dark:hover:shadow-zinc-900/40 dark:hover:border-zinc-700',
  stone: 'hover:shadow-stone-200/50 hover:border-stone-300 dark:hover:shadow-stone-900/40 dark:hover:border-stone-700',
  red: 'hover:shadow-red-200/50 hover:border-red-300 dark:hover:shadow-red-900/40 dark:hover:border-red-700',
  orange:
    'hover:shadow-orange-200/50 hover:border-orange-300 dark:hover:shadow-orange-900/40 dark:hover:border-orange-700',
  amber: 'hover:shadow-amber-200/50 hover:border-amber-300 dark:hover:shadow-amber-900/40 dark:hover:border-amber-700',
  yellow:
    'hover:shadow-yellow-200/50 hover:border-yellow-300 dark:hover:shadow-yellow-900/40 dark:hover:border-yellow-700',
  lime: 'hover:shadow-lime-200/50 hover:border-lime-300 dark:hover:shadow-lime-900/40 dark:hover:border-lime-700',
  green: 'hover:shadow-green-200/50 hover:border-green-300 dark:hover:shadow-green-900/40 dark:hover:border-green-700',
  emerald:
    'hover:shadow-emerald-200/50 hover:border-emerald-300 dark:hover:shadow-emerald-900/40 dark:hover:border-emerald-700',
  teal: 'hover:shadow-teal-200/50 hover:border-teal-300 dark:hover:shadow-teal-900/40 dark:hover:border-teal-700',
  cyan: 'hover:shadow-cyan-200/50 hover:border-cyan-300 dark:hover:shadow-cyan-900/40 dark:hover:border-cyan-700',
  sky: 'hover:shadow-sky-200/50 hover:border-sky-300 dark:hover:shadow-sky-900/40 dark:hover:border-sky-700',
  blue: 'hover:shadow-blue-200/50 hover:border-blue-300 dark:hover:shadow-blue-900/40 dark:hover:border-blue-700',
  indigo:
    'hover:shadow-indigo-200/50 hover:border-indigo-300 dark:hover:shadow-indigo-900/40 dark:hover:border-indigo-700',
  violet:
    'hover:shadow-violet-200/50 hover:border-violet-300 dark:hover:shadow-violet-900/40 dark:hover:border-violet-700',
  purple:
    'hover:shadow-purple-200/50 hover:border-purple-300 dark:hover:shadow-purple-900/40 dark:hover:border-purple-700',
  fuchsia:
    'hover:shadow-fuchsia-200/50 hover:border-fuchsia-300 dark:hover:shadow-fuchsia-900/40 dark:hover:border-fuchsia-700',
  pink: 'hover:shadow-pink-200/50 hover:border-pink-300 dark:hover:shadow-pink-900/40 dark:hover:border-pink-700',
  rose: 'hover:shadow-rose-200/50 hover:border-rose-300 dark:hover:shadow-rose-900/40 dark:hover:border-rose-700',
};

type GlassCardProps = React.ComponentProps<'div'> &
  VariantProps<typeof glassCardVariants> & {
    asChild?: boolean;
    interactive?: boolean;
  };

function GlassCard({ className, tone, interactive, asChild = false, ...props }: GlassCardProps) {
  const Comp = asChild ? Slot : 'div';
  return (
    <Comp
      data-slot="glass-card"
      className={cn(
        glassCardVariants({ tone }),
        interactive && interactiveBaseClasses,
        interactive && interactiveToneClasses[tone ?? 'default'],
        className,
      )}
      {...props}
    />
  );
}

const glassCardIconVariants = cva(
  'relative flex shrink-0 items-center justify-center transition-transform duration-300 ease-out group-hover/glass:scale-105',
  {
    variants: {
      tone: {
        default: 'bg-muted text-foreground',
        slate: 'bg-slate-100 text-slate-600 dark:bg-slate-900/30 dark:text-slate-400',
        gray: 'bg-gray-100 text-gray-600 dark:bg-gray-900/30 dark:text-gray-400',
        zinc: 'bg-zinc-100 text-zinc-600 dark:bg-zinc-900/30 dark:text-zinc-400',
        stone: 'bg-stone-100 text-stone-600 dark:bg-stone-900/30 dark:text-stone-400',
        red: 'bg-red-100 text-red-600 dark:bg-red-900/30 dark:text-red-400',
        orange: 'bg-orange-100 text-orange-600 dark:bg-orange-900/30 dark:text-orange-400',
        amber: 'bg-amber-100 text-amber-600 dark:bg-amber-900/30 dark:text-amber-400',
        yellow: 'bg-yellow-100 text-yellow-600 dark:bg-yellow-900/30 dark:text-yellow-400',
        lime: 'bg-lime-100 text-lime-600 dark:bg-lime-900/30 dark:text-lime-400',
        green: 'bg-green-100 text-green-600 dark:bg-green-900/30 dark:text-green-400',
        emerald: 'bg-emerald-100 text-emerald-600 dark:bg-emerald-900/30 dark:text-emerald-400',
        teal: 'bg-teal-100 text-teal-600 dark:bg-teal-900/30 dark:text-teal-400',
        cyan: 'bg-cyan-100 text-cyan-600 dark:bg-cyan-900/30 dark:text-cyan-400',
        sky: 'bg-sky-100 text-sky-600 dark:bg-sky-900/30 dark:text-sky-400',
        blue: 'bg-blue-100 text-blue-600 dark:bg-blue-900/30 dark:text-blue-400',
        indigo: 'bg-indigo-100 text-indigo-600 dark:bg-indigo-900/30 dark:text-indigo-400',
        violet: 'bg-violet-100 text-violet-600 dark:bg-violet-900/30 dark:text-violet-400',
        purple: 'bg-purple-100 text-purple-600 dark:bg-purple-900/30 dark:text-purple-400',
        fuchsia: 'bg-fuchsia-100 text-fuchsia-600 dark:bg-fuchsia-900/30 dark:text-fuchsia-400',
        pink: 'bg-pink-100 text-pink-600 dark:bg-pink-900/30 dark:text-pink-400',
        rose: 'bg-rose-100 text-rose-600 dark:bg-rose-900/30 dark:text-rose-400',
      },
      surface: {
        tile: 'rounded-xl shadow-sm ring-1 ring-inset ring-white/60 dark:ring-white/10',
        plain: 'bg-transparent! shadow-none! ring-0! dark:bg-transparent!',
      },
      size: {
        sm: 'h-9 w-9 [&>svg]:size-4',
        md: 'h-11 w-11 [&>svg]:size-5',
        lg: 'h-12 w-12 [&>svg]:size-6',
      },
    },
    compoundVariants: [
      { surface: 'plain', size: 'sm', class: 'h-auto w-auto [&>svg]:size-6' },
      { surface: 'plain', size: 'md', class: 'h-auto w-auto [&>svg]:size-7' },
      { surface: 'plain', size: 'lg', class: 'h-auto w-auto [&>svg]:size-9' },
    ],
    defaultVariants: {
      tone: 'default',
      surface: 'tile',
      size: 'md',
    },
  },
);

type GlassCardIconProps = React.ComponentProps<'div'> &
  VariantProps<typeof glassCardIconVariants> & {
    asChild?: boolean;
  };

function GlassCardIcon({
  className,
  tone,
  size,
  surface,
  asChild = false,
  ...props
}: GlassCardIconProps) {
  const Comp = asChild ? Slot : 'div';
  return (
    <Comp
      data-slot="glass-card-icon"
      className={cn(glassCardIconVariants({ tone, size, surface }), className)}
      {...props}
    />
  );
}

export { GlassCard, GlassCardIcon, glassCardVariants, glassCardIconVariants };
