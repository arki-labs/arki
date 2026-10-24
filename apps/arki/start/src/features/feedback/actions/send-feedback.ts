import type { FeedbackFormActions } from '@fleet/feedback';
import {
  createFeedbackMailRoute,
  feedbackFormDataSchema,
  sendBugReportEmail,
  sendContactEmail,
  sendFeatureRequestEmail,
} from '@fleet/feedback/email';
import { createServerFn } from '@tanstack/react-start';

import config from '~/config';

// The feedback forms post here. Each server function runs the package's email handler on the
// server only (Turnstile check, Resend, secrets); the browser gets an RPC stub. The mail route
// (to `support@<appDomain>`, from this app's name) is built inside each handler so that no
// email code runs in, or is bundled into, the browser.
const sendContact = createServerFn({ method: 'POST' })
  .validator(feedbackFormDataSchema)
  .handler(({ data }) => sendContactEmail(data, createFeedbackMailRoute(config)));

const sendFeatureRequest = createServerFn({ method: 'POST' })
  .validator(feedbackFormDataSchema)
  .handler(({ data }) => sendFeatureRequestEmail(data, createFeedbackMailRoute(config)));

const sendBugReport = createServerFn({ method: 'POST' })
  .validator(feedbackFormDataSchema)
  .handler(({ data }) => sendBugReportEmail(data, createFeedbackMailRoute(config)));

export const feedbackFormActions = {
  contact: formData => sendContact({ data: formData }),
  featureRequest: formData => sendFeatureRequest({ data: formData }),
  bugReport: formData => sendBugReport({ data: formData }),
} satisfies FeedbackFormActions;
