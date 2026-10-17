import { StrictMode } from 'react';
import { hydrateRoot } from 'react-dom/client';
import { StartClient } from '@tanstack/react-start/client';
import { registerPwa } from '@fleet/tanstack-start/pwa/client';

hydrateRoot(
  document,
  <StrictMode>
    <StartClient />
  </StrictMode>,
);

registerPwa();
