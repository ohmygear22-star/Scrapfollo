export {
  DEFAULT_IG_APP_ID,
  DEFAULT_IG_BASE_URL,
  DEFAULT_IG_PAGE_SIZE_MAX,
  DEFAULT_IG_REQUEST_INTERVAL_MS,
  DEFAULT_IG_USER_AGENT,
  InstagramSessionConfigError,
  instagramSessionConfigFromEnv,
} from "./config.js";
export type { InstagramSessionConfig, InstagramSessionEnv } from "./config.js";
export { classifyInstagramFailure } from "./classify.js";
export { InstagramSessionTransport, InstagramTransportError } from "./transport.js";
export type { InstagramHttpRequest, InstagramHttpResponse, InstagramTransportOptions } from "./transport.js";
export { InstagramSessionProvider, InstagramSessionProviderError } from "./instagram-session-provider.js";
export type { InstagramSessionProviderOptions } from "./instagram-session-provider.js";
export type { InstagramFailureClassification } from "./classify.js";
