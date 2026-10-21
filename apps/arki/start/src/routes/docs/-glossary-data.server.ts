import { allGlossaries } from 'content-collections';

function theGlossary() {
  const [glossary] = allGlossaries;
  if (glossary === undefined) throw new Error('glossary: src/content/glossary/glossary.md is missing');
  return glossary;
}

/** The parsed glossary, server only (`*.server.ts` never reaches the browser bundle). */
export function readGlossary() {
  const glossary = theGlossary();
  return { title: glossary.title, intro: glossary.intro, columns: glossary.columns, terms: glossary.terms };
}

/** The glossary as markdown without its frontmatter, the way `/llms-full.txt` serves it. */
export function readGlossaryMarkdown(): string {
  return theGlossary().content;
}
