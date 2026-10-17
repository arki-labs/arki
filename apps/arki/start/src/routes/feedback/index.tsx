import { createFileRoute } from '@tanstack/react-router';
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
  return <FeedbackPageTemplateIn3Cards appTitle={config.appTitle} supportEmail={`support@${config.appDomain}`} />;
}
