import { createId } from '@paralleldrive/cuid2';
import { type CreateEmailOptions } from 'resend/build/src/emails/interfaces';

/**
 * gatherResponse awaits and returns a response body as a string.
 * Use await gatherResponse(..) in an async function to get the response body
 * @param {Response} response
 */
async function gatherResponse(response: Response) {
  const { headers } = response;
  const contentType = headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    return JSON.stringify(await response.json());
  }
  return response.text();
}

export const send = async (apiKey: string, payload: CreateEmailOptions) => {
  const isDevOrStaging = process.env['NODE_ENV'] === 'development' || process.env['VERCEL_ENV'] === 'preview';
  const to = isDevOrStaging ? 'delivered@resend.dev' : payload.to;

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'X-Entity-Ref-ID': createId(),
        ...payload.headers,
      },
      body: JSON.stringify({
        ...payload,
        to: [to],
      }),
    });

    return gatherResponse(response);
  } catch (error) {
    console.error(error);

    throw new Error(`Verification request email to ${payload.to} can't be sent`);
  }
};
