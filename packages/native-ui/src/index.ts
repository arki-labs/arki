/**
 * @arki/native-ui
 *
 * React Native UI component library based on React Native Reusables
 * with NativeWind styling and accessibility primitives.
 *
 * @see https://reactnativereusables.com/docs
 * @see README.md for component addition guide
 */

// ============================================
// Utilities
// ============================================
export { cn } from './lib/cn';
export {
  getInitials,
  truncate,
  formatFileSize,
  debounce,
} from './lib/utils';
export {
  isValidHexColor,
  hexToRgba,
  lightenColor,
  darkenColor,
} from './lib/colors';

// ============================================
// Components
// ============================================
export * from './components/accordion';
export * from './components/alert';
export * from './components/alert-dialog';
export * from './components/aspect-ratio';
export * from './components/avatar';
export * from './components/badge';
export * from './components/button';
export * from './components/card';
export * from './components/checkbox';
export * from './components/collapsible';
export * from './components/context-menu';
export * from './components/dialog';
export * from './components/dropdown-menu';
export * from './components/hover-card';
export * from './components/icon';
export * from './components/input';
export * from './components/label';
export * from './components/menubar';
export * from './components/native-only-animated-view';
export * from './components/popover';
export * from './components/progress';
export * from './components/radio-group';
export * from './components/select';
export * from './components/separator';
export * from './components/skeleton';
export * from './components/switch';
export * from './components/tabs';
export * from './components/text';
export * from './components/textarea';
export * from './components/toggle';
export * from './components/toggle-group';
export * from './components/tooltip';
