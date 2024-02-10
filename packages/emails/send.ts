import { createId } from '@paralleldrive/cuid2';
import { Resend } from 'resend';
import { type CreateEmailOptions } from 'resend/build/src/emails/interfaces';

export const makeSender = (apiKey: string) => async (payload: CreateEmailOptions) => {
  const isDevOrStaging = process.env['NODE_ENV'] === 'development' || process.env['VERCEL_ENV'] === 'preview';
  const to = isDevOrStaging ? 'delivered@resend.dev' : payload.to;
  const resend = new Resend(apiKey);

  try {
    await resend.emails.send({
      ...payload,
      to,
      headers: {
        'X-Entity-Ref-ID': createId(),
        ...payload.headers,
      },
    });
  } catch (error) {
    console.error(error);

    throw new Error(`Verification request email to ${payload.to} can't be sent`);
  }
};
