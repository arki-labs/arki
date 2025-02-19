export default {
  ComingSoon: {
    title: 'Coming Soon',
  },
  PostsTimeline: {
    title: 'Posts',
    description: 'All the latest articles and news from {appTitle}.',
    rssFeed: 'RSS feed',
    readMore: 'Read more',
  },
  ChangelogTimeline: {
    title: 'Changelog',
    description: 'All the latest features, fixes and work to {appTitle}.',
    rssFeed: 'RSS feed',
  },
  FeedbackPage: {
    title: 'Feedback',
    titleText: 'How can we make {appTitle} better?',
    titleTextDescription:
      "Below, you'll find all the options to directly communicate your needs to our team. In case your feedback includes sensitive personal information feel free to email us at <a>{supportEmail}</a>",
    featureRequest: 'Feature request',
    featureRequestDescription: 'Have an idea for a new feature? Click below to submit it',
    featureRequestButton: 'Request',
    reportBug: 'Report a bug',
    reportBugDescription: 'Uh oh. Is something broken? Please help us fix it by submitting an issue',
    reportBugButton: 'Report',
    generalFeedback: 'General feedback',
    generalFeedbackDescription: "Anything else you'd like us to know? We're listening!",
    generalFeedbackButton: 'Send',
  },
} as const;
