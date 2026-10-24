import { z } from '@arki/contracts';

const MODE = (import.meta.env?.MODE ?? 'development') as 'development' | 'production' | 'test';

// Public Turnstile site key for the feedback forms; "" (an unset Coolify build arg) means unset.
const VITE_CLOUDFLARE_TURNSTILE_SITE_KEY = z
  .preprocess(v => (v === '' ? undefined : v), z.string().optional())
  .parse(import.meta.env?.VITE_CLOUDFLARE_TURNSTILE_SITE_KEY);

export const env = {
  MODE,
  NODE_ENV: MODE,
  VITE_URL: import.meta.env?.VITE_URL as string | undefined,
  VITE_CLOUDFLARE_TURNSTILE_SITE_KEY,
};
