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
export { cn } from './lib/cn.js';
export {
  getInitials,
  truncate,
  formatFileSize,
  debounce,
} from './lib/utils.js';
export {
  isValidHexColor,
  hexToRgba,
  lightenColor,
  darkenColor,
} from './lib/colors.js';

// ============================================
// Components
// ============================================
export * from './components/accordion.js';
export * from './components/alert.js';
export * from './components/alert-dialog.js';
export * from './components/aspect-ratio.js';
export * from './components/avatar.js';
export * from './components/badge.js';
export * from './components/button.js';
export * from './components/card.js';
export * from './components/checkbox.js';
export * from './components/collapsible.js';
export * from './components/context-menu.js';
export * from './components/dialog.js';
export * from './components/dropdown-menu.js';
export * from './components/hover-card.js';
export * from './components/icon.js';
export * from './components/input.js';
export * from './components/label.js';
export * from './components/menubar.js';
export * from './components/native-only-animated-view.js';
export * from './components/popover.js';
export * from './components/progress.js';
export * from './components/radio-group.js';
export * from './components/select.js';
export * from './components/separator.js';
export * from './components/skeleton.js';
export * from './components/switch.js';
export * from './components/tabs.js';
export * from './components/text.js';
export * from './components/textarea.js';
export * from './components/toggle.js';
export * from './components/toggle-group.js';
export * from './components/tooltip.js';
