/**
 * @arki/tanstack-start
 *
 * Shared utilities and patterns for TanStack Start applications.
 * This package provides reusable components and utilities for building
 * full-stack React applications with TanStack Start and Bun.
 */

export { createAppConfig, type AppConfig } from './app.config';
export { createRouter, type RouterConfig } from './router';
export { createServerHandler, type ServerConfig } from './server';
export { Head, Meta, Scripts, type HeadProps, type MetaProps } from './seo';
export { AnalyticsScript, type AnalyticsConfig } from './scripts';
export { RootErrorComponent } from './error';
export { DevTools, type DevToolsProps } from './devtools';
