/**
 * @arki/geo - Main exports (server-side + shared)
 *
 * This entry point includes core utilities and server-side geocoding.
 * For React hooks and components, use '@arki/geo/react'
 */

// Core utilities (isomorphic - work everywhere)
export * from './core';

// Server-side only - Don't import in frontend!
// These require Node.js and will cause bundle bloat if imported in client
// export * from './geocoding'; // Commented out - use '@arki/geo/geocoding' instead
