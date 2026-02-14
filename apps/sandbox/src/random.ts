export interface Random {
  /** [0, 1) */
  next(): number;
  chance(probability: number): boolean;
  int(min: number, max: number): number;
  pick<T>(items: readonly T[]): T;
  /** n distinct items, order randomised */
  sample<T>(items: readonly T[], n: number): T[];
}

export function createRandom(source: () => number = Math.random): Random {
  const random: Random = {
    next: source,
    chance: (p) => source() < p,
    int: (min, max) => min + Math.floor(source() * (max - min + 1)),
    pick: (items) => {
      const item = items[Math.floor(source() * items.length)];
      if (item === undefined) throw new Error('pick from an empty list');
      return item;
    },
    sample: (items, n) => {
      const pool = [...items];
      const out: (typeof items)[number][] = [];
      while (out.length < n && pool.length) {
        const [item] = pool.splice(Math.floor(source() * pool.length), 1);
        if (item !== undefined) out.push(item);
      }
      return out;
    },
  };
  return random;
}

/** small deterministic PRNG for tests */
export function seededRandom(seed: number): Random {
  let state = seed >>> 0;
  return createRandom(() => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  });
}
