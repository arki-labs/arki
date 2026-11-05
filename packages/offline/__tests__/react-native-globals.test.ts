// React Native sets `window = global` and `navigator = { product: 'ReactNative' }`, with no
// `addEventListener`, no `onLine` and no IndexedDB (react-native 0.86, Libraries/Core/setUpGlobals.js
// and setUpNavigator.js). ./mutations and ./status are web-only, but code that took `window` for a
// browser crashed there: ./status threw on import and the queue threw when it started. An accidental
// import must instead get the queue's typed storage failure, and ./collections must work.
import { afterAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { oc } from "@orpc/contract";
import { OPERATION, operations } from "@arki/contracts/orpc";

import { offlineSafe } from "../src/orpc/offline-safe-marker.ts";

vi.stubGlobal("window", globalThis);
vi.stubGlobal("navigator", { product: "ReactNative" });
afterAll(() => {
  vi.unstubAllGlobals();
});

const { createOfflineMutationQueue } =
  await import("../src/mutations/queue.ts");
const { createLocalCollection } =
  await import("../src/collections/createLocalCollection.ts");

const contract = {
  posts: { create: offlineSafe(oc.input(z.object({ title: z.string() }))) },
};
const createPost = { [OPERATION]: operations(contract).posts.create };

describe("with React Native globals", () => {
  it("imports ./status without listening on a window that has no events", async () => {
    await expect(import("../src/status/index.ts")).resolves.toHaveProperty(
      "OfflineBanner",
    );
  });

  it("builds the queue, and enqueue answers with the typed storage failure, not a crash", async () => {
    const rpc = { call: vi.fn() };
    const queue = createOfflineMutationQueue({
      rpc,
      actorId: () => "usr_rn",
      storageKey: "q-rn",
      deadLetterStorageKey: "dl-rn",
    });
    const outcome = await queue.enqueue(createPost, { title: "hello" });
    queue.dispose();
    expect(outcome).toMatchObject({
      code: "offline.queue_storage_unavailable",
    });
    expect(rpc.call).not.toHaveBeenCalled();
  });

  it("gets a local collection ready with the default cross-tab sync", async () => {
    const notes = createLocalCollection({
      storageKey: "rn:notes",
      schema: z.object({ id: z.string() }),
      getKey: (item) => item.id,
    });
    await notes.stateWhenReady();
    await notes.insert({ id: "n1" }).isPersisted.promise;
    expect(notes.get("n1")).toMatchObject({ id: "n1" });
    await notes.cleanup();
  });
});
