import { XMLParser } from 'fast-xml-parser';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  parseTagValue: false,
  processEntities: false,
});

/** Parse RSS/Atom XML without losing namespace keys, attributes or identifier strings. */
export function parseFeedDocument(xml: string): unknown {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('Feed entity declarations are not supported.');
  return parser.parse(xml);
}
