import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "@social-graph/core": fileURLToPath(
        new URL("./packages/social-graph-core/src/index.ts", import.meta.url),
      ),
      "@social-graph/fake-provider": fileURLToPath(
        new URL("./providers/fake-provider/src/index.ts", import.meta.url),
      ),
      "@social-graph/instagram-session-provider": fileURLToPath(
        new URL("./providers/instagram-session/src/index.ts", import.meta.url),
      ),
    },
  },
});
