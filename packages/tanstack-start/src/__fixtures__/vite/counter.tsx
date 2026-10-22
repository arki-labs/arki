/** A component with a derived value: the React Compiler memoizes it through `react/compiler-runtime`. */
import { useState } from 'react';

export function Counter({ label }: { readonly label: string }) {
  const [count, setCount] = useState(0);
  const text = `${label}: ${count}`;
  return (
    <button type="button" onClick={() => setCount(count + 1)}>
      {text}
    </button>
  );
}
