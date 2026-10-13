import { Plugin, TFile, TAbstractFile } from "obsidian";

import { setPlugin } from "@/core/pluginRegistry";
import { useStore } from "@/core/store";
import { PluginView, VIEW_TYPE } from "@/ui/views/PluginView";
import { SettingsTab } from "@/ui/settings/SettingsTab";
import { applyHeatmapColorStyles } from "@/ui/styles/applyColorStyles";
import { TodayWordsStatusBar } from "@/ui/statusBar";

import * as events from "@/core/events";
import * as codeBlocks from "@/core/codeBlocks";
import { activateSidebarView, insertCustomCodeBlock } from "@/core/commands";
import { CUSTOM_CODE_BLOCK_COMMANDS } from "@/core/codeBlockTemplates";
import {
	snapshotRawDataFile,
	loadStatsData,
	readValidDataJson,
} from "@/core/backup";
import {
	setupPersistenceScheduling,
	PersistenceScheduler,
	checkExternalStatsFile,
} from "@/core/dataPersistence";
import { mergeExternalSettings } from "@/core/externalSync";
import { normalizeSettings } from "@/defs/types";
import { resetDailySummaryCache } from "@/utils/dailySummaryCache";
import { resetStatsCodecCache } from "@/core/statsCodec";
import { resetDataQueryCaches } from "@/core/dataQueries";
import { resetFolderCache } from "@/core/pathFilter";

export default class KeepTheRhythm extends Plugin {
	
	// Persistence scheduler with debounce state and unsubscribe handle
	private persistenceScheduler: PersistenceScheduler | null = null;

	private statusBar: TodayWordsStatusBar | null = null;

	async onload() {
		setPlugin(this);

		// Raw-read data.json: loadData() returns null for both a missing
		// and a truncated file; readValidDataJson leaves a corrupt file on
		// disk instead of silently treating it as first run. A truncated
		// file is unlikely now that typing never writes data.json (see the
		// two-channel note below).
		const loadedData = await readValidDataJson(this);
		const settings = normalizeSettings(loadedData?.settings);
		const statsData = await loadStatsData(this, settings);

		// Sync Zustand store with the loaded data before any React
		// component mounts.  After this point, store.settings /
		// store.today are all populated.
		useStore.getState().hydrateFromData({ settings, stats: statsData?.stats });

		// Once-per-day snapshot of the on-disk stats file BEFORE anything
		// can overwrite it (hydrate → persist).
		await snapshotRawDataFile(this, this.app, settings);

		/** Initialize SIDEBAR view */
		this.registerView(VIEW_TYPE, (leaf) => {
			return new PluginView(leaf, this);
		});

		this.initializeCommands();
		this.initializeEvents();
		this.initializeCodeBlocks();
		applyHeatmapColorStyles(this.app.workspace.containerEl);
		this.addSettingTab(new SettingsTab(this.app, this));

		this.statusBar = new TodayWordsStatusBar(this);

		// Two independent save channels (registered AFTER hydration, so
		// boot state can't schedule either):
		//   persistVersion (requestPersist, rAF-coalesced, data mutations
		//     such as typing) → stats file only
		//   settings slice (mutateSettings / external merge) → data.json.
		// Typing must never rewrite data.json: its saveData is a
		// truncate-rewrite that can be left half-written if the process is
		// killed (pagehide flush on mobile).
		this.persistenceScheduler = setupPersistenceScheduling(this);
		
		this.registerLifecycleEvents();
	}

	/**
	 * Wake/suspend lifecycle wiring, registered via registerDomEvent /
	 * registerInterval so unload cleanup is automatic.
	 *
	 * "Wake" (focus, becoming visible again) re-runs the day-rollover and
	 * external-stats checks — the fallback for mobile, where window focus
	 * may never fire on resume but visibilitychange does.
	 *
	 * "Suspend" (pagehide, becoming hidden) force-drains pending edits
	 * because requestAnimationFrame is paused in background tabs.
	 *
	 * The 5s sweep (pattern borrowed from position-restore's db flush) is
	 * the external-stats pickup for every path and window state — idle or
	 * not, default .obsidian path or not.  The mtime sentinel makes each
	 * tick a free stat() call, bounding adoption latency at ≤5s.
	 */
	private registerLifecycleEvents() {
		const onWake = () => {
			useStore.getState().checkDayChange();
			void checkExternalStatsFile(this);
		};
		const onSuspend = () => void this.flushNow();

		this.registerDomEvent(window, "focus", onWake);
		this.registerDomEvent(window, "pagehide", onSuspend);
		this.registerDomEvent(document, "visibilitychange", () => {
			if (document.hidden) onSuspend();
			else onWake();
		});
		this.registerInterval(
			window.setInterval(() => void checkExternalStatsFile(this), 5000),
		);
	}

	/**
	 * Drain any pending editor-change sample into the in-memory store
	 * and immediately persist the store (settings → data.json, stats →
	 * the stats file).  Used by the
	 * visibilitychange / pagehide handlers (because requestAnimationFrame
	 * is paused in background tabs) and during plugin unload so a
	 * coalesced debounced save still lands on disk before the scheduler
	 * is disposed.
	 */
	private async flushNow() {
		await events.flushPendingEditorChange();
		await this.persistenceScheduler?.flushNow();
	}

	private initializeCommands() {
		this.addRibbonIcon("calendar-days", "Keep the rhythm2", () => {
			void activateSidebarView();
		});

		this.addCommand({
			id: "open-sidebar",
			name: "Open sidebar view",
			callback: () => {
				void activateSidebarView();
			},
		});

		for (const { key, label, id } of CUSTOM_CODE_BLOCK_COMMANDS) {
			this.addCommand({
				id,
				name: `Insert ${label} code block`,
				editorCallback: (editor) => {
					insertCustomCodeBlock(key, editor);
				},
			});
		}
	}

	private initializeEvents() {
		this.registerEvent(
			this.app.workspace.on("active-leaf-change", (leaf) => {
				void events.handleFileOpen(leaf);
			}),
		);
		this.registerEvent(
			this.app.workspace.on("editor-change", (editor, info) => {
				void events.handleEditorChange(editor, info);
			}),
		);
		this.registerEvent(
			this.app.vault.on("delete", (file: TAbstractFile) => {
				if (file instanceof TFile) events.handleFileDelete(file);
			}),
		);
		this.registerEvent(
			this.app.vault.on(
				"rename",
				(file: TAbstractFile, oldPath: string) => {
					if (file instanceof TFile)
						events.handleFileRename(file, oldPath);
				},
			),
		);
	}

	private initializeCodeBlocks() {
		this.registerMarkdownCodeBlockProcessor(
			"ktr-heatmap",
			codeBlocks.createHeatmapCodeBlock,
		);

		this.registerMarkdownCodeBlockProcessor(
			"ktr-slots",
			codeBlocks.createSlotsCodeBlock,
		);

		this.registerMarkdownCodeBlockProcessor(
			"ktr-entries",
			codeBlocks.createEntriesCodeBlock,
		);
	}

	// #region Unloading

	onunload() {
		// Drain pending editor deltas and persist to disk before
		// tearing down the scheduler, so a coalesced debounced save
		// still lands on disk.  Obsidian does not await onunload, so the
		// promise is fire-and-forget here.
		void this.flushNow();

		// Stop reacting to persist signals.
		this.persistenceScheduler?.dispose();
		this.persistenceScheduler = null;

		this.statusBar?.dispose();
		this.statusBar = null;

		// Reset the module-level partitioned cache so stale data doesn't
		// leak into the next plugin load cycle.
		resetDailySummaryCache();
		resetStatsCodecCache();
		resetDataQueryCaches();
		resetFolderCache();
	}

	// #endregion

	async onExternalSettingsChange() {
		// data.json (settings) is pushed by Obsidian; merge it, then run one
		// cheap mtime check on the stats file — a sync that delivers
		// data.json usually delivers the stats file around the same time.
		// Validate the raw file first: a truncated / empty delivery must
		// NOT be normalized into defaults and clobber the live settings.
		await mergeExternalSettings(await readValidDataJson(this));
		await checkExternalStatsFile(this);
	}

}
