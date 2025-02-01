export const dictionaries = {
  en: () => import('./dictionaries/en').then(mod => mod.default),
  de: () => import('./dictionaries/de').then(mod => mod.default),
} as const;
