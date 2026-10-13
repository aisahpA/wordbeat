import { Notice, Plugin } from "obsidian";

import { Settings, StatsFileData } from "@/defs/types";
import { writeFileAtomic } from "@/utils/utils";
import { useStore } from "./store";
import { encodePersistedStats } from "./statsCodec";
import { mergeExternalStats } from "./statsSync";
import { t } from "@/ui/i18n";

const STATS_SCHEMA = "1.0";
const STATS_DEBOUNCE_TIME = 2000;

// ─── Stats data file paths ───

/** Default stats file location: next to data.json in the plugin folder. */
export function defaultStatsFilePath(plugin: Plugin): string {
	return `${plugin.manifest.dir}/stats.json`;
}

/**
 * Effective stats file path: the configured vault-relative path or the
 * default. `settings` can be passed explicitly on the boot path, where
 * the store is not hydrated yet.
 */
export function getStatsFilePath(plugin: Plugin, settings?: Settings): string {
	const statsFileName = (
		settings ?? useStore.getState().settings
	).statsFileName;
	return statsFileName || defaultStatsFilePath(plugin);
}

/** Create every missing folder segment of a vault-relative file path. */
export async function ensureParentFolder(
	plugin: Plugin,
	filePath: string,
): Promise<void> {
	const adapter = plugin.app.vault.adapter;
	const segments = filePath.split("/");
	segments.pop(); // file name
	let folder = "";
	for (const segment of segments) {
		folder = folder ? `${folder}/${segment}` : segment;
		if (!(await adapter.exists(folder))) {
			await adapter.mkdir(folder);
		}
	}
}

// Cached mtime of the stats file — the external-change sentinel. 0 means
// "unknown" (forces one merge check on the next write; merging freshly
// loaded data is a no-op via the isNoop fast path).
let lastStatsMtime = 0;

async function statsFileMtime(
	plugin: Plugin,
	path?: string,
): Promise<number> {
	try {
		const st = await plugin.app.vault.adapter.stat(
			path ?? getStatsFilePath(plugin),
		);
		return st?.mtime ?? 0;
	} catch {
		return 0;
	}
}

/** Re-cache the stats file mtime after WE wrote it, so the next external
 *  check doesn't mistake our own write for someone else's. */
export async function cacheStatsFileMtime(
	plugin: Plugin,
	path?: string,
): Promise<void> {
	lastStatsMtime = await statsFileMtime(plugin, path);
}

// ─── Read / write the stats data file ───

/**
 * Read and parse the stats data file. Returns null when the file is
 * missing or unreadable (the boot guard handles recovery from backups).
 */
export async function readStatsFile(
	plugin: Plugin,
	settings?: Settings,
): Promise<StatsFileData | null> {
	const path = getStatsFilePath(plugin, settings);
	try {
		if (!(await plugin.app.vault.adapter.exists(path))) return null;
		const parsed = JSON.parse(
			await plugin.app.vault.adapter.read(path),
		) as StatsFileData;
		lastStatsMtime = await statsFileMtime(plugin, path);
		return parsed;
	} catch (err) {
		console.error("KTR: can't read stats data file:", err);
		return null;
	}
}

export async function saveStatsToDisk(plugin: Plugin): Promise<void> {
	// A sync client may have replaced the file since our last write; merge
	// it first so this whole-file write can't clobber its rows.
	await checkExternalStatsFile(plugin);
	const data = prepareStatsData();
	const path = getStatsFilePath(plugin);
	try {
		// Atomic replace (temp file + rename): a sync client watching the
		// vault must never observe a half-written, unparseable stats file.
		await writeFileAtomic(plugin.app.vault.adapter, path, JSON.stringify(data));
	} catch (err) {
		console.error("KTR: can't write stats data file:", err);
		new Notice(t("persistence.writeFailed"));
		return;
	}
	lastStatsMtime = await statsFileMtime(plugin, path);
}

/**
 * Pick up an externally replaced stats file (multi-device sync). A stat()
 * whose mtime differs from the cached value means the file changed behind
 * our back: read it and row-merge it into the store. No-op otherwise.
 *
 * A file OLDER than the newest state we have seen is a rolled-back delivery
 * (a sync client replaying / restoring an earlier version — e.g. Nutstore's
 * delete-then-re-add), not newer progress from another device: its rows
 * still merge max-wins, but its MISSING rows must not delete local ones.
 * Genuine deletions from another device always carry a newer mtime, and
 * genuine file deletions reach every device as vault delete events anyway
 * (see events.handleFileDelete).
 */
export async function checkExternalStatsFile(plugin: Plugin): Promise<void> {
	const path = getStatsFilePath(plugin);
	let mtime: number;
	try {
		const st = await plugin.app.vault.adapter.stat(path);
		if (!st) return; // file missing — nothing to merge, keep local data
		mtime = st.mtime;
	} catch {
		return; // unreadable — keep what we have
	}
	if (mtime === lastStatsMtime) return;
	const allowDeletions = mtime > lastStatsMtime;
	lastStatsMtime = mtime;
	const data = await readStatsFile(plugin);
	if (data) await mergeExternalStats(data.stats, { allowDeletions });
}

// ─── Persisted payload assembly ───

export function prepareStatsData(): StatsFileData {
	const {
		today,
		days,
		todayBaselines,
		todayBaselinesDay,
		historicalVersion,
	} = useStore.getState();

	return {
		schema: STATS_SCHEMA,
		stats: encodePersistedStats({
			today,
			days,
			todayBaselines,
			todayBaselinesDay,
			historicalVersion,
		}),
	};
}

// ─── Stats file location switch ───

/**
 * Structural check that a parsed JSON value is a stats data file (the shape
 * `prepareStatsData` writes): a plain object whose `stats` is a plain object.
 * A valid-but-empty stats object passes; anything else at the target path is
 * some unrelated JSON file, so the switch must refuse rather than overwrite it.
 */
function isStatsFileData(value: unknown): value is StatsFileData {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return false;
	}
	const stats = (value as { stats?: unknown }).stats;
	return typeof stats === "object" && stats !== null && !Array.isArray(stats);
}

/**
 * Move the stats data file to `newPath` (vault-relative, including the
 * file name); an empty path resets to the default location next to
 * data.json.  The store is the source of truth, so the switch writes the
 * current in-memory data to the target and removes the old file; if the
 * target already exists it is parsed and row-merged into the store first
 * (same max-wins rule as external sync), so nothing is lost either way.
 * An unreadable OR wrong-format target still blocks the switch.
 * @returns true on success (including "already using newPath").
 */
export async function switchStatsFile(
	plugin: Plugin,
	newPath: string,
): Promise<boolean> {
	const targetPath = newPath.trim();
	const target =
		targetPath === "" ? defaultStatsFilePath(plugin) : targetPath;
	if (
		!target.endsWith(".json") ||
		target.startsWith("/") ||
		target.includes("\\") ||
		/^[a-zA-Z]:/.test(target) ||
		target.split("/").includes("..")
	) {
		new Notice(t("persistence.invalidPath"));
		return false;
	}

	const currentPath = getStatsFilePath(plugin);
	if (target === currentPath) return true;

	try {
		const adapter = plugin.app.vault.adapter;
		if (await adapter.exists(target)) {
			let parsed: unknown;
			try {
				parsed = JSON.parse(await adapter.read(target));
			} catch (err) {
				console.error("KTR: can't adopt existing data file:", err);
				new Notice(t("persistence.unreadableTarget"));
				return false;
			}
			if (!isStatsFileData(parsed)) {
				new Notice(t("persistence.wrongFormat"));
				return false;
			}
			await mergeExternalStats(parsed.stats);
		}

		await ensureParentFolder(plugin, target);
		await writeFileAtomic(adapter, target, JSON.stringify(prepareStatsData()));
		if (await adapter.exists(currentPath)) {
			await adapter.remove(currentPath);
		}
		lastStatsMtime = await statsFileMtime(plugin, target);
	} catch (err) {
		console.error("KTR: can't switch data file location:", err);
		new Notice(t("persistence.switchFailed"));
		return false;
	}

	// Persist the new location (settings live in data.json). The success
	// notice is surfaced by the caller (the settings modal) in the user's
	// language.
	useStore.getState().mutateSettings((draft) => {
		draft.statsFileName = targetPath;
	});
	return true;
}

// ─── Persistence scheduling ───

/**
 * Holds the debounce state for the stats-file save channel.
 */
export interface StatsScheduler {
	dispose: () => void;
	/**
	 * Cancel any pending debounced save and write pending stats to disk
	 * immediately.  Used by visibilitychange / pagehide handlers because
	 * requestAnimationFrame is paused in background tabs — without an
	 * explicit flush, a user who types and then switches apps can lose
	 * their last few edits to an OS kill or hard reload.
	 */
	flushNow: () => Promise<void>;
}

/** A self-cancelling debounce: schedule() restarts the timer, run()
 *  flushes immediately. clearTimeout on reschedule makes a generation
 *  counter unnecessary. */
function debouncedSave(save: () => Promise<void>, delayMs: number) {
	let timer: number | null = null;
	return {
		schedule: () => {
			if (timer !== null) window.clearTimeout(timer);
			timer = window.setTimeout(() => {
				timer = null;
				void save();
			}, delayMs);
		},
		run: async () => {
			if (timer !== null) window.clearTimeout(timer);
			timer = null;
			await save();
		},
		cancel: () => {
			if (timer !== null) window.clearTimeout(timer);
			timer = null;
		},
	};
}

/**
 * The stats save channel (subscribed AFTER boot hydration, so the initial
 * hydrate schedules nothing): persistVersion bumps — typing / data
 * mutations — schedule a debounced write of the stats file ONLY.
 *
 * Settings live in a separate channel (settingsPersistence.ts →
 * data.json).  Keystrokes never rewrite data.json: Obsidian's saveData is
 * a non-atomic truncate-rewrite, and the old "save both on every typing
 * burst" design could leave it truncated when the process was killed.
 */
export function setupStatsPersistence(plugin: Plugin): StatsScheduler {
	const statsSave = debouncedSave(
		() => saveStatsToDisk(plugin),
		STATS_DEBOUNCE_TIME,
	);

	const unsubscribe = useStore.subscribe(
		(s) => s.persistVersion,
		statsSave.schedule,
	);

	return {
		flushNow: () => statsSave.run(),
		dispose: () => {
			unsubscribe();
			statsSave.cancel();
		},
	};
}
