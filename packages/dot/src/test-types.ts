/**
 * Type inference test for plugin router names
 * This file is for testing only and should not be committed
 */

import type { AnyRouter } from '@trpc/server/unstable-core-do-not-import';

import { createDot, definePlugin } from './index';

// Mock schema and env
const mockSchema = {} as any;
const mockEnv = {} as any;

// Define test plugins with different router names
const authPlugin = definePlugin('auth').router({} as AnyRouter);

const contentPlugin = definePlugin('content').router({} as AnyRouter);

const trackingPlugin = definePlugin('tracking').router({} as AnyRouter);

// Create app with plugins
async function testTypeInference() {
  const app = await createDot('test-app')
    .withEnv(mockEnv)
    .registerPlugins([authPlugin, contentPlugin, trackingPlugin])
    .bootstrap();

  // Type test: These should have autocomplete and type checking
  if (app.router) {
    const authRouter = app.router.auth;
    const contentRouter = app.router.content;
    const trackingRouter = app.router.tracking;

    // This should error - nonexistent router
    // @ts-expect-error - Should error for non-existent router
    const fakeRouter = app.router.fake;
  }
}

// Type-level test to verify ExtractAllRouterNames works
import type { ExtractAllRouterNames, PluginConfig, PluginRouterRecord } from './plugin';

type TestPlugins = readonly [
  PluginConfig<any, 'auth', 'auth'>,
  PluginConfig<any, 'content', 'content'>,
  PluginConfig<any, 'tracking', 'tracking'>,
];

// Should extract 'auth' | 'content' | 'tracking'
type ExtractedNames = ExtractAllRouterNames<TestPlugins>;

// Should create Record<'auth' | 'content' | 'tracking', AnyRouter>
type RouterRecord = PluginRouterRecord<ExtractedNames>;

// Verify the extracted type is correct
const _typeTest: ExtractedNames = 'auth'; // Should not error
const _typeTest2: ExtractedNames = 'content'; // Should not error
const _typeTest3: ExtractedNames = 'tracking'; // Should not error
// @ts-expect-error - Should error for non-existent name
const _typeTest4: ExtractedNames = 'fake';
