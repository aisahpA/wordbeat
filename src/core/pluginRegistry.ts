import type WordBeat from "@/main";

/**
 * Service-locator for the Obsidian plugin instance.
 *
 * `plugin` is NOT reactive state — it's set once in `onload()` and never
 * changes.  It therefore doesn't belong in the Zustand store (which would
 * cause spurious re-renders whenever any component subscribes to a slice
 * that happens to share the same shallow-equality boundary).
 *
 * Non-React modules (events.ts, queries.ts, utils.ts, …) call `getPlugin()`
 * to access `app`, `vault`, `workspace`, `data`, `saveData`, etc.
 */
let plugin: WordBeat | null = null;

export function setPlugin(p: WordBeat): void {
  plugin = p;
}

export function getPlugin(): WordBeat {
  if (!plugin) {
    throw new Error(
      "WordBeat plugin not initialized. Call setPlugin() in onload().",
    );
  }
  return plugin;
}
