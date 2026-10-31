import { DataAdapter } from "obsidian";

/**
 * Crash-safe writes with a one-version history (design borrowed from
 * position-restore's db writes).
 *
 * Why not "temp file next to the live file + rename":
 *  - `adapter.rename` REFUSES to overwrite an existing destination (measured
 *    on Obsidian: it throws "Destination file already exists!"), so the swap
 *    needs the old file moved out of the way first;
 *  - a temp sibling (`.tmp`) sits in the user's folder, where a sync client
 *    can pick it up and where it survives a crash as litter.
 *
 * So the payload is staged OUTSIDE the visible folder, in `.trash/wordbeat/`
 * (Obsidian Sync does not sync hidden folders, and Nutstore's default
 * filterRules exclude the `.trash` folder), and the live path is only ever
 * swapped through complete files:
 *
 *   1. write `.next` in staging        (a crash here leaves the live file alone)
 *   2. rename live → `.prev`           (previous version kept for recovery)
 *   3. rename `.next` → live           (crash between 2 and 3: see below)
 *
 * If the process dies between steps 2 and 3 the live path is missing while
 * `.next` holds the newest payload — `recoverFileFromStaging` promotes it on
 * the next read. When the live file itself is unreadable, `.prev` (the
 * previous complete version) is the fallback: `recoverFileFromStaging` also
 * promotes it once the damaged file has been moved aside.
 *
 * Staging names are derived from the data path (slashes → "__") so two files
 * can never share a slot and no metadata file is needed to find them.
 */
export const ATOMIC_STAGING_DIR = ".trash/wordbeat";

export interface AtomicStagePaths {
	/** Newest payload, written before the swap. */
	next: string;
	/** The version the live file had before the last successful swap. */
	prev: string;
}

/** Deterministic staging slot names for a vault-relative data path. */
export function atomicStagePaths(path: string): AtomicStagePaths {
	const flat = path.replace(/\//g, "__");
	return {
		next: `${ATOMIC_STAGING_DIR}/${flat}.next`,
		prev: `${ATOMIC_STAGING_DIR}/${flat}.prev`,
	};
}

/** Create the staging folder (and `.trash` above it) if missing. */
async function ensureStagingDir(adapter: DataAdapter): Promise<void> {
	let folder = "";
	for (const segment of ATOMIC_STAGING_DIR.split("/")) {
		folder = folder ? `${folder}/${segment}` : segment;
		if (!(await adapter.exists(folder))) {
			// A failure here aborts the whole write on purpose: falling back to
			// a write next to the live file would reintroduce the partial-file
			// window this module exists to remove.
			await adapter.mkdir(folder);
		}
	}
}

/**
 * Writes to the same data path are serialised: two overlapping staged swaps
 * would interleave (both moving the live file to `.prev`, one renaming a
 * `.next` that the other already consumed) and could lose the live file.
 */
const writeChains = new Map<string, Promise<unknown>>();

function enqueue<T>(path: string, run: () => Promise<T>): Promise<T> {
	const previous = writeChains.get(path) ?? Promise.resolve();
	// Run regardless of whether the previous write failed.
	const current = previous.then(run, run);
	writeChains.set(
		path,
		current.catch(() => undefined),
	);
	return current;
}

export interface StagedWriteOptions {
	/**
	 * Rejects a payload BEFORE it can reach the live path (e.g. parse it back
	 * and check the schema). Cheap insurance against writing a payload the
	 * next read cannot decode.
	 */
	validate?: (data: string) => void;
}

/**
 * Replace `path` with `data`, keeping the previous version in `.prev`.
 *
 * Throws when the swap fails: the caller keeps the data in memory and retries
 * on its next save tick — there is deliberately no direct-write fallback,
 * because truncating the live file is the exact failure this prevents.
 */
export async function writeFileStaged(
	adapter: DataAdapter,
	path: string,
	data: string,
	options: StagedWriteOptions = {},
): Promise<void> {
	const { next, prev } = atomicStagePaths(path);

	return enqueue(path, async () => {
		options.validate?.(data);
		await ensureStagingDir(adapter);
		await adapter.write(next, data);

		// From here on every step targets a path that does not exist yet, so
		// each rename succeeds on both desktop and mobile Obsidian.
		let liveMoved = false;
		try {
			if (await adapter.exists(path)) {
				if (await adapter.exists(prev)) await adapter.remove(prev);
				await adapter.rename(path, prev);
				liveMoved = true;
			}
			await adapter.rename(next, path);
		} catch (err) {
			// Put the previous COMPLETE version back so the live path never
			// stays missing after a failed swap. `.next` is kept: it is the only
			// copy of the newest payload and the next write overwrites it anyway.
			if (liveMoved) {
				try {
					if (!(await adapter.exists(path))) {
						await adapter.rename(prev, path);
					}
				} catch {
					// Both the live file and the staged copy are gone if this also
					// fails; the caller keeps the payload in memory and retries.
				}
			}
			throw err;
		}
	});
}

/** Replace `path` through a single sibling swap, without history.
 *  For rotating, never-overwritten targets (backup snapshots). */
export async function writeFileSwap(
	adapter: DataAdapter,
	path: string,
	data: string,
): Promise<void> {
	const tmpPath = `${path}.tmp`;
	await adapter.write(tmpPath, data);
	try {
		if (await adapter.exists(path)) await adapter.remove(path);
		await adapter.rename(tmpPath, path);
	} catch (err) {
		// The rename did not happen: either the old file is still intact
		// (delete failed) or it is gone while the temp file holds the only copy.
		try {
			if (await adapter.exists(path)) await adapter.remove(tmpPath);
		} catch {
			// leave the temp file behind; the next write overwrites it
		}
		throw err;
	}
}

export interface StagedRecoveryOptions {
	/** Returns true when a staged payload is a complete, readable version. */
	isValid?: (data: string) => boolean;
}

/**
 * Finish an interrupted swap: when the live file is missing, promote the
 * staged `.next` (newest) or `.prev` (last complete version) back to it.
 *
 * Callers that found the live file unreadable must move it aside first
 * (`quarantineStatsFile`), then call this: a promotion renames onto a path
 * that must be free.
 *
 * @returns which slot was promoted, or null when nothing needed doing.
 */
export async function recoverFileFromStaging(
	adapter: DataAdapter,
	path: string,
	options: StagedRecoveryOptions = {},
): Promise<"next" | "prev" | null> {
	const { next, prev } = atomicStagePaths(path);
	const isValid = options.isValid ?? (() => true);

	return enqueue(path, async () => {
		if (await adapter.exists(path)) return null;
		for (const source of ["next", "prev"] as const) {
			const staged = source === "next" ? next : prev;
			if (!(await adapter.exists(staged))) continue;
			try {
				if (!isValid(await adapter.read(staged))) continue;
				await adapter.rename(staged, path);
				return source;
			} catch (err) {
				console.error(`WordBeat: can't restore staged file ${staged}:`, err);
			}
		}
		return null;
	});
}

/** Drop both staged slots for a data path (used when the data file moves
 *  elsewhere, so its old recovery copies can't linger forever). */
export async function clearStaging(
	adapter: DataAdapter,
	path: string,
): Promise<void> {
	const { next, prev } = atomicStagePaths(path);
	for (const staged of [next, prev]) {
		try {
			if (await adapter.exists(staged)) await adapter.remove(staged);
		} catch (err) {
			console.error(`WordBeat: can't clear staged file ${staged}:`, err);
		}
	}
}
