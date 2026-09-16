export interface KeyValueStore {
  setValue(key: string, value: unknown): Promise<void>;
}

/**
 * In-memory Key-Value Store for local FakeProvider runs and tests.
 */
export class LocalKeyValueStore implements KeyValueStore {
  readonly #entries = new Map<string, unknown>();

  async setValue(key: string, value: unknown): Promise<void> {
    this.#entries.set(key, value);
  }

  get(key: string): unknown {
    return this.#entries.get(key);
  }
}
