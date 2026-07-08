import type { Plugin } from '@arki/dot/plugin';
import { plugin, service } from '@arki/dot/plugin';

import { initAuth } from './better-auth.config.js';

export type AuthPluginOptions = Parameters<typeof initAuth>[1];
export type AuthDb = Parameters<typeof initAuth>[0];
export type AuthService = ReturnType<typeof initAuth>;

export type AuthPluginServices = {
  readonly auth: AuthService;
};

export function auth(options: AuthPluginOptions): Plugin<{ readonly db: AuthDb }, AuthPluginServices> {
  return plugin({
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
