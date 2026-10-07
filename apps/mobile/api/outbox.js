// CrewBus M5 mobile offline outbox over the shared runtime cache.
// Zero-dependency, plain ESM, no RN imports.
//
// Rules (from packages/client-runtime/cache.js, imported not reimplemented):
// - Drafts persist offline with a long TTL (survive airplane mode).
// - enqueueDraft() only stores; NOTHING executes at enqueue time.
// - retryOutbox()/retryOne() are the ONLY executors and are explicit shell
//   calls (button press / foreground refresh). This module never subscribes
//   to supervisor reconnects and never autoplays — a reconnect must NOT
//   flush the queue on its own.
// - Failures stay queued with attempts/lastError surfaced per item so the
//   screen can render "2 failed · tap to retry".

import { createCache } from "../../../packages/client-runtime/cache.js";

function needWorker(worker) {
  if (typeof worker !== "function") throw new TypeError("retry needs worker(op, info) -> truthy | { ok }");
  return worker;
}

export function createOutbox({ cache = null } = {}) {
  const store = cache || createCache();

  return {
    // Persist an offline-created draft + queue its send op for later.
    // { key, text, op }: key/text land in the draft map (offline-safe);
    // op (default { kind:"draft", key }) lands in the mutation queue.
    // Returns the queued entry { id, op, status, attempts, ... }.
    enqueueDraft({ key, text = "", op = null } = {}) {
      if ((key === undefined || key === null || String(key) === "") && op === null) {
        throw new TypeError("enqueueDraft needs { key, text } and/or { op }");
      }
      if (key !== undefined && key !== null && String(key) !== "") {
        store.setDraft(String(key), String(text ?? ""));
      }
      const entry = store.enqueue(
        op !== null && typeof op === "object" ? { ...op } : { kind: "draft", key: key === undefined ? null : String(key) }
      );
      return entry;
    },

    getDraft(key) {
      return store.getDraft(String(key));
    },

    hasDraft(key) {
      return store.hasDraft(String(key));
    },

    discardDraft(key) {
      return store.discardDraft(String(key));
    },

    // Queued items with per-item attempts/lastError (failed stays queued).
    pending() {
      return store.pending();
    },

    // Explicit retry of ONE item; failure keeps it queued with
    // attempts+1 and lastError set. Never triggers anything else.
    retryOne(id, worker) {
      return store.retry(id, needWorker(worker));
    },

    // Explicit retry of the WHOLE queue, in enqueue order. The only bulk
    // executor; call from a retry button, never from a reconnect handler.
    retryOutbox(worker) {
      return store.retryAll(needWorker(worker));
    },

    discard(id) {
      return store.discard(id);
    },

    clearQueue() {
      return store.clearQueue();
    },

    stats() {
      return store.stats();
    },
  };
}
