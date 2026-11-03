import { MDXContent } from '@content-collections/mdx/react';

import { ContentSection } from './ContentSection.js';
import { components } from './mdx-components.js';

type MdxProps = {
  code: string;
  className?: string;
};

export function Mdx({ code, className }: MdxProps) {
  return (
    // FIXME: weird behaviour when `prose-headings:font-cal` and on mouse movement font gets bigger
    <ContentSection className={className}>
      <MDXContent code={code} components={components} />
    </ContentSection>
  );
}
