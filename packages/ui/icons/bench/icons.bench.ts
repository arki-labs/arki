// Bundle size of the same icons from @arki/icons and from other React icon libraries.
// Run: `bun run bench`.

import { defineSuite, size } from '@arki/bench';

const DRAWINGS = 'other drawings, one weight';

export default defineSuite({
  id: '@arki/icons',
  intro:
    'Bundle size of the same icons imported from @arki/icons and from popular React icon libraries. The main entry of @arki/icons is Phosphor, so Phosphor imported directly is a plain row to show the wrapper cost.',
  notes: [
    'Only Phosphor draws the same icons as @arki/icons. Lucide and Font Awesome draw other shapes and ship one style per icon, so they are measured but never ranked (`differs`).',
    'Phosphor components carry all six weights (thin to duotone) in each icon, so they are larger per icon than single-weight libraries.',
    'react-icons is measured through its Font Awesome 6 set (`react-icons/fa6`), the set most guides show first.',
    'Sizes are minified, tree-shaken, with react left out, for the browser.',
  ],
  groups: [
    size({
      kind: 'size',
      id: 'one-icon',
      title: '1 icon',
      baseline: 'arki',
      cases: {
        arki: {
          label: '@arki/icons',
          package: '@arki/icons',
          limit: '1 kB',
          source: `export { Check } from '@arki/icons';`,
        },
        phosphor: {
          label: '@phosphor-icons/react (direct)',
          package: '@phosphor-icons/react',
          source: `export { Check } from '@phosphor-icons/react';`,
        },
        lucide: {
          label: 'lucide-react',
          package: 'lucide-react',
          source: `export { Check } from 'lucide-react';`,
          differs: DRAWINGS,
        },
        'react-icons': {
          label: 'react-icons (fa6)',
          package: 'react-icons',
          source: `export { FaCheck } from 'react-icons/fa6';`,
          differs: DRAWINGS,
        },
      },
    }),
    size({
      kind: 'size',
      id: 'ten-icons',
      title: '10 common icons',
      note: 'check, x, menu, search, user, settings, home, arrow-right, trash, plus.',
      baseline: 'arki',
      cases: {
        arki: {
          label: '@arki/icons',
          package: '@arki/icons',
          limit: '8 kB',
          source: `export { Check, X, List, MagnifyingGlass, User, Gear, House, ArrowRight, Trash, Plus } from '@arki/icons';`,
        },
        phosphor: {
          label: '@phosphor-icons/react (direct)',
          package: '@phosphor-icons/react',
          source: `export { Check, X, List, MagnifyingGlass, User, Gear, House, ArrowRight, Trash, Plus } from '@phosphor-icons/react';`,
        },
        lucide: {
          label: 'lucide-react',
          package: 'lucide-react',
          source: `export { Check, X, Menu, Search, User, Settings, House, ArrowRight, Trash, Plus } from 'lucide-react';`,
          differs: DRAWINGS,
        },
        'react-icons': {
          label: 'react-icons (fa6)',
          package: 'react-icons',
          source: `export { FaCheck, FaXmark, FaBars, FaMagnifyingGlass, FaUser, FaGear, FaHouse, FaArrowRight, FaTrash, FaPlus } from 'react-icons/fa6';`,
          differs: DRAWINGS,
        },
      },
    }),
  ],
});
