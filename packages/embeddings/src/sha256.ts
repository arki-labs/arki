/**
 * SHA-256 in plain TypeScript (FIPS 180-4), as lowercase hex. The cache key needs one hash that is
 * the same on every runtime the package claims: Web Crypto's `subtle` is missing on Hermes and in
 * an insecure browser context, and it is async. Not exported: it is not a crypto library.
 */

/** The round constants and the initial hash, from FIPS 180-4 § 4.2.2 and § 5.3.3 (written in decimal). */
const K = new Uint32Array([
  1_116_352_408, 1_899_447_441, 3_049_323_471, 3_921_009_573, 961_987_163, 1_508_970_993, 2_453_635_748, 2_870_763_221,
  3_624_381_080, 310_598_401, 607_225_278, 1_426_881_987, 1_925_078_388, 2_162_078_206, 2_614_888_103, 3_248_222_580,
  3_835_390_401, 4_022_224_774, 264_347_078, 604_807_628, 770_255_983, 1_249_150_122, 1_555_081_692, 1_996_064_986,
  2_554_220_882, 2_821_834_349, 2_952_996_808, 3_210_313_671, 3_336_571_891, 3_584_528_711, 113_926_993, 338_241_895,
  666_307_205, 773_529_912, 1_294_757_372, 1_396_182_291, 1_695_183_700, 1_986_661_051, 2_177_026_350, 2_456_956_037,
  2_730_485_921, 2_820_302_411, 3_259_730_800, 3_345_764_771, 3_516_065_817, 3_600_352_804, 4_094_571_909, 275_423_344,
  430_227_734, 506_948_616, 659_060_556, 883_997_877, 958_139_571, 1_322_822_218, 1_537_002_063, 1_747_873_779,
  1_955_562_222, 2_024_104_815, 2_227_730_452, 2_361_852_424, 2_428_436_474, 2_756_734_187, 3_204_031_479,
  3_329_325_298,
]);

const INITIAL = [
  1_779_033_703, 3_144_134_277, 1_013_904_242, 2_773_480_762, 1_359_893_119, 2_600_822_924, 528_734_635, 1_541_459_225,
] as const;

const rotate = (value: number, bits: number) => (value >>> bits) | (value << (32 - bits));

/** The hex SHA-256 of `bytes`. */
export function sha256Hex(bytes: Uint8Array): string {
  // Message + 0x80 + zero padding + 64-bit big-endian bit length, to a multiple of 64 bytes.
  const padded = new Uint8Array(Math.ceil((bytes.length + 9) / 64) * 64);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(bytes.length / 0x20_00_00_00), false);
  view.setUint32(padded.length - 4, (bytes.length * 8) >>> 0, false);

  const hash = new Uint32Array(INITIAL);
  const words = new Uint32Array(64);
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let index = 0; index < 16; index++) words[index] = view.getUint32(offset + index * 4, false);
    for (let index = 16; index < 64; index++) {
      const back15 = words[index - 15] ?? 0;
      const back2 = words[index - 2] ?? 0;
      const sigma0 = rotate(back15, 7) ^ rotate(back15, 18) ^ (back15 >>> 3);
      const sigma1 = rotate(back2, 17) ^ rotate(back2, 19) ^ (back2 >>> 10);
      words[index] = (words[index - 16] ?? 0) + sigma0 + (words[index - 7] ?? 0) + sigma1;
    }
    let [a = 0, b = 0, c = 0, d = 0, e = 0, f = 0, g = 0, h = 0] = hash;
    for (let index = 0; index < 64; index++) {
      const choose = (e & f) ^ (~e & g);
      const temp1 =
        (h + (rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25)) + choose + (K[index] ?? 0) + (words[index] ?? 0)) >>> 0;
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = ((rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22)) + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }
    const next = [a, b, c, d, e, f, g, h];
    for (const [index, value] of next.entries()) hash[index] = ((hash[index] ?? 0) + value) >>> 0;
  }
  let hex = '';
  for (const word of hash) hex += word.toString(16).padStart(8, '0');
  return hex;
}
