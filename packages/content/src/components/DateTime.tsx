import { format } from '@arki/date/format';
import { parseISO } from '@arki/date/core';

type Props = {
  value: string;
  title?: string;
  className?: string;
};

const DateTime = ({ title, value, className }: Props) => (
  <time title={title} className={className} dateTime={value}>
    {format(parseISO(value), 'yyyy-MM-dd')}
  </time>
);

export default DateTime;
