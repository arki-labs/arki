import { infra } from '../../../../../../../unit-contract.js';

/** Private to `digest.deliver`. A user called `bounce` never gets mail. */
export const mailer = infra({
  name: 'mailer',
  provides: {
    mailer: () => {
      const sent: string[] = [];
      return {
        sent,
        send: (to: string) => {
          if (to === 'bounce') return Promise.resolve(false);
          sent.push(to);
          return Promise.resolve(true);
        },
      };
    },
  },
});
