import { createServerFn } from '@tanstack/react-start';

import { readGlossary } from './-glossary-data.server';

/** The glossary's terms, with repo-relative links the route resolves. */
export const getGlossaryFn = createServerFn({ method: 'GET' }).handler(() => readGlossary());
