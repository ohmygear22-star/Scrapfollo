export type PullResult<T> =
  | { done: false; value: T }
  | { done: true };

type Waiter<T> = (result: PullResult<T>) => void;
type SpaceWaiter = () => void;

export class QueueClosedError extends Error {
  constructor() {
    super("The event queue is closed");
    this.name = "QueueClosedError";
  }
}

/**
 * Capacity-bounded event queue connecting target producers to the single
 * batch consumer. A producer must reserve a slot before producing an event,
 * which bounds the number of produced-but-unconsumed events to `capacity`.
 */
export class BoundedEventQueue<T> {
  readonly #capacity: number;
  #buffer: T[] = [];
  #consumerWaiters: Waiter<T>[] = [];
  #spaceWaiters: SpaceWaiter[] = [];
  #reserved = 0;
  #closed = false;

  constructor(capacity: number) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) {
      throw new Error("event queue capacity must be a positive integer");
    }
    this.#capacity = capacity;
  }

  /** Waits until a slot is free. Rejects with QueueClosedError once closed. */
  async reserve(): Promise<void> {
    if (this.#closed) throw new QueueClosedError();
    while (this.#buffer.length + this.#reserved >= this.#capacity) {
      await new Promise<void>((resolve) => {
        this.#spaceWaiters.push(resolve);
      });
      if (this.#closed) throw new QueueClosedError();
    }
    this.#reserved += 1;
  }

  /** Returns a reserved slot without buffering a value. */
  release(): void {
    this.#reserved = Math.max(0, this.#reserved - 1);
    this.#wakeSpaceWaiters();
  }

  /** Buffers a value using a previously reserved slot; wakes one consumer. */
  push(value: T): void {
    this.#reserved = Math.max(0, this.#reserved - 1);
    if (this.#closed) {
      this.#wakeSpaceWaiters();
      return;
    }
    this.#buffer.push(value);
    const waiter = this.#consumerWaiters.shift();
    if (waiter !== undefined) {
      const value = this.#buffer.shift() as T;
      waiter({ done: false, value });
    }
    this.#wakeSpaceWaiters();
  }

  /** Returns the next buffered event, or done once closed and drained. */
  async pull(): Promise<PullResult<T>> {
    if (this.#buffer.length > 0) {
      const value = this.#buffer.shift() as T;
      this.#wakeSpaceWaiters();
      return { done: false, value };
    }
    if (this.#closed) return { done: true };
    return new Promise<PullResult<T>>((resolve) => {
      this.#consumerWaiters.push(resolve);
    });
  }

  /** Closes the queue: consumers drain remaining events then see done. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#buffer.length === 0) {
      const waiters = [...this.#consumerWaiters];
      this.#consumerWaiters = [];
      for (const waiter of waiters) waiter({ done: true });
    }
    this.#wakeSpaceWaiters();
  }

  #wakeSpaceWaiters(): void {
    const ready = this.#buffer.length + this.#reserved < this.#capacity
      || this.#closed;
    if (!ready) return;
    const waiters = [...this.#spaceWaiters];
    this.#spaceWaiters = [];
    for (const waiter of waiters) waiter();
  }
}
