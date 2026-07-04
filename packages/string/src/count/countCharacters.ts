import voca from 'voca';

export function countCharacters(subject?: string): number {
  return voca.count(subject);
}
