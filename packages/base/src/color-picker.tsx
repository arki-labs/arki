'use client';

import { useMemo, useState } from 'react';
import { colord, extend } from 'colord';
import namesPlugin from 'colord/plugins/names';
import { RgbaStringColorPicker } from 'react-colorful';

import type { ButtonProps } from './button';
import { Button } from './button';
import { cn } from './cn';
import { Input } from './input';
import { Popover, PopoverContent, PopoverTrigger } from './popover';

extend([namesPlugin]);

type ColorPickerProps = {
  value: string;
  onChange: (value: string) => void;
  onBlur?: () => void;
  presetColors?: string[];
}

function ColorPicker({
  disabled,
  value,
  onChange,
  onBlur,
  name,
  className,
  ref,
  presetColors,
  ...props
}: Omit<ButtonProps, 'value' | 'onChange' | 'onBlur'> & ColorPickerProps & { ref?: React.Ref<HTMLInputElement> }) {
  const [open, setOpen] = useState(false);

  const parsedValue = useMemo(() => {
    return value.startsWith('rgba') ? value : colord(value).toRgbString();
  }, [value]);

  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger
        disabled={disabled}
        onBlur={onBlur}
        render={
          <Button
            {...props}
            className={cn('block', className)}
            name={name}
            onClick={() => {
              setOpen(true);
            }}
            size="icon"
            style={{
              backgroundColor: parsedValue,
            }}
            variant="outline"
          />
        }
      >
        <div />
      </PopoverTrigger>
      <PopoverContent className="w-full">
        <RgbaStringColorPicker color={parsedValue} onChange={onChange} />
        <Input
          maxLength={7}
          onChange={e => {
            onChange(e?.currentTarget?.value);
          }}
          ref={ref}
          value={parsedValue}
          className="mt-2"
          autoComplete="off"
          autoCorrect="off"
          spellCheck="false"
        />

        {presetColors && (
          <div className="mt-2 flex flex-wrap gap-2">
            {presetColors.map(color => (
              <Button
                key={color}
                variant="outline"
                onClick={() => onChange(color)}
                style={{ backgroundColor: color }}
                className="h-8 w-8 p-0"
              />
            ))}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

export { ColorPicker };
