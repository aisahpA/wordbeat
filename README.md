# WordBeat

[English](README.md) | [简体中文](README.zh-CN.md)

An Obsidian plugin that tracks your daily writing, helps you set goals and keep a streak, and visualizes progress with a heatmap.

![image](https://github.com/user-attachments/assets/8acd047d-68da-42d0-835d-6c7ab55b6f65)

## Features

- **Automatic tracking** — every keystroke is counted per file, per day; no manual logging required
- **Writing goals and streaks** — set a daily goal and watch your consecutive-days streak grow
- **Heatmap** — a GitHub-style calendar of your writing activity, fully customizable (coloring modes, cell shape, labels, range, light/dark palettes)
- **Data slots** — today / this week / this month / this year / rolling periods / current streak, as words or chars, totals or averages
- **Tracked Folders** — restrict tracking to part of the vault
- **Three embeddable code blocks** — heatmap, slots and daily entries
- **Status bar** — today's count / goal; click to open the sidebar
- **Local-first storage** — one compact, dictionary-encoded JSON stats file; sync-safe row-level merge for Obsidian Sync, Git, Nutstore, etc.
- **Automatic backups** — once per day, keeps 7; auto-restores the newest non-empty backup if the stats file goes missing or is wiped

## Installation

#### BRAT INSTALLATION

1. Install the [BRAT](https://github.com/TfTHacker/obsidian42-brat) plugin and enable it.
2. Run the command `BRAT: Add a beta plugin for testing`.
3. Enter `aisahpA/wordbeat`.
4. Click **Add Plugin**, then enable **WordBeat** in Settings → Community plugins.

BRAT keeps the plugin updated from this repository's releases.

#### MANUAL INSTALLATION

1. Download `main.js`, `manifest.json` and `styles.css` from this repository's Releases section.
2. Create the folder `<your-vault>/.obsidian/plugins/wordbeat/`.
3. Put the three files inside it.
4. Reload Obsidian.
5. Go to Settings → Community plugins and enable **WordBeat**.

## Usage

<details>
<summary><strong>Click to expand usage, slots, code blocks and settings</strong></summary>

### Basic Usage

Once enabled, WordBeat tracks your writing automatically. To view your statistics:

1. Click the calendar icon in the ribbon or run the command `Open sidebar view`.
2. The sidebar shows your slots (overview), the heatmap, and today's entries.
3. Hover any heatmap cell to see that day's exact count; click it to open the day's note (uses Obsidian's core _Daily Notes_).
4. The status bar shows `today / goal` (toggle in settings); click it to open the sidebar.

### Writing Goals

1. Set your target in **Writing Goal** in the settings.
2. The plugin tracks a streak of consecutive days meeting the goal.
3. Show it with the `CURRENT_STREAK` slot.

### Tracking Scope

By default every markdown file in the vault is tracked. Add folders under **Settings → General → Tracked Folders** to restrict tracking to a subset. The list uses a folder suggester: press **Add folder** and pick a folder; remove a row with its trash button.

- A file is tracked when its path equals a configured folder or starts with `<folder>/` (so `20-research` matches `20-research/sub/deep.md` but not `20-research-backup/notes.md`).
- An empty list tracks the whole vault (default).
- Files outside the scope are ignored, and renaming a file out of scope removes its history.

### Heatmap Customization

- **Coloring modes**: `gradual` (smooth gradient), `solid` (single color once the day reaches your Writing Goal), `stops` (discrete thresholds) and `liquid` (fills from the bottom up).
- **Cell shape and size**: rounded or squared; configurable pixel size.
- **Labels**: hide month and/or weekday labels; align cells left.
- **Range**: number of weeks displayed and a custom start date.
- **Colors**: separate light/dark palettes, with reset-to-default.
- **Navigation**: click a cell to open that day's note.

### Data Slots

Add up to 10 slots per view. Each is `TARGET, UNIT, CALC`, where `UNIT` is `WORD` or `CHAR` and `CALC` is `TOTAL` or `AVG`.

| Slot | Meaning | AVG |
| --- | --- | --- |
| `CURRENT_FILE` | Today's delta for the active file | no |
| `CURRENT_DAY` | Words written today | no |
| `CURRENT_WEEK` | From Monday of this week to today | yes |
| `CURRENT_MONTH` | From the start of the month to today | yes |
| `CURRENT_YEAR` | From the start of the year to today | yes |
| `LAST_DAY` | Yesterday + today (2 days) | no |
| `LAST_WEEK` | Rolling last 7 days | yes |
| `LAST_MONTH` | Rolling last 30 days | yes |
| `LAST_YEAR` | Rolling last 365 days | yes |
| `CURRENT_STREAK` | Consecutive days meeting the goal (in days) | no |

### Code Blocks

Three embeddable code blocks. Insert them with the commands `Insert Heatmap/Slots/Entries code block` (or type them manually).

#### Heatmap (`wb-heatmap`)

A filter expression, then an `OPTIONS` section:

````
```wb-heatmap
filePath starts_with "journal"

OPTIONS
HIDE month_labels, weekday_labels
COLORING_MODE liquid
STOPS 100, 500, 1000
WEEKS 24
CENTER
CELL_SIZE 14
UNIT WORD
```
````

- Query fields: `date`, `filePath`, `wordsAdded`, `charsAdded`. Operators: `starts_with`, `contains`, `==`, `!=`, `>`, `<`, `>=`, `<=`, `&&`, `||`, `!`, plus `AND`/`OR` aliases and parentheses.
- Options: `HIDE month_labels, weekday_labels`; `COLORING_MODE liquid|stops|solid|gradual`; `STOPS a, b, c`; `SQUARED_CELLS` / `ROUNDED_CELLS`; `START_DATE YYYY-MM-DD`; `WEEKS n`; `CELL_SIZE n`; `UNIT WORD|CHAR`; `CENTER` (horizontally center the heatmap in the note).

#### Data Slots (`wb-slots`)

One slot per line: `TARGET`, `TARGET, UNIT`, or `TARGET, UNIT, CALC`.

````
```wb-slots
CURRENT_WEEK, WORD
CURRENT_DAY, CHAR
CURRENT_STREAK
CURRENT_MONTH, WORD, AVG
```
````

#### Daily Entries (`wb-entries`)

An optional date (`YYYY-MM-DD`, defaults to today) plus optional path filters:

````
```wb-entries
filePath includes "journal"
2026-08-01
```
````

- `filePath includes "..."` / `filePath excludes "..."` filter the listed files.
- Entries can be added manually, edited inline (double-click) and deleted.

### Settings

- **General**: Preferred Unit, Enabled Languages (10 scripts), Ignore Comments, Ignore Tasks, Ignore Deleted Files, Writing Goal, Editor Change Sample Delay, Tracked Folders.
- **Heatmaps**: navigation, shape, labels, alignment, start date, weeks, cell size, coloring mode, intensity stops, light/dark colors.
- **Sidebar**: show/hide overview, entries and heatmap.
- **Status Bar**: show today's count.
- **Data Storage**: stats data file location and history length.
- **Backup**: enable, folder path, days retained.

</details>

## Storage and Privacy

All data stays **local** — nothing is sent to external servers. Settings live in the plugin's `data.json` (Obsidian-managed); writing stats live in a separate JSON file (default `wordbeat-data.json` inside the plugin folder, changeable to any vault-relative path under **Settings → Data Storage**).

- **Dictionary encoding**: file paths are stored once as small integer IDs and activity is aggregated per day, so files that are only opened (never written) produce no row. The stats file stays compact even after years of daily use.
- **Live deltas**: today's value per file is `current count − count when first touched today`, so it can go negative when a file shrinks. Negative rows are kept and can be corrected.
- **Multi-device**: when the stats file changes behind the plugin's back (Obsidian Sync, Git, Nutstore, etc.), it is detected via mtime and merged row-by-row; the larger value wins. An empty external file never overwrites local data.
- **Backups**: once per calendar day a raw copy is written to the backup folder (default `.wordbeat`), keeping the newest 7 days. If the stats file is missing or emptied, the newest non-empty backup is restored automatically.

## Support

If you encounter issues or have suggestions:

1. Check the GitHub Issues to see if your issue has already been reported.
2. Create a new issue with as much detail as possible.
