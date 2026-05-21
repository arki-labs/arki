const MODE = (import.meta.env?.MODE ?? 'development') as 'development' | 'production' | 'test';

export const env = {
  MODE,
  NODE_ENV: MODE,
  VITE_URL: import.meta.env?.VITE_URL as string | undefined,
};
