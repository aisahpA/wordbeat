import { Notice, Plugin } from "obsidian";

import { Settings, StatsFileData } from "@/defs/types";
import {
	clearStaging,
	recoverFileFromStaging,
	writeFileStaged,
} from "@/utils/atomicFile";
import { useStore } from "./store";
import { encodePersistedStats } from "./statsCodec";
import { mergeExternalStats } from "./statsSync";
import { t } from "@/ui/i18n";

const STATS_SCHEMA = "1.0";
const STATS_DEBOUNCE_TIME = 2000;

// ─── Stats data file paths ───

/** Default stats file location: next to data.json in the plugin folder. */
export function defaultStatsFilePath(plugin: Plugin): string {
	return `${plugin.manifest.dir}/wordbeat-data.json`;
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

// ─── Corrupted-file quarantine ───

/** `YYYYMMDD-HHmmss` local stamp — unique enough for sibling quarantine names. */
function quarantineStamp(): string {
	const d = new Date();
	const p = (n: number) => String(n).padStart(2, "0");
	return (
		`${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
		`-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
	);
}

/**
 * Move an unreadable stats file aside so the next write can't overwrite it
 * and the user can still recover the raw bytes by hand. The copy lives next
 * to the data file as `<name>.corrupt-<stamp>.json` (not in the backup
 * folder: automatic backups may be disabled — exactly the case where this
 * matters most).
 *
 * Moving (rename) is preferred: it also leaves a clean "missing file" state,
 * so repeated reads stop failing and no suppression flag is needed. Falls
 * back to copy + remove when the adapter refuses the rename.
 *
 * @returns the quarantine path, or null when nothing could be preserved.
 */
async function quarantineStatsFile(
	plugin: Plugin,
	path: string,
): Promise<string | null> {
	const adapter = plugin.app.vault.adapter;
	const stem = path.endsWith(".json") ? path.slice(0, -5) : path;

	try {
		let dest = `${stem}.corrupt-${quarantineStamp()}.json`;
		let suffix = 2;
		while (await adapter.exists(dest)) {
			dest = `${stem}.corrupt-${quarantineStamp()}-${suffix++}.json`;
		}

		try {
			await adapter.rename(path, dest);
			return dest;
		} catch (err) {
			console.error("WordBeat: can't move corrupted stats file:", err);
		}

		const raw = await adapter.read(path);
		// Copy, don't swap: the preserved bytes cannot be staged (a staged write
		// would move the damaged live file aside first), and a failed write here
		// leaves the original in place for the next attempt.
		await adapter.write(dest, raw);
		await adapter.remove(path);
		return dest;
	} catch (err) {
		console.error("WordBeat: can't preserve corrupted stats file:", err);
		return null;
	}
}

// ─── Read / write the stats data file ───

/**
 * Read and parse the stats data file. Returns null when the file is
 * missing or unreadable (the boot guard handles recovery from backups).
 *
 * Two recovery steps come before/after the read:
 *  - a swap interrupted by a crash or a killed mobile process is finished by
 *    promoting the staged copy (see `recoverFileFromStaging`);
 *  - a damaged file is moved aside (see `quarantineStatsFile`) and the
 *    previous version kept by the staged swap is restored, so a corrupt write
 *    costs one save tick instead of the whole history.
 *
 * Neither path is silent: the damaged copy location is reported in a sticky,
 * click-to-dismiss notice — running on stale in-memory data with no backups
 * enabled is exactly the situation where the raw file is the only thing left.
 */
export async function readStatsFile(
	plugin: Plugin,
	settings?: Settings,
): Promise<StatsFileData | null> {
	const path = getStatsFilePath(plugin, settings);
	const adapter = plugin.app.vault.adapter;
	await recoverFileFromStaging(adapter, path, { isValid: isStatsText });
	try {
		if (!(await adapter.exists(path))) return null;
		const parsed = JSON.parse(await adapter.read(path)) as StatsFileData;
		lastStatsMtime = await statsFileMtime(plugin, path);
		return parsed;
	} catch (err) {
		console.error("WordBeat: can't read stats data file:", err);
		// Preserve the damaged bytes BEFORE returning: the caller may start
		// with empty data and the next debounced write would overwrite them.
		// Moving the file also makes every later read a clean "missing file"
		// no-op, so this runs once per damaged file without any flag.
		const savedTo = await quarantineStatsFile(plugin, path);
		// The damaged file is out of the way, so the staged copy is free to
		// take its place: the previous complete version beats empty data.
		const restored = await recoverFileFromStaging(adapter, path, {
			isValid: isStatsText,
		});
		if (restored) {
			try {
				const parsed = JSON.parse(
					await adapter.read(path),
				) as StatsFileData;
				lastStatsMtime = await statsFileMtime(plugin, path);
				// 0 = the notice stays until the user closes it.
				new Notice(
					savedTo
						? t("persistence.restoredFromStaging", savedTo)
						: t("persistence.readFailedUnpreserved"),
					0,
				);
				return parsed;
			} catch (restoreErr) {
				console.error("WordBeat: can't read restored stats file:", restoreErr);
			}
		}
		new Notice(
			savedTo
				? t("persistence.readFailed", savedTo)
				: t("persistence.readFailedUnpreserved"),
			0,
		);
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
		// Staged replace with a previous-version slot: the live path only ever
		// points at a complete file, and the staging copies live in
		// `.trash/wordbeat` where a sync client won't carry a partial write
		// around (see utils/atomicFile.ts). validate guards the one case the
		// swap can't recover from: a payload the next read cannot decode.
		await writeFileStaged(
			plugin.app.vault.adapter,
			path,
			JSON.stringify(data),
			{ validate: validateStatsText },
		);
	} catch (err) {
		console.error("WordBeat: can't write stats data file:", err);
		new Notice(t("persistence.writeFailed"), 0);
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

/** True when `text` parses back as a well-formed stats data file. Used to
 *  sanity-check staged recovery copies before they take over the live path. */
function isStatsText(text: string): boolean {
	try {
		return isStatsFileData(JSON.parse(text));
	} catch {
		return false;
	}
}

/** Pre-write guard for `writeFileStaged`: never let a payload the next read
 *  would reject reach the live path (it would trigger quarantine + a
 *  previous-version restore on the very next boot). */
function validateStatsText(text: string): void {
	if (!isStatsText(text)) {
		throw new Error("WordBeat: refusing to write an unreadable stats payload");
	}
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
		// A staged copy left by an interrupted switch carries the same data as
		// the in-memory store, but promoting it first means the "already
		// exists?" branch below sees the real file instead of a stale slot.
		await recoverFileFromStaging(adapter, target, { isValid: isStatsText });
		if (await adapter.exists(target)) {
			let parsed: unknown;
			try {
				parsed = JSON.parse(await adapter.read(target));
			} catch (err) {
				console.error("WordBeat: can't adopt existing data file:", err);
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
		await writeFileStaged(adapter, target, JSON.stringify(prepareStatsData()), {
			validate: validateStatsText,
		});
		if (await adapter.exists(currentPath)) {
			await adapter.remove(currentPath);
		}
		// The old location's recovery slots would otherwise outlive it forever.
		await clearStaging(adapter, currentPath);
		lastStatsMtime = await statsFileMtime(plugin, target);
	} catch (err) {
		console.error("WordBeat: can't switch data file location:", err);
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
	 * immediately.  Used on plugin unload — a coalesced debounced save must
	 * land before the scheduler is disposed.  Deliberately NOT wired to
	 * pagehide / visibilitychange: that write would land on the OS freeze
	 * boundary, where a mobile process can be suspended mid-write (see
	 * main.ts registerLifecycleEvents).
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
