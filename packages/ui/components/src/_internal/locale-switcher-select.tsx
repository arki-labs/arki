'use client';

import type { ChangeEvent, ReactNode } from 'react';
import { useTransition } from 'react';

import { cn } from '@arki/base-ui/cn';

type Props = {
  children: ReactNode;
  defaultValue: string;
  label: string;
  onLocaleChange: (locale: string) => void;
};

export function LocaleSwitcherSelect({ children, defaultValue, label, onLocaleChange }: Props) {
  const [isPending, startTransition] = useTransition();

  function onSelectChange(event: ChangeEvent<HTMLSelectElement>) {
    const nextLocale = event.target.value;
    startTransition(() => {
      onLocaleChange(nextLocale);
    });
  }

  return (
    <label className={cn('relative text-gray-400', isPending && 'transition-opacity [&:disabled]:opacity-30')}>
      <p className="sr-only">{label}</p>
      <select
        className="inline-flex appearance-none bg-transparent py-3 pr-6 pl-2"
        defaultValue={defaultValue}
        disabled={isPending}
        onChange={onSelectChange}
      >
        {children}
      </select>
      <span className="pointer-events-none absolute top-[8px] right-2">⌄</span>
    </label>
  );
}
