import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { AuthDefinition } from '../definition.js';
import type { SignInHandlers } from './sign-in-form.js';
import { defineAuth } from '../definition.js';
import { SignInForm } from './sign-in-form.js';

const handlers: SignInHandlers = {
  onMagicLink: () => Promise.resolve(),
  onPasswordSignIn: () => Promise.resolve(),
  onSocialSignIn: () => Promise.resolve(),
};

const render = (definition: AuthDefinition) =>
  // `createElement`, not JSX: the package compiles with `jsx: preserve`, which the test runner does not transform.
  renderToStaticMarkup(createElement(SignInForm, { definition, handlers }));

const app = { name: 'Notes', key: 'notes' };

describe('SignInForm', () => {
  it('renders a button for each enabled social provider and none for the others', () => {
    // A button for a provider the server has not enabled would be a dead end for the user.
    const html = render(defineAuth({ app, methods: ['magicLink', 'google', 'github'] }));
    expect(html).toContain('Sign in with Google');
    expect(html).toContain('Sign in with GitHub');
    expect(html).not.toContain('Sign in with Apple');
    expect(html).not.toContain('Sign in with Facebook');
    expect(html).not.toContain('Sign in with Microsoft');
  });

  it('opens on the magic link and offers the password toggle when both are on', () => {
    const html = render(defineAuth({ app, methods: ['password', 'magicLink'] }));
    expect(html).toContain('Send sign-in link');
    expect(html).toContain('Sign in with password');
    expect(html).not.toContain('or continue with');
  });

  it('shows no magic-link controls when only passwords are on', () => {
    const html = render(defineAuth({ app, methods: ['password'] }));
    expect(html).not.toContain('Send sign-in link');
    expect(html).not.toContain('Sign in with magic link');
    expect(html).toContain('type="password"');
  });

  it('shows no password controls when only magic links are on', () => {
    const html = render(defineAuth({ app, methods: ['magicLink'] }));
    expect(html).toContain('Send sign-in link');
    expect(html).not.toContain('Sign in with password');
    expect(html).not.toContain('type="password"');
  });

  it('shows only the social buttons when no email method is on', () => {
    const html = render(defineAuth({ app, methods: ['apple'] }));
    expect(html).toContain('Sign in with Apple');
    expect(html).not.toContain('type="email"');
    expect(html).not.toContain('or continue with');
  });
});
