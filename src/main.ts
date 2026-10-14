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
} from "@/core/backup";
import {
	setupStatsPersistence,
	StatsScheduler,
	checkExternalStatsFile,
} from "@/core/statsPersistence";
import {
	readSettings,
	mergeIncomingSettings,
	setupSettingsPersistence,
	SettingsScheduler,
} from "@/core/settingsPersistence";
import { normalizeSettings } from "@/defs/types";
import { resetDailySummaryCache } from "@/utils/dailySummaryCache";
import { resetStatsCodecCache } from "@/core/statsCodec";
import { resetDataQueryCaches } from "@/core/dataQueries";
import { resetFolderCache } from "@/core/pathFilter";

export default class WordBeat extends Plugin {
	
	// Two independent persistence channels with debounce state and
	// unsubscribe handles (stats file / data.json respectively).
	private statsScheduler: StatsScheduler | null = null;
	private settingsScheduler: SettingsScheduler | null = null;

	private statusBar: TodayWordsStatusBar | null = null;

	async onload() {
		setPlugin(this);

		// Missing / unreadable data.json → null → all defaults.
		const settings = normalizeSettings(await readSettings(this));
		const statsData = await loadStatsData(this, settings);

		// Sync Zustand store with the loaded data before any React
		// component mounts.  After this point, store.settings /
		// store.today are all populated.
		useStore.getState().hydrate(settings, statsData?.stats);

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

		// Save channels wire AFTER hydration so boot state schedules
		// nothing: typing/data → stats file, settings → data.json. They
		// stay separate so keystrokes never hit saveData's non-atomic
		// truncate-rewrite (details in each module's header).
		this.statsScheduler = setupStatsPersistence(this);
		this.settingsScheduler = setupSettingsPersistence(this);

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
	 * and immediately flush both save channels (stats → stats file,
	 * settings → data.json; the settings flush is a no-op when no
	 * settings change is pending).  Used by the
	 * visibilitychange / pagehide handlers (because requestAnimationFrame
	 * is paused in background tabs) and during plugin unload so a
	 * coalesced debounced save still lands on disk before the schedulers
	 * are disposed.
	 */
	private async flushNow() {
		await events.flushPendingEditorChange();
		await Promise.all([
			this.statsScheduler?.flushNow(),
			this.settingsScheduler?.flushNow(),
		]);
	}

	private initializeCommands() {
		this.addRibbonIcon("calendar-days", "WordBeat", () => {
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
			"wb-heatmap",
			codeBlocks.createHeatmapCodeBlock,
		);

		this.registerMarkdownCodeBlockProcessor(
			"wb-slots",
			codeBlocks.createSlotsCodeBlock,
		);

		this.registerMarkdownCodeBlockProcessor(
			"wb-entries",
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
		this.statsScheduler?.dispose();
		this.statsScheduler = null;
		this.settingsScheduler?.dispose();
		this.settingsScheduler = null;

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

	/** External data.json push. A truncated / wrong-shape delivery reads
	 *  as null and is ignored, so it can't clobber live settings. Stats
	 *  file pickup stays on the focus / 5s-poll / pre-write checks. */
	async onExternalSettingsChange() {
		await mergeIncomingSettings(await readSettings(this));
	}

}
