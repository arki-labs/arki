/**
 * Labelled cases. The labels are the "human" side of the calibration: the judge is measured
 * against them. Source A is the US-23 newsletter; source B is a second, unrelated article.
 */

export const sourceA = [
  'Lisbon City Council published a canopy study on 12 June 2023. The study was led by Dr Ana Ferreira of the University of Lisbon.',
  'The study measured 120 streets in 14 neighbourhoods. On the hottest day, 21 July 2023, streets with 30 percent tree canopy were 4 degrees Celsius cooler at noon than streets with no canopy.',
  'Oak and plane trees cooled streets the most, because their crowns are wide. Palm trees cooled streets the least, because they cast little shade.',
  'Dr Ferreira said: "Shade matters more than the number of trees." The council plants 5000 trees each year.',
].join('\n\n');

export const sourceB = [
  'The Norwegian postal service Posten cut Saturday letter delivery in 2016 and moved to delivery every second weekday in 2020.',
  'Letter volume fell by 70 percent between 2000 and 2022, while parcel volume doubled in the same period.',
  'Posten says 1200 rural routes are now served by a shared carrier who also delivers newspapers.',
  'A 2023 survey by the consumer council found that 62 percent of respondents had not noticed the change.',
].join('\n\n');

export type FaithfulnessCase = {
  readonly id: string;
  readonly source: 'A' | 'B';
  readonly claim: string;
  readonly label: 'supported' | 'unsupported';
  /** Why the label is what it is; the kind of error the judge must catch. */
  readonly kind: string;
};

export const faithfulnessCases: readonly FaithfulnessCase[] = [
  // supported, verbatim or near-verbatim
  {
    id: 's01',
    source: 'A',
    claim: 'Lisbon City Council published a canopy study on 12 June 2023.',
    label: 'supported',
    kind: 'verbatim',
  },
  {
    id: 's02',
    source: 'A',
    claim: 'The study covered 120 streets across 14 neighbourhoods.',
    label: 'supported',
    kind: 'paraphrase',
  },
  {
    id: 's03',
    source: 'A',
    claim: 'Streets with 30% canopy were 4°C cooler at noon than streets without trees on the hottest day.',
    label: 'supported',
    kind: 'paraphrase+units',
  },
  {
    id: 's04',
    source: 'A',
    claim: 'Oak and plane trees cooled streets the most.',
    label: 'supported',
    kind: 'verbatim',
  },
  {
    id: 's05',
    source: 'A',
    claim: 'Palm trees gave the least cooling because they cast little shade.',
    label: 'supported',
    kind: 'paraphrase',
  },
  {
    id: 's06',
    source: 'A',
    claim: 'According to Dr Ferreira, shade matters more than how many trees there are.',
    label: 'supported',
    kind: 'paraphrase of quote',
  },
  {
    id: 's07',
    source: 'A',
    claim: 'The council plants five thousand trees a year.',
    label: 'supported',
    kind: 'number as words',
  },
  {
    id: 's08',
    source: 'B',
    claim: 'Posten stopped Saturday letter delivery in 2016.',
    label: 'supported',
    kind: 'paraphrase',
  },
  {
    id: 's09',
    source: 'B',
    claim: 'Between 2000 and 2022 letter volume dropped by 70 percent.',
    label: 'supported',
    kind: 'reorder',
  },
  {
    id: 's10',
    source: 'B',
    claim: 'Parcel volume doubled between 2000 and 2022.',
    label: 'supported',
    kind: 'split sentence',
  },
  {
    id: 's11',
    source: 'B',
    claim: 'A shared carrier who also delivers newspapers now serves 1200 rural routes.',
    label: 'supported',
    kind: 'passive voice',
  },
  {
    id: 's12',
    source: 'B',
    claim: 'In a 2023 consumer council survey, 62 percent had not noticed the change.',
    label: 'supported',
    kind: 'paraphrase',
  },
  // unsupported
  {
    id: 'u01',
    source: 'A',
    claim: 'The study found streets with 30 percent canopy were 8 degrees cooler at noon.',
    label: 'unsupported',
    kind: 'wrong number',
  },
  {
    id: 'u02',
    source: 'A',
    claim: 'The study was led by Dr Ana Ferreira of the University of Porto.',
    label: 'unsupported',
    kind: 'wrong entity',
  },
  { id: 'u03', source: 'A', claim: 'Palm trees cooled streets the most.', label: 'unsupported', kind: 'swapped fact' },
  {
    id: 'u04',
    source: 'A',
    claim: 'The council will double its tree planting to 10000 trees a year.',
    label: 'unsupported',
    kind: 'fabricated plan',
  },
  {
    id: 'u05',
    source: 'A',
    claim: 'The study recommends replacing palm trees with oaks across the city.',
    label: 'unsupported',
    kind: 'plausible inference not stated',
  },
  {
    id: 'u06',
    source: 'A',
    claim: 'The study was published in the journal Nature Cities.',
    label: 'unsupported',
    kind: 'fabricated detail',
  },
  {
    id: 'u07',
    source: 'A',
    claim: 'Streets with no canopy were cooler at noon than streets with trees.',
    label: 'unsupported',
    kind: 'negation',
  },
  {
    id: 'u08',
    source: 'B',
    claim: 'Posten moved to delivery every second weekday in 2016.',
    label: 'unsupported',
    kind: 'wrong year',
  },
  {
    id: 'u09',
    source: 'B',
    claim: 'Letter volume fell by 70 percent and parcel volume tripled.',
    label: 'unsupported',
    kind: 'half wrong',
  },
  {
    id: 'u10',
    source: 'B',
    claim: 'Most Norwegians were angry about the change, the survey found.',
    label: 'unsupported',
    kind: 'contradicts tone',
  },
  {
    id: 'u11',
    source: 'B',
    claim: 'Posten plans to end letter delivery entirely by 2030.',
    label: 'unsupported',
    kind: 'fabricated plan',
  },
  {
    id: 'u12',
    source: 'B',
    claim: 'The shared rural carriers are paid by the newspapers.',
    label: 'unsupported',
    kind: 'fabricated detail',
  },
];

/** Harder: claims that follow trivially (supported), and inferences or generalisations that sound right (unsupported). */
export const hardFaithfulnessCases: readonly FaithfulnessCase[] = [
  {
    id: 'h01',
    source: 'A',
    claim: 'The study was published in June 2023.',
    label: 'supported',
    kind: 'follows trivially (date)',
  },
  {
    id: 'h02',
    source: 'A',
    claim: 'A University of Lisbon researcher led the canopy study.',
    label: 'supported',
    kind: 'follows trivially (affiliation)',
  },
  {
    id: 'h03',
    source: 'A',
    claim: 'The measurements covered more than a hundred streets.',
    label: 'supported',
    kind: 'follows trivially (120 > 100)',
  },
  {
    id: 'h04',
    source: 'B',
    claim: 'Posten changed its letter delivery schedule twice between 2016 and 2020.',
    label: 'supported',
    kind: 'follows trivially (two changes)',
  },
  {
    id: 'h05',
    source: 'B',
    claim: 'A majority of survey respondents had not noticed the change.',
    label: 'supported',
    kind: 'follows trivially (62% is a majority)',
  },
  {
    id: 'h06',
    source: 'A',
    claim: 'Trees with wide crowns gave more cooling than trees with narrow crowns.',
    label: 'supported',
    kind: 'generalisation stated as reason in source',
  },
  {
    id: 'h07',
    source: 'A',
    claim: 'More trees always means cooler streets.',
    label: 'unsupported',
    kind: 'contradicts the quote',
  },
  {
    id: 'h08',
    source: 'A',
    claim: 'The 4 degree difference was measured as a daily average.',
    label: 'unsupported',
    kind: 'subtle: source says at noon',
  },
  {
    id: 'h09',
    source: 'A',
    claim: 'The council has been planting 5000 trees a year since the study.',
    label: 'unsupported',
    kind: 'adds a causal/time link',
  },
  {
    id: 'h10',
    source: 'B',
    claim: 'Letter volume fell because parcel volume doubled.',
    label: 'unsupported',
    kind: 'invented causation',
  },
  {
    id: 'h11',
    source: 'B',
    claim: 'The 2023 survey was commissioned by Posten.',
    label: 'unsupported',
    kind: 'wrong attribution (consumer council)',
  },
  {
    id: 'h12',
    source: 'B',
    claim: 'Rural customers receive newspapers and letters on the same days.',
    label: 'unsupported',
    kind: 'plausible inference not stated',
  },
];
