/** Seeded 32-bit generator. One `next()` per `pick random` keeps every peer's sequence identical. */
export class Rng {
  state: number;
  calls = 0;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  next(): number {
    this.calls++;
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
}
