import { ItemView, WorkspaceLeaf } from "obsidian";
import WordBeat from "../../main";
import * as React from "react";
import { createRoot, Root } from "react-dom/client";
import { WordBeatView } from "../components/SidebarView";

export const VIEW_TYPE = "wordbeat";

export class PluginView extends ItemView {
	plugin: WordBeat;
	root: Root | null = null;

	constructor(leaf: WorkspaceLeaf, plugin: WordBeat) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType() {
		return VIEW_TYPE;
	}

	getDisplayText() {
		return "WordBeat";
	}

	getIcon(): string {
		return "calendar-days";
	}

	async onOpen() {
		const container = this.containerEl.children[1];
		container.empty();
		const reactContainer = container.createDiv();
		this.root = createRoot(reactContainer);

		// WordBeatView reads everything it needs from the Zustand store, so no
		// plugin prop is required.
		this.root.render(React.createElement(WordBeatView));
	}

	async onClose() {
		if (this.root) {
			this.root.unmount();
			this.root = null;
		}
	}

	refresh(): void {
		// this.root?.render(
		// 	React.createElement(Heatmap, {
		// 		data: this.plugin.mergedStats,
		// 		intensityLevels:
		// 			this.plugin.pluginData.settings.intensityLevels,
		// 		showOverview: this.plugin.pluginData.settings.showOverview,
		// 		showHeatmap: this.plugin.pluginData.settings.showHeatmap,
		// 		showEntries: this.plugin.pluginData.settings.showEntries,
		// 		plugin: this.plugin,
		// 	}),
		// );
	}
}
