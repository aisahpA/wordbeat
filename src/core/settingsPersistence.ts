import { Notice, Plugin } from "obsidian";

import { PluginData, Settings, normalizeSettings } from "@/defs/types";
import { t } from "@/ui/i18n";
import { useStore } from "./store";

/**
 * data.json (settings) persistence — the config channel, separate from
 * the stats data file (statsPersistence.ts).
 *
 * Only the subscription in setupSettingsPersistence ever writes data.json;
 * typing / data mutations never reach it. saveData is a non-atomic
 * truncate-rewrite, so typing-driven writes could leave the file truncated
 * when the process is killed (mobile pagehide). A missing or unparseable
 * file reads back as null; corrupt bytes stay on disk until a real
 * settings write or a sync push overwrites them.
 */

const SETTINGS_SCHEMA = "1.0";
const SETTINGS_DEBOUNCE_TIME = 2000;

// ─── Read data.json ───

/**
 * Read data.json via loadData() and unwrap `settings`. Null when the file
 * is missing or unparseable (loadData returns null either way), or when
 * the parsed JSON isn't our envelope — only a plain-object settings
 * payload is accepted, so garbage keys can't reach normalizeSettings,
 * which backfills field defaults at the call sites.
 */
export async function readSettings(
	plugin: Plugin,
): Promise<Partial<Settings> | null> {
	const data = (await plugin.loadData()) as PluginData | null;
	const settings = data?.settings;
	return settings && typeof settings === "object" && !Array.isArray(settings)
		? settings
		: null;
}

// ─── Write data.json ───

/** Persist current settings. Reached only via the settings-slice
 *  subscription (dirty gate + debounce), so every call is a real change;
 *  typing never writes data.json. */
export async function saveSettingsToDisk(plugin: Plugin): Promise<void> {
	try {
		await plugin.saveData({
			schema: SETTINGS_SCHEMA,
			settings: useStore.getState().settings,
		} satisfies PluginData);
	} catch (err) {
		console.error("WordBeat: can't write data.json:", err);
		new Notice(t("persistence.writeFailed"));
	}
}

// ─── External push (Obsidian sync) ───

/**
 * Apply a data.json push (onExternalSettingsChange): normalized incoming
 * settings wholesale replace local ones; null / unchanged is a no-op.
 * The settings-slice subscriber then schedules the save — never
 * requestPersist (that channel is stats-only).
 */
export async function mergeIncomingSettings(
	incoming: Partial<Settings> | null,
): Promise<void> {
	if (!incoming) return;
	const cur = useStore.getState();
	const newSettings = normalizeSettings(incoming);
	if (JSON.stringify(newSettings) === JSON.stringify(cur.settings)) return;
	useStore.setState({ settings: newSettings });
}

// ─── Scheduling ───

export interface SettingsScheduler {
	dispose: () => void;
	/** Flush a pending settings save immediately; no-op when settings are
	 *  clean, so lifecycle flushes (pagehide / unload) never rewrite
	 *  data.json in typing-only sessions. */
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
 * Subscribe to the settings slice AFTER boot hydration so the initial
 * hydrate schedules nothing. The dirty flag is set only by post-boot
 * settings changes, making an unchanged-settings flush a true no-op.
 */
export function setupSettingsPersistence(
	plugin: Plugin,
): SettingsScheduler {
	let dirty = false;
	const save = debouncedSave(async () => {
		if (!dirty) return;
		dirty = false;
		await saveSettingsToDisk(plugin);
	}, SETTINGS_DEBOUNCE_TIME);

	const unsubscribe = useStore.subscribe(
		(s) => s.settings,
		() => {
			dirty = true;
			save.schedule();
		},
	);

	return {
		flushNow: () => save.run(),
		dispose: () => {
			unsubscribe();
			save.cancel();
		},
	};
}
