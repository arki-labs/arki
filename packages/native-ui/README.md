# @arki/native-ui

A comprehensive React Native UI component library based on [React Native Reusables](https://reactnativereusables.com/), providing accessible, customizable components with NativeWind styling.

## Overview

This package provides:
- 🎨 **NativeWind Integration**: Tailwind CSS styling for React Native
- ♿ **Accessibility First**: Built on top of rn-primitives for proper accessibility
- 🔧 **Fully Customizable**: Components live in your codebase, not node_modules
- 📦 **Self-Contained**: All utilities and primitives bundled

## Installation

This package is part of the workspace and uses catalog dependencies:

```bash
pnpm add @arki/native-ui
```

### Peer Dependencies

Ensure your project has these installed:
- `react` (catalog:react19)
- `react-native` (catalog:expo)
- `react-native-reanimated` (catalog:expo)
- `react-native-gesture-handler` (catalog:expo)
- `react-native-svg` (catalog:expo)

### NativeWind Setup

This library requires NativeWind v4 to be configured in your project. Follow the [NativeWind setup guide](https://www.nativewind.dev/getting-started/react-native).

## Package Structure

```
@arki/native-ui/
├── src/
│   ├── lib/           # Utilities
│   │   ├── cn.ts      # Classname merging utility
│   │   ├── utils.ts   # Helper functions
│   │   └── colors.ts  # Color utilities
│   ├── primitives/    # Accessibility primitives (to be added)
│   └── components/    # UI components (to be added)
```

## Available Utilities

### `cn()` - Classname Utility

Merges Tailwind CSS classes with proper precedence:

```typescript
import { cn } from '@arki/native-ui/lib/cn';

cn('px-2 py-1', 'px-4') // => 'py-1 px-4'
cn('text-red-500', isActive && 'text-blue-500')
```

### Utils

```typescript
import { getInitials, truncate, formatFileSize } from '@arki/native-ui/lib/utils';

getInitials('John Doe') // => 'JD'
truncate('Long text here', 10) // => 'Long te...'
formatFileSize(1024) // => '1 KB'
```

### Colors

```typescript
import { hexToRgba, lightenColor, darkenColor } from '@arki/native-ui/lib/colors';

hexToRgba('#FF0000', 0.5) // => 'rgba(255, 0, 0, 0.5)'
lightenColor('#FF0000', 20) // Lighten by 20%
darkenColor('#FF0000', 20) // Darken by 20%
```

## Adding Components

Components from React Native Reusables can be added manually. Here's the process:

### 1. Find the Component

Visit [React Native Reusables](https://reactnativereusables.com/docs/components) and locate the component you want.

### 2. Check Dependencies

Each component page lists:
- **Package dependencies**: npm packages to install
- **Registry dependencies**: Other components it depends on

### 3. Copy Component Code

Navigate to the [GitHub repository](https://github.com/mrzachnugent/react-native-reusables) and find the component in `packages/registry/src/components/ui/`.

### 4. Adapt Imports

When copying a component, update these import patterns:

```typescript
// From:
import { cn } from '@/lib/utils';
import * as Primitive from '@rn-primitives/accordion';

// To:
import { cn } from '~/lib/cn';
import * as Primitive from '~/primitives/accordion';
```

### 5. Copy Required Primitives

If the component uses primitives (like `@rn-primitives/accordion`), you need to:

1. Find the primitive in [@roninoss/rn-primitives](https://github.com/roninoss/rn-primitives)
2. Copy the primitive to `src/primitives/[primitive-name]/`
3. Ensure it exports an `index.tsx` file

### 6. Add to Exports

Update `src/index.ts` to export your new component:

```typescript
export * from './components/button';
export * from './primitives/accordion';
```

## Example: Adding the Button Component

Here's a complete example of adding the Button component:

### Step 1: Copy the Component

From the RN Reusables repo, copy `button.tsx` to `src/components/button.tsx`.

### Step 2: Update Imports

```typescript
// src/components/button.tsx
import * as React from 'react';
import { Pressable } from 'react-native';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '~/lib/cn';

const buttonVariants = cva(
  'flex-row items-center justify-center rounded-md',
  {
    variants: {
      variant: {
        default: 'bg-primary',
        destructive: 'bg-destructive',
        outline: 'border border-input bg-background',
        secondary: 'bg-secondary',
        ghost: 'bg-transparent',
        link: 'bg-transparent',
      },
      size: {
        default: 'h-10 px-4 py-2',
        sm: 'h-9 rounded-md px-3',
        lg: 'h-11 rounded-md px-8',
        icon: 'h-10 w-10',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  }
);

export interface ButtonProps
  extends React.ComponentPropsWithoutRef<typeof Pressable>,
    VariantProps<typeof buttonVariants> {}

const Button = React.forwardRef<
  React.ElementRef<typeof Pressable>,
  ButtonProps
>(({ className, variant, size, ...props }, ref) => {
  return (
    <Pressable
      className={cn(buttonVariants({ variant, size, className }))}
      ref={ref}
      {...props}
    />
  );
});
Button.displayName = 'Button';

export { Button, buttonVariants };
```

### Step 3: Export

Add to `src/index.ts`:

```typescript
export * from './components/button';
```

### Step 4: Use It

```typescript
import { Button } from '@arki/native-ui';
import { Text } from 'react-native';

function MyScreen() {
  return (
    <Button variant="default" size="lg">
      <Text>Click me</Text>
    </Button>
  );
}
```

## Available Components to Add

Based on React Native Reusables documentation, you can add:

### Core Components
- ✅ Utilities (cn, utils, colors)
- ⏳ Button
- ⏳ Input
- ⏳ Text
- ⏳ Badge
- ⏳ Card

### Layout Components
- ⏳ Separator
- ⏳ Aspect Ratio
- ⏳ Skeleton

### Form Components
- ⏳ Checkbox
- ⏳ Radio Group
- ⏳ Switch
- ⏳ Textarea
- ⏳ Label
- ⏳ Select

### Overlay Components
- ⏳ Alert
- ⏳ Alert Dialog
- ⏳ Dialog
- ⏳ Popover
- ⏳ Tooltip
- ⏳ Hover Card

### Navigation Components
- ⏳ Tabs
- ⏳ Accordion
- ⏳ Collapsible
- ⏳ Context Menu
- ⏳ Dropdown Menu
- ⏳ Menubar

### Feedback Components
- ⏳ Progress
- ⏳ Avatar
- ⏳ Toggle
- ⏳ Toggle Group

## Resources

- [React Native Reusables Docs](https://reactnativereusables.com/docs)
- [React Native Reusables GitHub](https://github.com/mrzachnugent/react-native-reusables)
- [rn-primitives GitHub](https://github.com/roninoss/rn-primitives)
- [NativeWind Documentation](https://www.nativewind.dev)

## Contributing

When adding components:
1. Follow the existing code style
2. Add TypeScript types for all props
3. Include JSDoc comments for complex components
4. Test on both iOS and Android
5. Update this README with the new component

## License

MIT
