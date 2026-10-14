export type MathConstantCategory = 'circle' | 'exponential' | 'special' | 'radical' | 'logarithm';

export type MathConstant = {
  readonly value: number;
  readonly symbol: string;
  readonly latex: string;
  readonly name: string;
  readonly category: MathConstantCategory;
};

export const MATH_CONSTANTS: readonly MathConstant[] = [
  { value: Math.PI,                    symbol: 'π',   latex: '\\pi',        name: 'Pi',               category: 'circle'      },
  { value: Math.E,                     symbol: 'e',   latex: 'e',           name: "Euler's number",   category: 'exponential' },
  { value: (1 + Math.sqrt(5)) / 2,     symbol: 'φ',   latex: '\\varphi',    name: 'Golden ratio',     category: 'special'     },
  { value: 2 * Math.PI,                symbol: 'τ',   latex: '\\tau',       name: 'Tau (2π)',         category: 'circle'      },
  { value: Math.sqrt(2),               symbol: '√2',  latex: '\\sqrt{2}',   name: 'Square root of 2', category: 'radical'     },
  { value: Math.sqrt(3),               symbol: '√3',  latex: '\\sqrt{3}',   name: 'Square root of 3', category: 'radical'     },
  { value: Math.LN2,                   symbol: 'ln2', latex: '\\ln 2',      name: 'Natural log of 2', category: 'logarithm'   },
  { value: 0.5772156649015329,         symbol: 'γ',   latex: '\\gamma',     name: 'Euler-Mascheroni', category: 'special'     },
] as const;

export const CATEGORY_ORDER: readonly MathConstantCategory[] = [
  'circle',
  'exponential',
  'radical',
  'logarithm',
  'special',
];

export const CATEGORY_LABELS: Record<MathConstantCategory, string> = {
  circle:      'Circle',
  exponential: 'Exponential',
  radical:     'Radical',
  logarithm:   'Logarithm',
  special:     'Special',
};
