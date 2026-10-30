import { parseISO } from '@arki/date/core';
import { format } from '@arki/date/format';
import { isInstant } from '@arki/date/types';

type Props = {
  value: string;
  title?: string;
  className?: string;
};

const DateTime = ({ title, value, className }: Props) => {
  // Front-matter text is outside input: parseISO returns a failure for bad text, so show the text as written.
  const parsed = parseISO(value);
  return (
    <time title={title} className={className} dateTime={value}>
      {isInstant(parsed) ? format(parsed, 'yyyy-MM-dd') : value}
    </time>
  );
};

export default DateTime;
