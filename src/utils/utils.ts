import { HeatmapColorModes, Unit } from "../defs/types";
import { CalculationType, TargetCount } from "../defs/types";
import { App, DataAdapter } from "obsidian";
import { TFile } from "obsidian";
import { MarkdownView } from "obsidian";
import { WorkspaceLeaf } from "obsidian";

/**
 * Write a file via a temp sibling + rename so the destination path only
 * ever appears as a COMPLETE file — a truncate-then-write lets a
 * file-watching sync client (e.g. Nutstore) observe or upload a
 * half-written file.  Falls back to a direct write if anything fails.
 */
export async function writeFileAtomic(
	adapter: DataAdapter,
	path: string,
	data: string,
): Promise<void> {
	const tmpPath = `${path}.tmp`;
	try {
		await adapter.write(tmpPath, data);
		await adapter.rename(tmpPath, path);
	} catch {
		try {
			await adapter.remove(tmpPath);
		} catch {
			// stale temp already gone
		}
		await adapter.write(path, data);
	}
}

export function getLeafWithFile(app: App, file: TFile): WorkspaceLeaf | null {
	let result: WorkspaceLeaf | null = null;

	app.workspace.iterateAllLeaves((leaf: WorkspaceLeaf) => {
		const view = leaf.view;

		if (view instanceof MarkdownView) {
			const currentFile = view.file;
			if (currentFile && currentFile.path === file.path) {
				result = leaf;
			}
		}
	});

	return result;
}

export const getFileName = (path: string): string => {
	return path.split("/").pop() || path;
};

export const getFileNameWithoutExtension = (path: string): string => {
	const fileName = getFileName(path);
	return fileName.replace(/\.[^/.]+$/, "");
};

export function isValidTargetCount(value: string): value is TargetCount {
	return Object.values(TargetCount).includes(value as TargetCount);
}

export function isValidCalculationType(
	value: string,
): value is CalculationType {
	return Object.values(CalculationType).includes(value as CalculationType);
}

export function isValidUnit(value: string): value is Unit {
	return Object.values(Unit).includes(value as Unit);
}

export function isValidColoringMode(value: string): value is HeatmapColorModes {
	return Object.values(HeatmapColorModes).includes(
		value as HeatmapColorModes,
	);
}

