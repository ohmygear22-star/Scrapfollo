import { apifyMain } from "./apify-binding.js";

apifyMain().catch((error: unknown) => {
  console.error("actor entry failed:", error instanceof Error ? error.name : error);
  process.exit(1);
});
