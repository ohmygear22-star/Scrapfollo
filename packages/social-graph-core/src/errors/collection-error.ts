import type {
  PublicCollectionError,
  PublicCollectionErrorCategory,
} from "../contracts/errors.js";
import type { Platform } from "../contracts/provider.js";

export type CollectionErrorOptions = {
  category: PublicCollectionErrorCategory;
  message: string;
  retryable: boolean;
  platform?: Platform;
  targetId?: string;
  cause?: unknown;
};

export class CollectionError extends Error {
  readonly category: PublicCollectionErrorCategory;
  readonly retryable: boolean;
  readonly platform?: Platform;
  readonly targetId?: string;
  override readonly cause?: unknown;

  constructor(options: CollectionErrorOptions) {
    super(options.message);
    this.name = "CollectionError";
    this.category = options.category;
    this.retryable = options.retryable;
    if (options.platform !== undefined) this.platform = options.platform;
    if (options.targetId !== undefined) this.targetId = options.targetId;
    if (options.cause !== undefined) this.cause = options.cause;
  }

  toPublicError(): PublicCollectionError {
    return {
      category: this.category,
      message: this.message,
      retryable: this.retryable,
      ...(this.platform === undefined ? {} : { platform: this.platform }),
      ...(this.targetId === undefined ? {} : { targetId: this.targetId }),
    };
  }
}
