import type { NormalizedRelationship } from "@social-graph/core";

export class DatasetWriteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DatasetWriteError";
  }
}

export interface DatasetWriter {
  /** Writes one normalized row; resolves only once the row is durably stored. */
  write(row: NormalizedRelationship): Promise<void>;
}

export type LocalDatasetWriterOptions = {
  /** When provided, rows matching the predicate fail with DatasetWriteError. */
  failWhen?: (row: NormalizedRelationship) => boolean;
};

/**
 * In-memory DatasetWriter used by local FakeProvider runs and tests.
 * Stores only the normalized rows it is given — nothing else crosses this
 * boundary, so provider cursors and raw responses cannot leak.
 */
export class LocalDatasetWriter implements DatasetWriter {
  readonly #rows: NormalizedRelationship[] = [];
  readonly #failWhen?: (row: NormalizedRelationship) => boolean;

  constructor(options: LocalDatasetWriterOptions = {}) {
    if (options.failWhen !== undefined) this.#failWhen = options.failWhen;
  }

  get rows(): ReadonlyArray<NormalizedRelationship> {
    return this.#rows;
  }

  async write(row: NormalizedRelationship): Promise<void> {
    if (this.#failWhen?.(row) === true) {
      throw new DatasetWriteError(
        `Dataset write failed for target ${row.sourceUsername} row ${row.position}`,
      );
    }
    this.#rows.push(row);
  }
}
