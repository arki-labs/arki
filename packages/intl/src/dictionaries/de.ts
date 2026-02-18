export default {
  ComingSoon: {
    title: 'Bald vorbei',
  },
  PostsTimeline: {
    title: 'Beiträge',
    description: 'Alle neuesten Artikel und Neuigkeiten aus {appTitle}.',
    rssFeed: 'RSS-Feed',
    readMore: 'Weiterlesen',
  },
  ChangelogTimeline: {
    title: 'Changelog',
    description: 'Alle neuesten Features, Fixes und Arbeiten zu {appTitle}.',
    rssFeed: 'RSS-Feed',
  },
  FeedbackPage: {
    title: 'Feedback',
    titleText: 'Wie können wir {appTitle} besser machen?',
    titleTextDescription:
      'Unten findest du alle Möglichkeiten, um deine Anliegen direkt an unser Team zu kommunizieren. Falls dein Feedback sensible persönliche Informationen enthält, kannst du uns gerne eine E-Mail an <a>{supportEmail}</a> schicken',
    featureRequest: 'Feature-Anfrage',
    featureRequestDescription: 'Hast du eine Idee für ein neues Feature? Klicke unten, um es einzureichen',
    featureRequestButton: 'Anfragen',
    reportBug: 'Fehler melden',
    reportBugDescription: 'Ups. Etwas ist kaputt. Bitte helfe uns, es zu beheben, indem du einen Fehler meldest',
    reportBugButton: 'Melden',
    generalFeedback: 'Allgemeine Rückmeldung',
    generalFeedbackDescription: 'Hast du sonst etwas, das du uns sagen möchtest? Wir hören zu!',
    generalFeedbackButton: 'Senden',
  },
  FeedbackUnified: {
    badge: 'Feedback',
    titleText: 'Hilf uns, {appTitle} besser zu machen',
    titleDescription:
      'Schreib dein Feedback frei. Wir leiten es an das richtige Team weiter. Für sensible Informationen schreibe an <a>{supportEmail}</a>.',
    composer: {
      title: 'Teile dein Feedback',
      description: 'Eine kurze Nachricht reicht. Mehr Details helfen bei schnellerem Follow-up.',
      placeholder: 'Was ist passiert, was hast du erwartet und was würde am meisten helfen?',
      submit: 'Feedback senden',
    },
    mood: {
      label: 'Wie hat sich das angefühlt?',
      frustrated: 'Frustriert',
      disappointed: 'Enttäuscht',
      neutral: 'Neutral',
      happy: 'Zufrieden',
      delighted: 'Begeistert',
    },
    quickStarter: {
      bug: 'Ich habe ein Problem mit...',
      feature: 'Ich wünschte, ich könnte...',
      praise: 'Ich mag besonders...',
    },
    guest: {
      nameLabel: 'Name',
      namePlaceholder: 'Dein Name',
      emailLabel: 'E-Mail',
      emailPlaceholder: 'du@beispiel.de',
    },
    context: {
      summaryPrefix: 'Automatisch angehängt',
    },
    processing: {
      title: 'Feedback wird gesendet',
      description: 'Bitte kurz warten, wir verarbeiten deine Nachricht.',
    },
    errors: {
      title: 'Feedback konnte nicht gesendet werden',
      retry: 'Erneut versuchen',
      edit: 'Zurück zum Formular',
      contentRequired: 'Bitte gib Feedback ein, bevor du sendest.',
      guestIdentityRequired: 'Bitte gib sowohl Namen als auch E-Mail an.',
      antiSpam: 'Bitte schließe die Sicherheitsprüfung ab und versuche es erneut.',
    },
    summary: {
      heading: 'Verstanden - das haben wir erhalten',
      done: 'Fertig',
      sendMore: 'Weiteres Feedback senden',
    },
    followUp: {
      submit: 'Details hinzufügen',
      skip: 'Überspringen',
    },
    category: {
      bug: 'Fehler',
      featureRequest: 'Feature-Anfrage',
      general: 'Allgemein',
      praise: 'Lob',
      question: 'Frage',
      support: 'Support',
    },
  },
} as const;
