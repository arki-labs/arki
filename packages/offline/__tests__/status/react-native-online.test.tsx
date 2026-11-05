// @vitest-environment jsdom

// React Native's `navigator` is `{ product: 'ReactNative' }`: it has no `onLine`. Reading that
// `undefined` as "offline" made the banner say "offline" for ever, so a missing `onLine` counts as
// online. The stub comes before ./status is imported, because the online snapshot is read at module
// load. React DOM reads `navigator.userAgent` when it loads, so it is imported first.
import { createElement } from "react";
import { render, screen, cleanup } from "@testing-library/react";
import { afterAll, expect, it, vi } from "vitest";

import type { OfflineBannerState } from "../../src/status/OfflineBanner.tsx";

vi.stubGlobal("navigator", { product: "ReactNative" });
afterAll(() => {
  vi.unstubAllGlobals();
});

const { OfflineBanner } = await import("../../src/status/OfflineBanner.tsx");

it("counts a navigator without onLine as online", () => {
  render(
    createElement(OfflineBanner, {
      children: ({ online }: OfflineBannerState) => `online=${String(online)}`,
    }),
  );
  expect(screen.getByText("online=true")).toBeTruthy();
  cleanup();
});
