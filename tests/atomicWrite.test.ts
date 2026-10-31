import assert from "node:assert";

import type { DataAdapter } from "obsidian";
import {
	ATOMIC_STAGING_DIR,
	atomicStagePaths,
	clearStaging,
	recoverFileFromStaging,
	writeFileStaged,
	writeFileSwap,
} from "@/utils/atomicFile";

const PATH = "x/plugins-data/stats.json";
const { next, prev } = atomicStagePaths(PATH);

/**
 * In-memory adapter mirroring the behaviour measured on Obsidian:
 * `rename()` throws "Destination file already exists!" when the target is
 * present, `remove()` throws on a missing path, and `mkdir()` is not
 * recursive (the module creates each segment itself).
 */
function fakeAdapter(init: Record<string, string> = {}) {
	const files = new Map(Object.entries(init));
	const folders = new Set<string>();
	const log: string[] = [];
	let renameError: ((from: string, to: string) => string | null) | null = null;
	let removeError: ((p: string) => string | null) | null = null;
	let writeLatency = 0;

	const adapter = {
		exists: async (p: string) => files.has(p) || folders.has(p),
		read: async (p: string) => {
			const value = files.get(p);
			if (value === undefined) throw new Error(`ENOENT: ${p}`);
			return value;
		},
		write: async (p: string, data: string) => {
			if (writeLatency > 0) {
				await new Promise((resolve) => setTimeout(resolve, writeLatency));
			}
			log.push(`write ${p}`);
			files.set(p, data);
		},
		remove: async (p: string) => {
			const forced = removeError?.(p);
			if (forced) throw new Error(forced);
			if (!files.has(p)) throw new Error(`ENOENT: ${p}`);
			log.push(`remove ${p}`);
			files.delete(p);
		},
		rename: async (from: string, to: string) => {
			const forced = renameError?.(from, to);
			if (forced) throw new Error(forced);
			if (!files.has(from)) throw new Error(`ENOENT: ${from}`);
			if (files.has(to)) throw new Error("Destination file already exists!");
			log.push(`rename ${from} -> ${to}`);
			files.set(to, files.get(from)!);
			files.delete(from);
		},
		mkdir: async (p: string) => {
			log.push(`mkdir ${p}`);
			folders.add(p);
		},
	};

	return {
		adapter: adapter as unknown as DataAdapter,
		files,
		folders,
		log,
		renameWhen(fn: (from: string, to: string) => string | null) {
			renameError = fn;
		},
		failRemoveWhen(fn: (p: string) => string | null) {
			removeError = fn;
		},
		setWriteLatency(ms: number) {
			writeLatency = ms;
		},
	};
}

async function testFreshWrite() {
	const fake = fakeAdapter();
	await writeFileStaged(fake.adapter, PATH, "NEW");

	assert.equal(fake.files.get(PATH), "NEW");
	assert.equal(fake.files.has(next), false, "staged copy must be consumed");
	assert.equal(fake.files.has(prev), false, "nothing to keep on first write");
	assert.equal(fake.folders.has(ATOMIC_STAGING_DIR), true);
	assert.deepEqual(fake.log, [
		`mkdir .trash`,
		`mkdir ${ATOMIC_STAGING_DIR}`,
		`write ${next}`,
		`rename ${next} -> ${PATH}`,
	]);
	// The live folder is untouched: no temp/litter next to the data file.
	assert.equal([...fake.files.keys()].some((p) => p.endsWith(".tmp")), false);
}

async function testOverwriteKeepsPreviousVersion() {
	const fake = fakeAdapter({
		[PATH]: "OLD",
		[prev]: "STALE",
	});
	await writeFileStaged(fake.adapter, PATH, "NEW");

	assert.equal(fake.files.get(PATH), "NEW");
	assert.equal(fake.files.get(prev), "OLD", "previous version moves to .prev");
	assert.equal(fake.files.has(next), false);
	assert.deepEqual(fake.log.slice(-4), [
		`write ${next}`,
		`remove ${prev}`,
		`rename ${PATH} -> ${prev}`,
		`rename ${next} -> ${PATH}`,
	]);
}

async function testValidationRejectsBeforeTouchingAnything() {
	const fake = fakeAdapter({ [PATH]: "OLD" });
	let validated = "";
	await assert.rejects(
		writeFileStaged(fake.adapter, PATH, "GARBAGE", {
			validate: (data) => {
				validated = data;
				throw new Error("bad payload");
			},
		}),
		/bad payload/,
	);

	assert.equal(validated, "GARBAGE");
	assert.equal(fake.files.get(PATH), "OLD");
	assert.equal(fake.files.has(next), false, "no staged write happens");
	assert.deepEqual(fake.log, []);
}

async function testSwapFailureRestoresPreviousVersion() {
	const fake = fakeAdapter({ [PATH]: "OLD" });
	// Fail the second rename only: the one that would put the new payload live.
	fake.renameWhen((from) => (from === next ? "disk full" : null));

	await assert.rejects(writeFileStaged(fake.adapter, PATH, "NEW"), /disk full/);

	// The live path must never be left missing: .prev goes back.
	assert.equal(fake.files.get(PATH), "OLD");
	assert.equal(fake.files.get(next), "NEW", "newest payload is kept for retry");
	assert.equal(fake.files.has(prev), false);
}

async function testFailureMovingLiveFileLeavesItAlone() {
	const fake = fakeAdapter({ [PATH]: "OLD" });
	fake.renameWhen((from) => (from === PATH ? "cannot move" : null));

	await assert.rejects(
		writeFileStaged(fake.adapter, PATH, "NEW"),
		/cannot move/,
	);

	assert.equal(fake.files.get(PATH), "OLD");
	assert.equal(fake.files.get(next), "NEW");
	assert.equal(fake.files.has(prev), false);
}

async function testConcurrentWritesAreSerialised() {
	const fake = fakeAdapter();
	fake.setWriteLatency(5);

	const first = writeFileStaged(fake.adapter, PATH, "FIRST");
	const second = writeFileStaged(fake.adapter, PATH, "SECOND");
	await Promise.all([first, second]);

	assert.equal(fake.files.get(PATH), "SECOND");
	assert.equal(fake.files.get(prev), "FIRST", "no write lost its history");
	// Serialised: the first swap completes before the second staged write.
	const firstSwapDone = fake.log.indexOf(`rename ${next} -> ${PATH}`);
	const secondStaged = fake.log.lastIndexOf(`write ${next}`);
	assert.ok(
		firstSwapDone >= 0 && firstSwapDone < secondStaged,
		`interleaved writes: ${JSON.stringify(fake.log)}`,
	);
}

async function testRecoverPromotesNewestStagedCopy() {
	const fake = fakeAdapter({ [next]: "NEWEST", [prev]: "OLDER" });
	const restored = await recoverFileFromStaging(fake.adapter, PATH);
	assert.equal(restored, "next");
	assert.equal(fake.files.get(PATH), "NEWEST");
}

async function testRecoverSkipsUnreadableStagedCopy() {
	const fake = fakeAdapter({ [next]: "not json", [prev]: '{"stats":{}}' });
	const restored = await recoverFileFromStaging(fake.adapter, PATH, {
		isValid: (data) => {
			try {
				JSON.parse(data);
				return true;
			} catch {
				return false;
			}
		},
	});
	assert.equal(restored, "prev");
	assert.equal(fake.files.get(PATH), '{"stats":{}}');
	assert.equal(fake.files.has(next), true, "unreadable copy is left for inspection");
}

async function testRecoverIsNoOpWhenLiveExists() {
	const fake = fakeAdapter({ [PATH]: "LIVE", [next]: "NEWEST" });
	const restored = await recoverFileFromStaging(fake.adapter, PATH);
	assert.equal(restored, null);
	assert.equal(fake.files.get(PATH), "LIVE");
	assert.equal(fake.files.get(next), "NEWEST");
}

async function testRecoverIsNoOpWithoutStaging() {
	const fake = fakeAdapter();
	assert.equal(await recoverFileFromStaging(fake.adapter, PATH), null);
	assert.deepEqual(fake.log, []);
}

async function testClearStagingRemovesBothSlots() {
	const fake = fakeAdapter({ [PATH]: "LIVE", [next]: "N", [prev]: "P" });
	await clearStaging(fake.adapter, PATH);
	assert.equal(fake.files.get(PATH), "LIVE");
	assert.equal(fake.files.has(next), false);
	assert.equal(fake.files.has(prev), false);
}

async function testSwapWritesForUniqueSnapshots() {
	const fake = fakeAdapter();
	await writeFileSwap(fake.adapter, "backup.json", "SNAP");
	assert.equal(fake.files.get("backup.json"), "SNAP");
	assert.deepEqual(fake.log, [
		"write backup.json.tmp",
		"rename backup.json.tmp -> backup.json",
	]);
}

async function testSwapCleansTempWhenRemoveFails() {
	const fake = fakeAdapter({ "backup.json": "OLD" });
	fake.failRemoveWhen((p) => (p === "backup.json" ? "remove denied" : null));
	await assert.rejects(writeFileSwap(fake.adapter, "backup.json", "SNAP"));
	// Old snapshot intact, temp file cleaned up (the old copy is the only one).
	assert.equal(fake.files.get("backup.json"), "OLD");
	assert.equal(fake.files.has("backup.json.tmp"), false);
}

async function main() {
	await testFreshWrite();
	await testOverwriteKeepsPreviousVersion();
	await testValidationRejectsBeforeTouchingAnything();
	await testSwapFailureRestoresPreviousVersion();
	await testFailureMovingLiveFileLeavesItAlone();
	await testConcurrentWritesAreSerialised();
	await testRecoverPromotesNewestStagedCopy();
	await testRecoverSkipsUnreadableStagedCopy();
	await testRecoverIsNoOpWhenLiveExists();
	await testRecoverIsNoOpWithoutStaging();
	await testClearStagingRemovesBothSlots();
	await testSwapWritesForUniqueSnapshots();
	await testSwapCleansTempWhenRemoveFails();

	console.log("atomicWrite tests passed");
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
