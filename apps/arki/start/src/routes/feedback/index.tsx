import { createFileRoute } from '@tanstack/react-router';
import { NuqsAdapter } from 'nuqs/adapters/tanstack-router';

import { FeedbackPageTemplateIn3Cards } from '@fleet/feedback/react';

import config from '~/config';
import { getDefaultMeta } from '~/shared-metadata';

export const Route = createFileRoute('/feedback/')({
  head: () =>
    getDefaultMeta({
      title: `Feedback | ${config.appTitle}`,
      description: `Share your feedback about ${config.appTitle}`,
    }),
  component: FeedbackPage,
});

function FeedbackPage() {
  // The feedback page is public; it brings its own URL-state adapter (the forms open from `?contactFormOpen=true`)
  // rather than relying on the signed-in providers.
  return (
    <NuqsAdapter>
      <FeedbackPageTemplateIn3Cards appTitle={config.appTitle} supportEmail={`support@${config.appDomain}`} />
    </NuqsAdapter>
  );
}
