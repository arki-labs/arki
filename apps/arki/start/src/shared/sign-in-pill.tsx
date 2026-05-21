import { Link } from '@tanstack/react-router';

import { SignInIcon } from '@arki/icons/phosphor';
import { SignInPillFrame } from '@arki/sitekit/layout/workspace/app-sidebar.tsx';

export const signInPill = (
  <SignInPillFrame>
    <Link to="/auth/$pathname" params={{ pathname: 'sign-in' }}>
      <SignInIcon className="h-4 w-4" />
      <span className="group-data-[collapsible=icon]:hidden">Sign in</span>
    </Link>
  </SignInPillFrame>
);
