import type { Pip } from '@arki/dot/pip';
import { pip, service } from '@arki/dot/pip';

import { initAuth } from './better-auth.config.js';

export type AuthPipOptions = Parameters<typeof initAuth>[1];
export type AuthDb = Parameters<typeof initAuth>[0];
export type AuthService = ReturnType<typeof initAuth>;

export type AuthPipServices = {
  readonly auth: AuthService;
};

export function auth(options: AuthPipOptions): Pip<{ readonly db: AuthDb }, AuthPipServices> {
  return pip({
    name: 'auth',
    version: '0.1.4',
    needs: { db: service<AuthDb>() },
    configure(ctx) {
      ctx.registerService('auth', 'auth');
      ctx.declareProvides('auth');
    },
    boot({ db }) {
      return { auth: initAuth(db, options) };
    },
  });
}
