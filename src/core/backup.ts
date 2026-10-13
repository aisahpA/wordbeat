import { Notice, App, Plugin } from "obsidian";
import { PluginData, Settings, StatsFileData } from "@/defs/types";
import { formatDate } from "@/utils/dateUtils";
import { writeFileAtomic } from "@/utils/utils";
import { getStatsFilePath, readStatsFile } from "./dataPersistence";

const DEFAULT_BACKUP_DAYS = 7;
const DEFAULT_BACKUP_FOLDER = ".keep-the-rhythm2";
const BACKUP_DATE_RE = /^backup-(\d{4}-\d{2}-\d{2})(?:-[\w\d.]+)?\.json$/;

function getBackupFolder(settings?: Settings): string {
	return settings?.backupConfig?.folderPath || DEFAULT_BACKUP_FOLDER;
}

/**
 * Snapshot the raw on-disk stats data file into the backup folder — once
 * per day.  If today's backup already exists it is left untouched, so the
 * retained copy is always the state captured at the FIRST open of the
 * day, i.e. taken before any in-session reset could overwrite it.  The
 * file is read raw (no parse), so even an unparseable stats file lands in
 * the backup — but a structurally wiped one (valid JSON, no `days`,
 * i.e. a transient sync state) is skipped so it can't waste today's backup
 * slot.  Settings (data.json) are not snapshotted — Obsidian manages that
 * file and backup copies of it go stale.
 */
export async function snapshotRawDataFile(
	plugin: Plugin,
	app: App,
	settings: Settings,
): Promise<void> {
	const config = settings.backupConfig;
	if (!config.enabled) return;

	const folderPath = getBackupFolder(settings);
	const fileName = `backup-${formatDate(new Date())}.json`;
	const backupPath = `${folderPath}/${fileName}`;
	const dataPath = getStatsFilePath(plugin, settings);

	try {
		if (await app.vault.adapter.exists(backupPath)) return;
		if (!(await app.vault.adapter.exists(dataPath))) return;

		const raw = await app.vault.adapter.read(dataPath);
		try {
			const parsed = JSON.parse(raw) as StatsFileData;
			if (parsed?.stats?.days == null) return;
		} catch {
			// Unparseable — back up the raw bytes so nothing is lost.
		}

		if (!(await app.vault.adapter.exists(folderPath))) {
			await app.vault.adapter.mkdir(folderPath);
		}
		await writeFileAtomic(app.vault.adapter, backupPath, raw);
		new Notice("Ktr: New backup saved.");
	} catch (err) {
		console.error("KTR Error trying to create backup: ", err);
		new Notice("Ktr: Backup failed — see developer console for details.", 0);
	}

	await cleanOlderBackups(folderPath, config.maxNumberOfBackups ?? DEFAULT_BACKUP_DAYS, app);
}

/**
 * Load the stats data:
 *   - File present and valid → use it.
 *   - File present but structurally wiped / unparseable → transient sync
 *     state or corruption: fall back to the newest non-empty backup
 *     IMMEDIATELY (same invariant mergeExternalStats enforces at runtime).
 *   - File MISSING → do nothing.  It is either a genuine first run or a
 *     sync client that hasn't delivered the (custom-path) file yet; the
 *     runtime mtime poll in dataPersistence picks the real file up the
 *     moment it arrives, and restoring an old backup up front could be
 *     written back with a fresh mtime and look like newer-but-stale data
 *     to other devices.
 */
export async function loadStatsData(
	plugin: Plugin,
	settings: Settings,
): Promise<StatsFileData | null> {
	const statsPath = getStatsFilePath(plugin, settings);
	const filePresent = await plugin.app.vault.adapter.exists(statsPath);
	const statsData = await readStatsFile(plugin, settings);
	if (statsData?.stats?.days != null) return statsData;

	if (!filePresent) return null;

	const restored = await newestBackupStats(plugin.app, settings);
	if (!restored) return statsData;
	console.warn("KTR: stats file was empty — restored from backup");
	new Notice("Ktr: stats file was empty — restored from backup.", 0);
	return restored;
}

// ─── data.json (settings) resilience ───

function isPluginData(value: unknown): value is PluginData {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return false;
	}
	const settings = (value as PluginData).settings;
	return typeof settings === "object" && settings !== null;
}

/**
 * Read and validate data.json directly.  Obsidian's loadData() returns
 * null both for a missing file AND for a truncated one (a process killed
 * during its non-atomic saveData), so callers cannot otherwise tell a
 * first run apart from a corrupt file.  Returns null when the file is
 * missing, unparseable, or structurally invalid — a corrupt file is left
 * untouched on disk (the next settings write overwrites it, and a sync
 * client may redeliver a good copy first).
 */
export async function readValidDataJson(
	plugin: Plugin,
): Promise<PluginData | null> {
	const path = `${plugin.manifest.dir}/data.json`;
	try {
		if (!(await plugin.app.vault.adapter.exists(path))) return null;
		const parsed: unknown = JSON.parse(
			await plugin.app.vault.adapter.read(path),
		);
		return isPluginData(parsed) ? parsed : null;
	} catch (err) {
		console.warn("KTR: data.json is missing or unreadable:", err);
		return null;
	}
}

/** Newest backup whose stats carry activity rows, or null. */
async function newestBackupStats(
	app: App,
	settings: Settings,
): Promise<StatsFileData | null> {
	const folderPath = getBackupFolder(settings);
	try {
		if (!(await app.vault.adapter.exists(folderPath))) return null;
		const { files } = await app.vault.adapter.list(folderPath);
		// Newest first — ISO dates sort lexically (same rule as pruning).
		const candidates = files
			.map((f) => f.split("/").pop() ?? "")
			.filter((n) => BACKUP_DATE_RE.test(n))
			.sort()
			.reverse();

		for (const name of candidates) {
			try {
				const parsed = JSON.parse(
					await app.vault.adapter.read(`${folderPath}/${name}`),
				) as StatsFileData;
				if (parsed?.stats?.days && Object.keys(parsed.stats.days).length > 0) {
					return {
						schema: parsed.schema,
						stats: parsed.stats,
					};
				}
			} catch (err) {
				console.error(`KTR restore from ${name} failed:`, err);
			}
		}
	} catch (err) {
		console.error("KTR restore check failed:", err);
	}
	return null;
}

/**
 * Keep backups of the newest `maxDays` distinct dates, delete the rest.
 * Pruning is per-DAY, not per-file, so any number of same-day restarts can
 * never evict previous days' backups.  Dates are ISO strings, so a lexical
 * sort is chronological.
 */
async function cleanOlderBackups(
	folderPath: string,
	maxDays: number,
	app: App,
): Promise<void> {
	const { files } = await app.vault.adapter.list(folderPath);

	const dayByFile = new Map<string, string>();
	for (const fullPath of files) {
		const match = fullPath.split("/").pop()?.match(BACKUP_DATE_RE);
		if (match) dayByFile.set(fullPath, match[1]);
	}
	if (dayByFile.size === 0) return;

	const keepDays = new Set(
		[...new Set(dayByFile.values())].sort().reverse().slice(0, maxDays),
	);

	for (const [fullPath, day] of dayByFile) {
		if (!keepDays.has(day)) {
			await app.vault.adapter.remove(fullPath);
		}
	}
}
