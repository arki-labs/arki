import { render, renderHook } from '@testing-library/react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { Form, useForm, useFormField } from '../form';
import { useViewport } from '../hooks/use-viewport';

describe('useViewport', () => {
  it('renders the server desktop default first, then reads the real window after mount', () => {
    vi.stubGlobal('innerWidth', 390);
    function Probe() {
      return <span>{useViewport().type}</span>;
    }
    // Server render and the first client render must agree, or a phone hydrates different markup.
    expect(renderToString(<Probe />)).toContain('desktop');
    const { result } = renderHook(() => useViewport());
    expect(result.current.type).toBe('mobile');
    vi.unstubAllGlobals();
  });
});

function Probe() {
  useFormField();
  return null;
}

describe('useFormField', () => {
  it('names <FormField> as the missing parent inside a <Form>', () => {
    const quiet = vi.spyOn(console, 'error').mockReturnValue();
    function Harness() {
      const form = useForm();
      return (
        <Form {...form}>
          <Probe />
        </Form>
      );
    }
    expect(() => render(<Harness />)).toThrow('useFormField should be used within <FormField>');
    quiet.mockRestore();
  });

  it('names <Form> as the missing parent outside one, not a TypeError', () => {
    const quiet = vi.spyOn(console, 'error').mockReturnValue();
    expect(() => render(<Probe />)).toThrow('useFormField should be used within <Form>');
    quiet.mockRestore();
  });
});
