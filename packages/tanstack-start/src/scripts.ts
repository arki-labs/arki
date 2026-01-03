/**
 * Analytics and Third-Party Script Components for TanStack Start
 *
 * Provides components for integrating analytics and other third-party scripts.
 * Uses safe external script loading patterns - no inline scripts.
 */

import React from 'react';

export interface AnalyticsConfig {
  /**
   * Analytics provider type
   */
  provider: 'plausible' | 'google-analytics' | 'custom';

  /**
   * Provider-specific configuration
   */
  config: {
    /**
     * Site domain for Plausible
     */
    domain?: string;

    /**
     * Measurement ID for Google Analytics
     */
    measurementId?: string;

    /**
     * Custom script URL
     */
    src?: string;

    /**
     * Enable in development
     * @default false
     */
    enableDev?: boolean;
  };
}

/**
 * Analytics script component for various providers
 * Uses external script loading only - no inline scripts for security.
 *
 * @example
 * ```tsx
 * // In __root.tsx
 * <AnalyticsScript
 *   provider="plausible"
 *   config={{ domain: 'example.com' }}
 * />
 * ```
 */
export function AnalyticsScript(props: AnalyticsConfig): React.ReactElement | null {
  const { provider, config } = props;
  const isDev = typeof window !== 'undefined' && window.location.hostname === 'localhost';

  // Skip in development unless explicitly enabled
  if (isDev && !config.enableDev) {
    return null;
  }

  switch (provider) {
    case 'plausible':
      if (!config.domain) {
        console.warn('Plausible analytics requires a domain');
        return null;
      }
      return React.createElement('script', {
        defer: true,
        'data-domain': config.domain,
        src: 'https://plausible.io/js/script.js',
      });

    case 'google-analytics':
      if (!config.measurementId) {
        console.warn('Google Analytics requires a measurementId');
        return null;
      }
      // Google Analytics requires gtag.js loader - inline config must be done client-side
      return React.createElement('script', {
        async: true,
        src: `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(config.measurementId)}`,
      });

    case 'custom':
      if (!config.src) {
        console.warn('Custom analytics requires a src');
        return null;
      }
      return React.createElement('script', {
        src: config.src,
        defer: true,
      });

    default:
      return null;
  }
}

/**
 * Initialize Google Analytics after the script loads.
 * Call this in a useEffect in your root component.
 *
 * @example
 * ```tsx
 * useEffect(() => {
 *   initGoogleAnalytics('G-XXXXXXXXXX');
 * }, []);
 * ```
 */
export function initGoogleAnalytics(measurementId: string): void {
  if (typeof window === 'undefined') return;

  // Type-safe window extension
  const win = window as typeof window & {
    dataLayer?: unknown[];
    gtag?: (...args: unknown[]) => void;
  };

  win.dataLayer = win.dataLayer || [];
  win.gtag = function gtag(...args: unknown[]) {
    win.dataLayer?.push(args);
  };
  win.gtag('js', new Date());
  win.gtag('config', measurementId);
}

/**
 * Initialize Microsoft Clarity after loading.
 * Call this in a useEffect in your root component.
 *
 * @example
 * ```tsx
 * useEffect(() => {
 *   initClarity('your-project-id');
 * }, []);
 * ```
 */
export function initClarity(projectId: string): void {
  if (typeof window === 'undefined') return;

  const script = document.createElement('script');
  script.async = true;
  script.src = `https://www.clarity.ms/tag/${encodeURIComponent(projectId)}`;
  document.head.appendChild(script);
}

/**
 * Cloudflare Turnstile script component
 */
export interface TurnstileConfig {
  /**
   * Site key for Turnstile
   */
  siteKey: string;

  /**
   * Callback function name when challenge is solved
   */
  callback?: string;
}

export function TurnstileScript(_props: TurnstileConfig): React.ReactElement {
  return React.createElement('script', {
    src: 'https://challenges.cloudflare.com/turnstile/v0/api.js',
    async: true,
    defer: true,
  });
}

/**
 * Google AdSense meta tag component
 */
export interface AdsenseConfig {
  /**
   * AdSense publisher ID (ca-pub-XXXXXXXXXXXXXXXX)
   */
  publisherId: string;
}

export function AdsenseMeta(props: AdsenseConfig): React.ReactElement {
  return React.createElement('meta', {
    name: 'google-adsense-account',
    content: props.publisherId,
  });
}

/**
 * Axiom Web Vitals script component
 */
export interface AxiomConfig {
  /**
   * Axiom dataset token
   */
  token: string;
}

export function AxiomScript(props: AxiomConfig): React.ReactElement {
  return React.createElement('script', {
    src: 'https://axiom.co/js/axiom.min.js',
    'data-token': props.token,
    defer: true,
  });
}

/**
 * CSP (Content Security Policy) meta component
 */
export interface CSPConfig {
  /**
   * CSP directives
   */
  directives: Record<string, string[]>;
}

export function ContentSecurityPolicy(props: CSPConfig): React.ReactElement {
  const policy = Object.entries(props.directives)
    .map(([directive, sources]) => `${directive} ${sources.join(' ')}`)
    .join('; ');

  return React.createElement('meta', {
    httpEquiv: 'Content-Security-Policy',
    content: policy,
  });
}
