export class ExactDeduplicator {
  readonly #keys = new Set<string>();

  accept(key: string): boolean {
    if (this.#keys.has(key)) return false;

    this.#keys.add(key);
    return true;
  }
}
