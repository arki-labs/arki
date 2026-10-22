/** A server entry importing one icon and the context through the Phosphor index, the way app code does. */
import { Heart, IconContext } from '@phosphor-icons/react';

export default {
  fetch: (): Response => Response.json({ heart: typeof Heart, context: typeof IconContext }),
};
