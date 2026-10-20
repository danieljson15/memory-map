import { afterEach } from "vitest";

// Only DOM environments need Testing Library; guard so node-environment
// tests don't import it.
if (typeof document !== "undefined") {
  await import("@testing-library/jest-dom/vitest");
  const { cleanup } = await import("@testing-library/react");
  afterEach(() => cleanup());
}
