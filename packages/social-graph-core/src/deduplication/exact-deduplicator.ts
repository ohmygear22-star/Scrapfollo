export class ExactDeduplicator {
  readonly #keys = new Set<string>();

  /** Reports whether the key was already accepted without mutating the key set. */
  has(key: string): boolean {
    return this.#keys.has(key);
  }

  accept(key: string): boolean {
    if (this.#keys.has(key)) return false;

    this.#keys.add(key);
    return true;
  }
}
