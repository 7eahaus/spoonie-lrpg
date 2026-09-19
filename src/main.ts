import {
	addIcon,
	App,
	FuzzySuggestModal,
	ItemView,
	MarkdownView,
	Modal,
	Notice,
	Plugin,
	Setting,
	TFile,
	WorkspaceLeaf,
} from 'obsidian';
import {
	ItemType,
	MyPluginSettings,
	Priority,
	RecurrenceMode,
	RecurrenceRule,
	SampleSettingTab,
	TrackableItem,
	DailyRecord,
	DailyActivity,
	JournalEntry,
	MoodSelection,
	getDefaultMoodCatalog,
	getDefaultPainAreasCatalog,
	migrateSettings,
} from './settings';

interface ItemDraft {
	title: string;
	type: ItemType;
	spoonCost: number;
	spoonRecovery: number;
	priority: Priority;
	isSelfCare: boolean;
	recurrence: RecurrenceRule;
	notes?: string;
	tags?: string[];
}

interface CompletionResult {
	xpAwarded: number;
	spoonsRecovered: number;
	usedNoSpoonsBonus: boolean;
}

interface DayCloseResult {
	date: string;
	streakBefore: number;
	streakAfter: number;
	freezeUsed: boolean;
	freezeTokensAfter: number;
	streakCounted: boolean;
	freezeAwarded: boolean;
	bonusXpAwarded: number;
}

interface JournalEntryDraft {
	date?: string;
	time?: string;
	moodScore: number;
	moodSelections: MoodSelection[];
	painScore: number;
	painAreaIds: string[];
	note?: string;
}

interface ActivityDraft {
	title: string;
	spoons: number;
	isRestorative: boolean;
}

interface ChartQuery {
	metric: 'mood' | 'pain' | 'both';
	range: string;
	fromDate?: string;
	toDate?: string;
	title?: string;
}

interface JournalBlockQuery {
	range: string;
	fromDate?: string;
	toDate?: string;
	title?: string;
	limit?: number;
	order: 'asc' | 'desc';
}

interface ChartDataPoint {
	date: string;
	mood?: number;
	pain?: number;
}

const PRIORITY_RANK: Record<Priority, number> = {
	critical: 4,
	high: 3,
	medium: 2,
	low: 1,
};

const ITEM_TYPE_LABELS: Record<ItemType, string> = {
	habit: 'Habit',
	task: 'Task',
};

const RECURRENCE_MODE_LABELS: Record<RecurrenceMode, string> = {
	always: 'Any day',
	daily: 'Every day',
	weekly: 'Weekly',
	interval: 'Every N days',
	monthly: 'Monthly',
};

const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const CHART_RANGE_OPTIONS = ['7d', '14d', '30d', '90d', '180d', 'all'];

function formatRecurrenceSummary(rule?: RecurrenceRule): string {
	const recurrence = rule ?? { mode: 'always' as RecurrenceMode };
	switch (recurrence.mode) {
		case 'always':
			return RECURRENCE_MODE_LABELS.always;
		case 'daily':
			return RECURRENCE_MODE_LABELS.daily;
		case 'weekly': {
			const weekdays = (recurrence.weekdays ?? [])
				.filter((day) => Number.isInteger(day) && day >= 0 && day <= 6)
				.sort((a, b) => a - b);
			if (weekdays.length === 0) {
				return RECURRENCE_MODE_LABELS.weekly;
			}
			return `Weekly: ${weekdays.map((day) => WEEKDAY_LABELS[day]).join(', ')}`;
		}
		case 'interval':
			return `Every ${Math.max(1, recurrence.intervalDays ?? 1)} day(s)`;
		case 'monthly':
			return `Monthly: day ${Math.max(1, Math.min(31, recurrence.dayOfMonth ?? 1))}`;
		default:
			return RECURRENCE_MODE_LABELS.always;
	}
}

const DASHBOARD_VIEW_TYPE = 'spoonie-lrpg-dashboard-view';

const SPOON_ICON_NAME = 'spoonie-spoon';
const SPOON_ICON_SVG = `
<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
	<g fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
		<ellipse cx="7.2" cy="6.3" rx="2.3" ry="2.9" transform="rotate(-38 7.2 6.3)"/>
		<path d="M8.9 8.3L17.5 19.6"/>

		<ellipse cx="16.8" cy="6.3" rx="2.3" ry="2.9" transform="rotate(38 16.8 6.3)"/>
		<path d="M15.1 8.3L6.5 19.6"/>
	</g>
</svg>`;

export default class SpoonieLrpgPlugin extends Plugin {
	settings!: MyPluginSettings;
	private statusBarItemEl?: HTMLElement;
	private dueDebugModeEnabled = false;

	async onload() {
		await this.loadSettings();
		addIcon(SPOON_ICON_NAME, SPOON_ICON_SVG);
		this.registerView(
			DASHBOARD_VIEW_TYPE,
			(leaf) => new DashboardView(leaf, this),
		);

		this.app.workspace.onLayoutReady(() => {
			if (this.settings.config.autoOpenDashboardSidebarOnLoad) {
				void this.openDashboardInSidebar();
			}
		});

		this.addRibbonIcon('list-plus', 'Add Spoonie item', () => {
			this.openCreateItemModal();
		});

		this.addRibbonIcon(SPOON_ICON_NAME, 'Open Spoonie dashboard (full view)', () => {
			void this.openDashboardInMainView();
		});

		this.addRibbonIcon('sidebar-right', 'Open Spoonie dashboard (sidebar)', () => {
			void this.openDashboardInSidebar();
		});

		this.statusBarItemEl = this.addStatusBarItem();
		this.refreshStatusBar();

		this.addCommand({
			id: 'spoonie-add-item',
			name: 'Add task/habit',
			callback: () => {
				this.openCreateItemModal();
			},
		});

		this.addCommand({
			id: 'spoonie-log-activity',
			name: 'Log activity (spoons taken/restored)',
			callback: () => {
				this.openAddActivityModalForDate(this.getTodayDateKey());
			},
		});

		this.addCommand({
			id: 'spoonie-edit-item',
			name: 'Edit task/habit',
			callback: () => {
				this.openEditItemPicker();
			},
		});

		this.addCommand({
			id: 'spoonie-archive-item',
			name: 'Archive task/habit',
			callback: () => {
				this.openArchiveItemPicker();
			},
		});

		this.addCommand({
			id: 'spoonie-list-active-items',
			name: 'Show active task/habit summary',
			callback: () => {
				this.showActiveItemsSummary();
			},
		});

		this.addCommand({
			id: 'spoonie-toggle-due-debug',
			name: 'Toggle due-debug details on dashboard',
			callback: () => {
				this.dueDebugModeEnabled = !this.dueDebugModeEnabled;
				new Notice(
					this.dueDebugModeEnabled
						? 'Due-debug mode enabled for dashboard.'
						: 'Due-debug mode disabled for dashboard.',
				);
				this.refreshOpenDashboardViews();
			},
		});

		this.addCommand({
			id: 'spoonie-set-today-spoons',
			name: 'Set today spoon budget',
			callback: () => {
				this.openDailySetupModal();
			},
		});

		this.addCommand({
			id: 'spoonie-toggle-flare-day',
			name: 'Toggle flare day for today',
			callback: async () => {
				const today = this.getTodayRecord();
				today.flareDay = !today.flareDay;
				if (!today.flareDay) {
					today.useFreezeToday = false;
				}
				today.updatedAt = new Date().toISOString();
				await this.saveSettings();
				new Notice(
					today.flareDay
						? 'Today is marked as a flare day. Enable freeze use if needed.'
						: 'Flare day removed for today.',
				);
				this.refreshStatusBar();
			},
		});

		this.addCommand({
			id: 'spoonie-toggle-use-freeze-today',
			name: 'Toggle using freeze for today',
			callback: async () => {
				const today = this.getTodayRecord();
				if (!today.flareDay) {
					new Notice('Mark today as a flare day before enabling freeze use.');
					return;
				}

				today.useFreezeToday = !today.useFreezeToday;
				today.updatedAt = new Date().toISOString();
				await this.saveSettings();
				new Notice(
					today.useFreezeToday
						? 'Freeze use is enabled for today.'
						: 'Freeze use is disabled for today.',
				);
				this.refreshStatusBar();
			},
		});

		this.addCommand({
			id: 'spoonie-complete-item-today',
			name: 'Complete an item for today',
			callback: () => {
				this.openCompleteItemFromDashboard();
			},
		});

		this.addCommand({
			id: 'spoonie-uncomplete-item-today',
			name: 'Uncomplete an item for today',
			callback: () => {
				this.openUncompleteItemFromDashboard();
			},
		});

		this.addCommand({
			id: 'spoonie-skip-item-to-tomorrow',
			name: 'Skip a due item to tomorrow',
			callback: () => {
				this.openSkipItemFromDashboard();
			},
		});

		this.addCommand({
			id: 'spoonie-show-today-summary',
			name: 'Show today summary',
			callback: () => {
				this.showTodaySummary();
			},
		});

		this.addCommand({
			id: 'spoonie-open-dashboard',
			name: 'Open dashboard (full view)',
			callback: async () => {
				await this.openDashboardInMainView();
			},
		});

		this.addCommand({
			id: 'spoonie-open-dashboard-sidebar',
			name: 'Open dashboard (sidebar)',
			callback: async () => {
				await this.openDashboardInSidebar();
			},
		});

		this.addCommand({
			id: 'spoonie-open-dashboard-modal',
			name: 'Open dashboard (modal)',
			callback: () => {
				this.openDashboardModal();
			},
		});

		this.addCommand({
			id: 'spoonie-finalize-today',
			name: 'Finalize today and update streak',
			callback: async () => {
				const result = await this.finalizeDayAndUpdateStreak(
					this.getTodayDateKey(),
				);
				this.showDayCloseResult(result);
			},
		});

		this.addCommand({
			id: 'spoonie-show-streak-status',
			name: 'Show streak and freeze status',
			callback: () => {
				this.showStreakStatus();
			},
		});

		this.addCommand({
			id: 'spoonie-add-journal-entry',
			name: 'Add journal entry',
			callback: () => {
				this.openJournalEntryModal();
			},
		});

		this.addCommand({
			id: 'spoonie-show-today-journal-summary',
			name: 'Show today journal summary',
			callback: () => {
				this.showTodayJournalSummary();
			},
		});

		this.addCommand({
			id: 'spoonie-open-journal-history',
			name: 'Open journal history',
			callback: () => {
				this.openJournalHistoryModal();
			},
		});

		this.addCommand({
			id: 'spoonie-apply-blueprint-journal-catalogs',
			name: 'Apply blueprint mood and pain catalogs',
			callback: async () => {
				await this.applyBlueprintJournalCatalogs();
			},
		});

		this.addCommand({
			id: 'spoonie-insert-chart-block',
			name: 'Insert mood/pain chart block in note',
			callback: () => {
				this.openInsertChartBlockModal();
			},
		});

		this.addCommand({
			id: 'spoonie-insert-journal-block',
			name: 'Insert journal block in note',
			callback: () => {
				this.openInsertJournalBlockModal();
			},
		});

		this.registerMarkdownCodeBlockProcessor(
			'spoonie-chart',
			(source, el, ctx) => {
				this.renderChartBlock(source, el, ctx.sourcePath);
			},
		);

		this.registerMarkdownCodeBlockProcessor('spoonie-journal', (source, el) => {
			this.renderJournalBlock(source, el);
		});

		this.addSettingTab(new SampleSettingTab(this.app, this));
	}

	onunload() {
		this.app.workspace
			.getLeavesOfType(DASHBOARD_VIEW_TYPE)
			.forEach((leaf) => leaf.detach());
	}

	async loadSettings() {
		const rawData = await this.loadData();
		this.settings = migrateSettings(rawData);
		await this.saveSettings();
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	getAllItems(): TrackableItem[] {
		return Object.values(this.settings.items);
	}

	getActiveItems(): TrackableItem[] {
		return this.getAllItems()
			.filter((item) => item.active)
			.sort((a, b) => {
				const priorityDiff =
					PRIORITY_RANK[b.priority] - PRIORITY_RANK[a.priority];
				if (priorityDiff !== 0) {
					return priorityDiff;
				}
				return a.title.localeCompare(b.title);
			});
	}

	private normalizeRecurrenceForItem(
		rule: RecurrenceRule | undefined,
		createdAtIso: string,
	): RecurrenceRule {
		const rawMode = rule?.mode;
		const mode: RecurrenceMode =
			rawMode === 'always' ||
			rawMode === 'daily' ||
			rawMode === 'weekly' ||
			rawMode === 'interval' ||
			rawMode === 'monthly'
				? rawMode
				: 'always';

		const createdDate = this.getDateKeyFromTimestamp(createdAtIso);
		const startDate =
			typeof rule?.startDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(rule.startDate)
				? rule.startDate
				: createdDate;
		const weekdays = Array.isArray(rule?.weekdays)
			? [...new Set(rule.weekdays)]
					.filter((day) => Number.isInteger(day) && day >= 0 && day <= 6)
					.sort((a, b) => a - b)
			: undefined;
		const intervalDays = Math.max(1, Math.round(rule?.intervalDays ?? 1));
		const dayOfMonth = Math.max(1, Math.min(31, Math.round(rule?.dayOfMonth ?? 1)));

		if (mode === 'weekly') {
			return { mode, startDate, weekdays: weekdays && weekdays.length > 0 ? weekdays : [1] };
		}
		if (mode === 'interval') {
			return { mode, startDate, intervalDays };
		}
		if (mode === 'monthly') {
			return { mode, startDate, dayOfMonth };
		}
		if (mode === 'daily') {
			return { mode, startDate };
		}

		return { mode: 'always', startDate };
	}

	private formatDateKeyFromDate(date: Date): string {
		const year = String(date.getFullYear());
		const month = String(date.getMonth() + 1).padStart(2, '0');
		const day = String(date.getDate()).padStart(2, '0');
		return `${year}-${month}-${day}`;
	}

	private parseDateKeyToLocalDate(dateKey: string): Date | null {
		const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateKey);
		if (!match) {
			return null;
		}

		const [, yearText, monthText, dayText] = match;
		if (!yearText || !monthText || !dayText) {
			return null;
		}

		const year = Number.parseInt(yearText, 10);
		const month = Number.parseInt(monthText, 10);
		const day = Number.parseInt(dayText, 10);
		const parsed = new Date(year, month - 1, day, 12, 0, 0, 0);
		if (
			parsed.getFullYear() !== year ||
			parsed.getMonth() !== month - 1 ||
			parsed.getDate() !== day
		) {
			return null;
		}

		return parsed;
	}

	private getDateKeyDayNumber(dateKey: string): number | null {
		const parsed = this.parseDateKeyToLocalDate(dateKey);
		if (!parsed) {
			return null;
		}

		return Math.floor(
			Date.UTC(parsed.getFullYear(), parsed.getMonth(), parsed.getDate()) / 86400000,
		);
	}

	private getDateKeyFromTimestamp(timestamp: string): string {
		const parsed = new Date(timestamp);
		if (Number.isNaN(parsed.getTime())) {
			return this.formatDateKeyFromDate(new Date());
		}

		return this.formatDateKeyFromDate(parsed);
	}

	private getDateDiffInDays(startDate: string, endDate: string): number {
		const startDayNumber = this.getDateKeyDayNumber(startDate);
		const endDayNumber = this.getDateKeyDayNumber(endDate);
		if (startDayNumber === null || endDayNumber === null) {
			return 0;
		}
		return endDayNumber - startDayNumber;
	}

	getDateKeyWithOffset(date: string, dayOffset: number): string {
		const dateObj = this.parseDateKeyToLocalDate(date);
		if (!dateObj) {
			return date;
		}
		dateObj.setDate(dateObj.getDate() + dayOffset);
		return this.formatDateKeyFromDate(dateObj);
	}

	private evaluateRecurrenceDue(
		item: TrackableItem,
		date: string,
	): {
		isDue: boolean;
		reason: string;
		recurrenceLabel: string;
		startDate: string;
		diffDays: number;
	} {
		const recurrence = this.normalizeRecurrenceForItem(item.recurrence, item.createdAt);
		const recurrenceLabel = formatRecurrenceSummary(recurrence);
		const startDate = recurrence.startDate ?? this.getDateKeyFromTimestamp(item.createdAt);
		const diffDays = this.getDateDiffInDays(startDate, date);

		if (!item.active) {
			return {
				isDue: false,
				reason: 'item is archived/inactive',
				recurrenceLabel,
				startDate,
				diffDays,
			};
		}

		if (
			typeof item.deferUntilDate === 'string' &&
			/^\d{4}-\d{2}-\d{2}$/.test(item.deferUntilDate) &&
			date < item.deferUntilDate
		) {
			return {
				isDue: false,
				reason: `deferred until ${item.deferUntilDate}`,
				recurrenceLabel,
				startDate,
				diffDays,
			};
		}

		if (diffDays < 0) {
			return {
				isDue: false,
				reason: `date is before start (${startDate})`,
				recurrenceLabel,
				startDate,
				diffDays,
			};
		}

		switch (recurrence.mode) {
			case 'always':
				return { isDue: true, reason: 'always mode', recurrenceLabel, startDate, diffDays };
			case 'daily':
				return { isDue: true, reason: 'daily mode', recurrenceLabel, startDate, diffDays };
			case 'weekly': {
				const dateObj = this.parseDateKeyToLocalDate(date);
				if (!dateObj) {
					return {
						isDue: false,
						reason: 'invalid target date',
						recurrenceLabel,
						startDate,
						diffDays,
					};
				}
				const weekday = dateObj.getDay();
				const weekdays = recurrence.weekdays ?? [];
				const isDue = weekdays.includes(weekday);
				return {
					isDue,
					reason: isDue
						? `weekly match (${WEEKDAY_LABELS[weekday]})`
						: `weekly miss (${WEEKDAY_LABELS[weekday]})`,
					recurrenceLabel,
					startDate,
					diffDays,
				};
			}
			case 'interval': {
				const interval = Math.max(1, recurrence.intervalDays ?? 1);
				const isDue = diffDays % interval === 0;
				return {
					isDue,
					reason: isDue
						? `interval match (every ${interval} days)`
						: `interval miss (diff ${diffDays}, every ${interval})`,
					recurrenceLabel,
					startDate,
					diffDays,
				};
			}
			case 'monthly': {
				const dateObj = this.parseDateKeyToLocalDate(date);
				if (!dateObj) {
					return {
						isDue: false,
						reason: 'invalid target date',
						recurrenceLabel,
						startDate,
						diffDays,
					};
				}
				const todayDay = dateObj.getDate();
				const targetDay = Math.max(1, Math.min(31, recurrence.dayOfMonth ?? 1));
				const isDue = todayDay === targetDay;
				return {
					isDue,
					reason: isDue
						? `monthly match (day ${targetDay})`
						: `monthly miss (today ${todayDay}, target ${targetDay})`,
					recurrenceLabel,
					startDate,
					diffDays,
				};
			}
			default:
				return { isDue: true, reason: 'default due', recurrenceLabel, startDate, diffDays };
		}
	}

	isItemDueOnDate(item: TrackableItem, date: string): boolean {
		return this.evaluateRecurrenceDue(item, date).isDue;
	}

	isDueDebugModeEnabled(): boolean {
		return this.dueDebugModeEnabled;
	}

	getDueDebugInfo(
		item: TrackableItem,
		date: string,
		completedTodayIds: string[],
	): string {
		const details = this.evaluateRecurrenceDue(item, date);
		const completed = completedTodayIds.includes(item.id);
		const deferText = item.deferUntilDate ?? '-';
		return [
			`due=${details.isDue ? 'yes' : 'no'}`,
			`completedToday=${completed ? 'yes' : 'no'}`,
			`rule=${details.recurrenceLabel}`,
			`start=${details.startDate}`,
			`diff=${details.diffDays}`,
			`deferUntil=${deferText}`,
			`reason=${details.reason}`,
		].join(' | ');
	}

	getDueItemsForDate(date: string): TrackableItem[] {
		return this.getActiveItems().filter((item) => this.isItemDueOnDate(item, date));
	}

	async createItem(draft: ItemDraft): Promise<TrackableItem> {
		const now = new Date().toISOString();
		const recurrence = this.normalizeRecurrenceForItem(draft.recurrence, now);
		const item: TrackableItem = {
			id: this.createItemId(),
			title: draft.title.trim(),
			type: draft.type,
			spoonCost: Math.max(1, Math.round(draft.spoonCost)),
			spoonRecovery: Math.max(0, Math.round(draft.spoonRecovery)),
			priority: draft.priority,
			isSelfCare: draft.isSelfCare,
			recurrence,
			active: true,
			createdAt: now,
			notes: draft.notes?.trim() || undefined,
			tags: (draft.tags ?? []).filter((tag) => tag.length > 0),
		};

		this.settings.items[item.id] = item;
		await this.saveSettings();
		this.refreshStatusBar();
		return item;
	}

	async updateItem(itemId: string, draft: ItemDraft): Promise<TrackableItem | null> {
		const existing = this.settings.items[itemId];
		if (!existing) {
			return null;
		}

		const updated: TrackableItem = {
			...existing,
			title: draft.title.trim(),
			type: draft.type,
			spoonCost: Math.max(1, Math.round(draft.spoonCost)),
			spoonRecovery: Math.max(0, Math.round(draft.spoonRecovery)),
			priority: draft.priority,
			isSelfCare: draft.isSelfCare,
			recurrence: this.normalizeRecurrenceForItem(
				draft.recurrence,
				existing.createdAt,
			),
			notes: draft.notes?.trim() || undefined,
			tags: (draft.tags ?? []).filter((tag) => tag.length > 0),
		};

		this.settings.items[itemId] = updated;
		await this.saveSettings();
		this.refreshStatusBar();
		return updated;
	}

	async archiveItem(itemId: string): Promise<TrackableItem | null> {
		const existing = this.settings.items[itemId];
		if (!existing) {
			return null;
		}

		if (!existing.active) {
			return existing;
		}

		existing.active = false;
		existing.archivedAt = new Date().toISOString();
		await this.saveSettings();
		this.refreshStatusBar();
		return existing;
	}

	getTodayDateKey(): string {
		return this.formatDateKeyFromDate(new Date());
	}

	getOrCreateDailyRecord(date: string): DailyRecord {
		const existing = this.settings.daily[date];
		if (existing) {
			return existing;
		}

		const nowIso = new Date().toISOString();
		const record: DailyRecord = {
			date,
			availableSpoons: this.settings.profile.baselineSpoons,
			flareDay: false,
			useFreezeToday: false,
			completedItemIds: [],
			completedItemXpById: {},
			completedItemSpoonsRecoveredById: {},
			xpEarned: 0,
			streakCounted: false,
			freezeUsed: false,
			journalEntryIds: [],
			activities: [],
			createdAt: nowIso,
			updatedAt: nowIso,
		};

		this.settings.daily[date] = record;
		return record;
	}

	getTodayRecord(): DailyRecord {
		return this.getOrCreateDailyRecord(this.getTodayDateKey());
	}

	private createActivityId(): string {
		const randomPart = Math.random().toString(36).slice(2, 8);
		return `activity-${Date.now()}-${randomPart}`;
	}

	private getActivitySpoonDelta(draft: ActivityDraft): number {
		const amount = Math.max(0, Math.round(draft.spoons));
		return draft.isRestorative ? amount : -amount;
	}

	async addActivityForDate(
		date: string,
		draft: ActivityDraft,
	): Promise<DailyActivity> {
		const day = this.getOrCreateDailyRecord(date);
		const spoonDelta = this.getActivitySpoonDelta(draft);
		const xpAwarded = Math.abs(spoonDelta) * 3;
		const nowIso = new Date().toISOString();
		const activity: DailyActivity = {
			id: this.createActivityId(),
			title: draft.title.trim(),
			spoonDelta,
			createdAt: nowIso,
		};

		day.activities = day.activities ?? [];
		day.activities.push(activity);
		day.availableSpoons += spoonDelta;
		day.xpEarned += xpAwarded;
		day.updatedAt = nowIso;
		this.settings.profile.totalXp += xpAwarded;
		await this.saveSettings();
		this.refreshStatusBar();
		this.refreshOpenDashboardViews();
		return activity;
	}

	getActivityNetSpoonsForDate(date: string): number {
		const day = this.getOrCreateDailyRecord(date);
		const activities = day.activities ?? [];
		return activities.reduce((sum, activity) => sum + activity.spoonDelta, 0);
	}

	getSpoonsLeftForDate(date: string): number {
		const day = this.getOrCreateDailyRecord(date);
		const spent = day.completedItemIds.reduce((total, itemId) => {
			const item = this.settings.items[itemId];
			return total + (item?.spoonCost ?? 0);
		}, 0);
		return day.availableSpoons - spent;
	}

	getSpoonsLeftForToday(): number {
		return this.getSpoonsLeftForDate(this.getTodayDateKey());
	}

	computeTaskXp(item: TrackableItem, availableSpoons: number): number {
		const baseline = Math.max(1, this.settings.profile.baselineSpoons);
		const daySpoons = Math.max(0, availableSpoons);
		const scarcityRatio = Math.max(0, (baseline - daySpoons) / baseline);
		const scarcityFactor =
			1 + this.settings.config.scarcityAlpha * scarcityRatio;
		const priorityFactor = this.settings.config.priorityMultipliers[item.priority];
		const rawXp =
			this.settings.config.baseXp *
			item.spoonCost *
			priorityFactor *
			scarcityFactor;
		return Math.max(1, Math.round(rawXp));
	}

	xpRequiredForLevel(level: number): number {
		const targetLevel = Math.max(1, level);
		return Math.round(100 * Math.pow(targetLevel, 1.2));
	}

	applyLevelFromTotalXp(): void {
		let level = 1;
		while (this.settings.profile.totalXp >= this.xpRequiredForLevel(level + 1)) {
			level += 1;
		}
		this.settings.profile.level = level;
	}

	async completeItemForDate(
		itemId: string,
		date: string,
	): Promise<CompletionResult | null> {
		const item = this.settings.items[itemId];
		if (!item || !item.active) {
			return null;
		}

		const day = this.getOrCreateDailyRecord(date);
		if (day.completedItemIds.includes(itemId)) {
			return {
				xpAwarded: 0,
				spoonsRecovered: 0,
				usedNoSpoonsBonus: false,
			};
		}

		const spoonsLeftBefore = this.getSpoonsLeftForDate(day.date);
		const baseXp = this.computeTaskXp(item, day.availableSpoons);
		const usedNoSpoonsBonus = spoonsLeftBefore <= 0;
		const xpAwarded = usedNoSpoonsBonus
			? Math.max(
					1,
					Math.round(
						baseXp * this.settings.config.noSpoonsXpMultiplier,
					),
			  )
			: baseXp;
		const spoonsRecovered = Math.max(0, Math.round(item.spoonRecovery ?? 0));
		day.completedItemIds.push(itemId);
		if (!day.completedItemXpById) {
			day.completedItemXpById = {};
		}
		if (!day.completedItemSpoonsRecoveredById) {
			day.completedItemSpoonsRecoveredById = {};
		}
		day.completedItemXpById[itemId] = xpAwarded;
		day.completedItemSpoonsRecoveredById[itemId] = spoonsRecovered;
		if (spoonsRecovered > 0) {
			day.availableSpoons += spoonsRecovered;
		}
		day.xpEarned += xpAwarded;
		day.updatedAt = new Date().toISOString();
		this.settings.profile.totalXp += xpAwarded;
		this.applyLevelFromTotalXp();
		await this.saveSettings();
		this.refreshStatusBar();
		this.refreshOpenDashboardViews();
		return {
			xpAwarded,
			spoonsRecovered,
			usedNoSpoonsBonus,
		};
	}

	async completeItemForToday(itemId: string): Promise<CompletionResult | null> {
		return this.completeItemForDate(itemId, this.getTodayDateKey());
	}

	async uncompleteItemForDate(itemId: string, date: string): Promise<number | null> {
		const item = this.settings.items[itemId];
		if (!item) {
			return null;
		}

		const day = this.getOrCreateDailyRecord(date);
		if (!day.completedItemIds.includes(itemId)) {
			return 0;
		}

		const xpToRemove = day.completedItemXpById?.[itemId] ?? this.computeTaskXp(item, day.availableSpoons);
		const recoveredToRemove =
			day.completedItemSpoonsRecoveredById?.[itemId] ?? Math.max(0, Math.round(item.spoonRecovery ?? 0));
		day.completedItemIds = day.completedItemIds.filter((id) => id !== itemId);
		if (day.completedItemXpById) {
			delete day.completedItemXpById[itemId];
		}
		if (day.completedItemSpoonsRecoveredById) {
			delete day.completedItemSpoonsRecoveredById[itemId];
		}
		if (recoveredToRemove > 0) {
			day.availableSpoons = Math.max(0, day.availableSpoons - recoveredToRemove);
		}
		day.xpEarned = Math.max(0, day.xpEarned - xpToRemove);
		day.updatedAt = new Date().toISOString();
		this.settings.profile.totalXp = Math.max(
			0,
			this.settings.profile.totalXp - xpToRemove,
		);
		this.applyLevelFromTotalXp();
		await this.saveSettings();
		this.refreshStatusBar();
		this.refreshOpenDashboardViews();
		return xpToRemove;
	}

	async uncompleteItemForToday(itemId: string): Promise<number | null> {
		return this.uncompleteItemForDate(itemId, this.getTodayDateKey());
	}

	async skipItemForDateToNextDay(
		itemId: string,
		date: string,
	): Promise<string | null> {
		const item = this.settings.items[itemId];
		if (!item || !item.active) {
			return null;
		}

		const day = this.getOrCreateDailyRecord(date);
		if (day.completedItemIds.includes(itemId)) {
			return null;
		}

		if (!this.isItemDueOnDate(item, day.date)) {
			return null;
		}

		const tomorrow = this.getDateKeyWithOffset(day.date, 1);
		item.deferUntilDate = tomorrow;
		await this.saveSettings();
		this.refreshStatusBar();
		this.refreshOpenDashboardViews();
		return tomorrow;
	}

	async skipItemToTomorrow(itemId: string): Promise<string | null> {
		return this.skipItemForDateToNextDay(itemId, this.getTodayDateKey());
	}

	async finalizeDayAndUpdateStreak(date: string): Promise<DayCloseResult> {
		const day = this.getOrCreateDailyRecord(date);
		const profile = this.settings.profile;
		const config = this.settings.config;
		const streakBefore = profile.currentStreak;
		const completionCount = day.completedItemIds.length;
		const meetsCompletionGoal =
			completionCount >= config.minCompletionsForStreakDay;

		if (day.streakCounted || day.freezeUsed) {
			return {
				date,
				streakBefore,
				streakAfter: profile.currentStreak,
				freezeUsed: day.freezeUsed,
				freezeTokensAfter: profile.freezeTokens,
				streakCounted: day.streakCounted,
				freezeAwarded: false,
				bonusXpAwarded: 0,
			};
		}

		const dayGap = this.getDayGap(profile.lastActiveDate, date);
		if (dayGap > 1) {
			profile.currentStreak = 0;
			profile.streakDaysTowardNextFreeze = 0;
		}

		let freezeAwarded = false;
		let bonusXpAwarded = 0;
		if (day.flareDay && day.useFreezeToday && profile.freezeTokens > 0) {
			profile.freezeTokens -= 1;
			day.freezeUsed = true;
			day.streakCounted = false;

			bonusXpAwarded = this.computeFreezeDayBonusXp(day);
			if (bonusXpAwarded > 0) {
				day.xpEarned += bonusXpAwarded;
				profile.totalXp += bonusXpAwarded;
				this.applyLevelFromTotalXp();
			}
		} else if (meetsCompletionGoal) {
			profile.currentStreak += 1;
			profile.longestStreak = Math.max(
				profile.longestStreak,
				profile.currentStreak,
			);
			profile.streakDaysTowardNextFreeze += 1;
			day.streakCounted = true;
			day.freezeUsed = false;

			if (
				profile.streakDaysTowardNextFreeze >= config.daysPerFreezeReward &&
				profile.freezeTokens < config.maxFreezeTokens
			) {
				profile.freezeTokens += 1;
				freezeAwarded = true;
			}
			if (profile.streakDaysTowardNextFreeze >= config.daysPerFreezeReward) {
				profile.streakDaysTowardNextFreeze = 0;
			}
		} else {
			profile.currentStreak = 0;
			profile.streakDaysTowardNextFreeze = 0;
			day.streakCounted = false;
			day.freezeUsed = false;
		}

		profile.lastActiveDate = date;
		day.updatedAt = new Date().toISOString();
		await this.saveSettings();
		this.refreshStatusBar();

		return {
			date,
			streakBefore,
			streakAfter: profile.currentStreak,
			freezeUsed: day.freezeUsed,
			freezeTokensAfter: profile.freezeTokens,
			streakCounted: day.streakCounted,
			freezeAwarded,
			bonusXpAwarded,
		};
	}

	private getDayGap(lastDate: string | undefined, nextDate: string): number {
		if (!lastDate) {
			return 1;
		}

		const diffDays = this.getDateDiffInDays(lastDate, nextDate);
		return Math.max(0, diffDays);
	}

	private computeFreezeDayBonusXp(day: DailyRecord): number {
		let totalBonusXp = 0;
		for (const itemId of day.completedItemIds) {
			const item = this.settings.items[itemId];
			if (!item) {
				continue;
			}

			const baseXp =
				day.completedItemXpById?.[itemId] ??
				this.computeTaskXp(item, day.availableSpoons);
			const taskBonus = Math.round(
				baseXp * this.settings.config.freezeDayTaskXpBonusPct,
			);
			totalBonusXp += taskBonus;

			if (item.type === 'habit' && item.isSelfCare) {
				const selfCareBonus = Math.round(
					baseXp * this.settings.config.freezeDaySelfCareHabitBonusPct,
				);
				totalBonusXp += selfCareBonus;
			}
		}

		return Math.max(0, totalBonusXp);
	}

	private clamp0to10(value: number): number {
		return Math.max(0, Math.min(10, value));
	}

	private createJournalEntryId(): string {
		const randomPart = Math.random().toString(36).slice(2, 8);
		return `journal-${Date.now()}-${randomPart}`;
	}

	getCurrentLocalTime(): string {
		const now = new Date();
		const hours = String(now.getHours()).padStart(2, '0');
		const minutes = String(now.getMinutes()).padStart(2, '0');
		return `${hours}:${minutes}`;
	}

	isValidTime(value: string): boolean {
		return /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
	}

	private toIsoTimestamp(date: string, time: string): string {
		const normalizedTime = this.isValidTime(time)
			? time
			: this.getCurrentLocalTime();
		const local = new Date(`${date}T${normalizedTime}:00`);
		if (Number.isNaN(local.getTime())) {
			return new Date().toISOString();
		}
		return local.toISOString();
	}

	getLocalTimeFromTimestamp(timestamp: string): string {
		const parsed = new Date(timestamp);
		if (Number.isNaN(parsed.getTime())) {
			return this.getCurrentLocalTime();
		}
		const hours = String(parsed.getHours()).padStart(2, '0');
		const minutes = String(parsed.getMinutes()).padStart(2, '0');
		return `${hours}:${minutes}`;
	}

	async addJournalEntry(input: JournalEntryDraft): Promise<JournalEntry> {
		const date = input.date ?? this.getTodayDateKey();
		const time = input.time ?? this.getCurrentLocalTime();
		const day = this.getOrCreateDailyRecord(date);
		const timestamp = this.toIsoTimestamp(date, time);
		const nowIso = new Date().toISOString();
		const entry: JournalEntry = {
			id: this.createJournalEntryId(),
			date,
			timestamp,
			moodScore: this.clamp0to10(input.moodScore),
			moodSelections: input.moodSelections,
			painScore: this.clamp0to10(input.painScore),
			painAreaIds: input.painAreaIds,
			note: input.note?.trim() ? input.note.trim() : undefined,
		};

		this.settings.journal[entry.id] = entry;
		day.journalEntryIds.push(entry.id);
		day.updatedAt = nowIso;
		this.updateDailyMoodPainSummary(date);
		await this.saveSettings();
		this.refreshStatusBar();
		return entry;
	}

	getJournalEntriesForDate(date: string): JournalEntry[] {
		const day = this.settings.daily[date];
		if (!day) {
			return [];
		}

		return day.journalEntryIds
			.map((entryId) => this.settings.journal[entryId])
			.filter((entry): entry is JournalEntry => Boolean(entry))
			.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
	}

	async updateJournalEntry(
		entryId: string,
		input: JournalEntryDraft,
	): Promise<JournalEntry | null> {
		const existing = this.settings.journal[entryId];
		if (!existing) {
			return null;
		}

		const targetDate = input.date ?? existing.date;
		const targetTime =
			input.time ?? this.getLocalTimeFromTimestamp(existing.timestamp);
		const sourceDate = existing.date;

		const updated: JournalEntry = {
			...existing,
			date: targetDate,
			timestamp: this.toIsoTimestamp(targetDate, targetTime),
			moodScore: this.clamp0to10(input.moodScore),
			moodSelections: input.moodSelections,
			painScore: this.clamp0to10(input.painScore),
			painAreaIds: input.painAreaIds,
			note: input.note?.trim() ? input.note.trim() : undefined,
		};

		if (sourceDate !== targetDate) {
			const oldDay = this.settings.daily[sourceDate];
			if (oldDay) {
				oldDay.journalEntryIds = oldDay.journalEntryIds.filter((id) => id !== entryId);
				oldDay.updatedAt = new Date().toISOString();
				this.updateDailyMoodPainSummary(sourceDate);
			}

			const newDay = this.getOrCreateDailyRecord(targetDate);
			if (!newDay.journalEntryIds.includes(entryId)) {
				newDay.journalEntryIds.push(entryId);
			}
			newDay.updatedAt = new Date().toISOString();
			this.updateDailyMoodPainSummary(targetDate);
		} else {
			const sameDay = this.getOrCreateDailyRecord(targetDate);
			sameDay.updatedAt = new Date().toISOString();
			this.updateDailyMoodPainSummary(targetDate);
		}

		this.settings.journal[entryId] = updated;
		await this.saveSettings();
		this.refreshStatusBar();
		return updated;
	}

	async deleteJournalEntry(entryId: string): Promise<boolean> {
		const existing = this.settings.journal[entryId];
		if (!existing) {
			return false;
		}

		const day = this.settings.daily[existing.date];
		if (day) {
			day.journalEntryIds = day.journalEntryIds.filter((id) => id !== entryId);
			day.updatedAt = new Date().toISOString();
			this.updateDailyMoodPainSummary(existing.date);
		}

		delete this.settings.journal[entryId];
		await this.saveSettings();
		this.refreshStatusBar();
		return true;
	}

	updateDailyMoodPainSummary(date: string): void {
		const day = this.getOrCreateDailyRecord(date);
		const entries = day.journalEntryIds
			.map((entryId) => this.settings.journal[entryId])
			.filter((entry): entry is JournalEntry => Boolean(entry));

		if (entries.length === 0) {
			day.moodSummary = undefined;
			return;
		}

		const moodScoreAvg =
			entries.reduce((sum, entry) => sum + entry.moodScore, 0) / entries.length;
		const painScoreAvg =
			entries.reduce((sum, entry) => sum + entry.painScore, 0) / entries.length;

		const moodFrequency = new Map<string, number>();
		for (const entry of entries) {
			for (const selection of entry.moodSelections) {
				moodFrequency.set(
					selection.moodId,
					(moodFrequency.get(selection.moodId) ?? 0) + 1,
				);
			}
		}

		const dominantMoodIds = [...moodFrequency.entries()]
			.sort((a, b) => b[1] - a[1])
			.slice(0, 3)
			.map(([moodId]) => moodId);

		const painAreaFrequency = new Map<string, number>();
		for (const entry of entries) {
			for (const painAreaId of entry.painAreaIds) {
				painAreaFrequency.set(
					painAreaId,
					(painAreaFrequency.get(painAreaId) ?? 0) + 1,
				);
			}
		}

		const worstPainAreaIds = [...painAreaFrequency.entries()]
			.sort((a, b) => b[1] - a[1])
			.slice(0, 3)
			.map(([areaId]) => areaId);

		day.moodSummary = {
			avgMoodScore: Math.round(moodScoreAvg * 10) / 10,
			avgPainScore: Math.round(painScoreAvg * 10) / 10,
			dominantMoodIds,
			worstPainAreaIds,
		};
	}

	private createItemId(): string {
		const randomPart = Math.random().toString(36).slice(2, 8);
		return `item-${Date.now()}-${randomPart}`;
	}

	private openCreateItemModal(): void {
		new ItemFormModal(this.app, {
			title: 'Add task or habit',
			submitLabel: 'Create',
			onSubmit: async (draft) => {
				const created = await this.createItem(draft);
				const recurrenceLabel = formatRecurrenceSummary(created.recurrence);
				new Notice(
					`Created ${ITEM_TYPE_LABELS[created.type].toLowerCase()}: ${created.title} (${recurrenceLabel})`,
				);
			},
		}).open();
	}

	private openEditItemPicker(): void {
		const items = this.getAllItems();
		if (items.length === 0) {
			new Notice('No items to edit yet. Add a task or habit first.');
			return;
		}

		new ItemPickerModal(this.app, items, 'Select item to edit', (item) => {
			this.openEditItemModal(item);
		}).open();
	}

	private openEditItemModal(item: TrackableItem): void {
		new ItemFormModal(this.app, {
			title: `Edit ${item.title}`,
			submitLabel: 'Save',
			initial: {
				title: item.title,
				type: item.type,
				spoonCost: item.spoonCost,
				spoonRecovery: item.spoonRecovery,
				priority: item.priority,
				isSelfCare: Boolean(item.isSelfCare),
				recurrence: item.recurrence,
				notes: item.notes,
				tags: item.tags,
			},
			onSubmit: async (draft) => {
				const updated = await this.updateItem(item.id, draft);
				if (!updated) {
					new Notice('Item no longer exists.');
					return;
				}
				new Notice(
					`Updated item: ${updated.title} (${formatRecurrenceSummary(updated.recurrence)})`,
				);
			},
		}).open();
	}

	openEditItemFromDashboard(itemId: string): void {
		const item = this.settings.items[itemId];
		if (!item) {
			new Notice('Item no longer exists.');
			return;
		}
		this.openEditItemModal(item);
	}

	private openArchiveItemPicker(): void {
		const activeItems = this.getActiveItems();
		if (activeItems.length === 0) {
			new Notice('No active items to archive.');
			return;
		}

		new ItemPickerModal(
			this.app,
			activeItems,
			'Select active item to archive',
			async (item) => {
				const archived = await this.archiveItem(item.id);
				if (!archived) {
					new Notice('Item no longer exists.');
					return;
				}
				new Notice(`Archived item: ${archived.title}`);
			},
		).open();
	}

	private showActiveItemsSummary(): void {
		const activeItems = this.getActiveItems();
		if (activeItems.length === 0) {
			new Notice('No active items yet.');
			return;
		}
		const dueToday = this.getDueItemsForDate(this.getTodayDateKey());

		const highPriorityCount = activeItems.filter(
			(item) => item.priority === 'high' || item.priority === 'critical',
		).length;
		new Notice(
			`Active items: ${activeItems.length}, due today: ${dueToday.length} (${highPriorityCount} high/critical).`,
		);
	}

	refreshStatusBar(): void {
		if (!this.statusBarItemEl) {
			return;
		}

		const spoonsLeft = this.getSpoonsLeftForToday();
		const spoonLabel = Math.abs(spoonsLeft) === 1 ? 'spoon' : 'spoons';
		this.statusBarItemEl.setText(`${spoonsLeft} ${spoonLabel} left`);
	}

	private refreshOpenDashboardViews(): void {
		const leaves = this.app.workspace.getLeavesOfType(DASHBOARD_VIEW_TYPE);
		for (const leaf of leaves) {
			const view = leaf.view;
			if (view instanceof DashboardView) {
				view.refresh();
			}
		}
	}

	private openDailySetupModal(date?: string): void {
		new DailySetupModal(this.app, this, date ?? this.getTodayDateKey()).open();
	}

	openDailySetupFromDashboard(date: string): void {
		this.openDailySetupModal(date);
	}

	private openCompleteItemPicker(date: string): void {
		const day = this.getOrCreateDailyRecord(date);
		const dueItems = this.getDueItemsForDate(day.date).filter(
			(item) => !day.completedItemIds.includes(item.id),
		);
		if (dueItems.length === 0) {
			new Notice(`No due items available for ${day.date}.`);
			return;
		}

		new ItemPickerModal(
			this.app,
			dueItems,
			`Select item to complete for ${day.date}`,
			async (item) => {
				const result = await this.completeItemForDate(item.id, day.date);
				if (result === null) {
					new Notice('Item no longer exists or is archived.');
					return;
				}
				if (result.xpAwarded === 0) {
					new Notice(`${item.title} is already completed for ${day.date}.`);
					return;
				}
				const noSpoonsLabel = result.usedNoSpoonsBonus
					? ` no-spoons bonus x${this.settings.config.noSpoonsXpMultiplier}.`
					: '';
				const recoveryLabel =
					result.spoonsRecovered > 0
						? ` +${result.spoonsRecovered} spoon(s) restored.`
						: '';
				new Notice(
					`Completed ${item.title} on ${day.date}: +${result.xpAwarded} XP (total ${this.settings.profile.totalXp}).${noSpoonsLabel}${recoveryLabel}`,
				);
			},
		).open();
	}

	openCompleteItemFromDashboard(): void {
		this.openCompleteItemPicker(this.getTodayDateKey());
	}

	openCompleteItemFromDashboardDate(date: string): void {
		this.openCompleteItemPicker(date);
	}

	private openUncompleteItemPicker(date: string): void {
		const day = this.getOrCreateDailyRecord(date);
		const completedItems = day.completedItemIds
			.map((id) => this.settings.items[id])
			.filter((item): item is TrackableItem => Boolean(item));

		if (completedItems.length === 0) {
			new Notice(`No completed items for ${day.date}.`);
			return;
		}

		new ItemPickerModal(
			this.app,
			completedItems,
			`Select completed item to undo for ${day.date}`,
			async (item) => {
				const xpRemoved = await this.uncompleteItemForDate(item.id, day.date);
				if (xpRemoved === null) {
					new Notice('Item no longer exists.');
					return;
				}
				if (xpRemoved === 0) {
					new Notice(`${item.title} is not marked complete for ${day.date}.`);
					return;
				}
				new Notice(
					`Uncompleted ${item.title} on ${day.date}: -${xpRemoved} XP (total ${this.settings.profile.totalXp}).`,
				);
			},
		).open();
	}

	openUncompleteItemFromDashboard(): void {
		this.openUncompleteItemPicker(this.getTodayDateKey());
	}

	openUncompleteItemFromDashboardDate(date: string): void {
		this.openUncompleteItemPicker(date);
	}

	private openSkipItemPicker(date: string): void {
		const day = this.getOrCreateDailyRecord(date);
		const dueItems = this.getDueItemsForDate(day.date).filter(
			(item) => !day.completedItemIds.includes(item.id),
		);

		if (dueItems.length === 0) {
			new Notice(`No due items available to skip for ${day.date}.`);
			return;
		}

		new ItemPickerModal(
			this.app,
			dueItems,
			`Select due item to skip from ${day.date} to next day`,
			async (item) => {
				const tomorrow = await this.skipItemForDateToNextDay(item.id, day.date);
				if (!tomorrow) {
					new Notice('Unable to skip this item right now.');
					return;
				}
				new Notice(`Skipped ${item.title} until ${tomorrow}.`);
			},
		).open();
	}

	openSkipItemFromDashboard(): void {
		this.openSkipItemPicker(this.getTodayDateKey());
	}

	openSkipItemFromDashboardDate(date: string): void {
		this.openSkipItemPicker(date);
	}

	private showTodaySummary(): void {
		const today = this.getTodayRecord();
		const completed = today.completedItemIds.length;
		const activityCount = (today.activities ?? []).length;
		const activityNet = this.getActivityNetSpoonsForDate(today.date);
		const flareLabel = today.flareDay ? 'flare day' : 'non-flare day';
		const freezeLabel = today.useFreezeToday ? 'freeze enabled' : 'freeze disabled';
		const profile = this.settings.profile;
		new Notice(
			`Today: ${today.availableSpoons} spoons, ${completed} completed, ${activityCount} activities (net ${activityNet >= 0 ? '+' : ''}${activityNet} spoons), ${today.xpEarned} XP, ${flareLabel}, ${freezeLabel}, streak ${profile.currentStreak}, freezes ${profile.freezeTokens}.`,
		);
	}

	private openAddActivityModalForDate(date: string): void {
		new ActivityFormModal(this.app, {
			targetDate: date,
			onSubmit: async (draft) => {
				const activity = await this.addActivityForDate(date, draft);
				const sign = activity.spoonDelta >= 0 ? '+' : '';
				new Notice(
					`Logged activity for ${date}: ${activity.title} (${sign}${activity.spoonDelta} spoons).`,
				);
			},
		}).open();
	}

	openAddActivityFromDashboardDate(date: string): void {
		this.openAddActivityModalForDate(date);
	}

	private showDayCloseResult(result: DayCloseResult): void {
		if (result.streakCounted) {
			const freezeBonus = result.freezeAwarded ? ' +1 freeze earned.' : '';
			new Notice(
				`Finalized ${result.date}: streak ${result.streakBefore} -> ${result.streakAfter}.${freezeBonus}`,
			);
			return;
		}

		if (result.freezeUsed) {
			const bonusLabel =
				result.bonusXpAwarded > 0
					? ` +${result.bonusXpAwarded} bonus XP.`
					: '';
			new Notice(
				`Finalized ${result.date}: flare freeze used, streak preserved at ${result.streakAfter}.${bonusLabel}`,
			);
			return;
		}

		new Notice(`Finalized ${result.date}: streak reset to ${result.streakAfter}.`);
	}

	private showStreakStatus(): void {
		const profile = this.settings.profile;
		new Notice(
			`Streak ${profile.currentStreak} (best ${profile.longestStreak}) | freezes ${profile.freezeTokens} | progress to next freeze ${profile.streakDaysTowardNextFreeze}/${this.settings.config.daysPerFreezeReward}.`,
		);
	}

	private async applyBlueprintJournalCatalogs(): Promise<void> {
		this.settings.moodCatalog = getDefaultMoodCatalog();
		this.settings.painAreasCatalog = getDefaultPainAreasCatalog();
		await this.saveSettings();
		new Notice(
			`Applied blueprint catalogs: ${this.settings.moodCatalog.length} moods and ${this.settings.painAreasCatalog.length} pain areas.`,
		);
	}

	private openJournalEntryModal(date?: string): void {
		new JournalEntryFormModal(this.app, this, {
			title: 'Add journal entry',
			submitLabel: 'Save',
			initial: date ? { date } : undefined,
			onSubmit: async (draft) => {
				const entry = await this.addJournalEntry(draft);
				new Notice(`Journal entry saved at ${entry.timestamp}.`);
			},
		}).open();
	}

	openJournalEntryFromDashboard(): void {
		this.openJournalEntryModal(this.getTodayDateKey());
	}

	openJournalEntryFromDashboardDate(date: string): void {
		this.openJournalEntryModal(date);
	}

	openCreateItemFromDashboard(): void {
		this.openCreateItemModal();
	}

	private openJournalHistoryModal(): void {
		new JournalHistoryModal(this.app, this).open();
	}

	openJournalHistoryFromDashboard(): void {
		this.openJournalHistoryModal();
	}

	getTodayJournalEntries(): JournalEntry[] {
		return this.getJournalEntriesForDate(this.getTodayDateKey());
	}

	private openDashboardModal(): void {
		new DashboardModal(this.app, this).open();
	}

	private async openDashboardInMainView(): Promise<void> {
		const leaf = this.app.workspace.getLeaf(true);
		await leaf.setViewState({ type: DASHBOARD_VIEW_TYPE, active: true });
		this.app.workspace.revealLeaf(leaf);
	}

	private async openDashboardInSidebar(): Promise<void> {
		const leaf =
			this.app.workspace.getRightLeaf(false) ??
			this.app.workspace.getRightLeaf(true);
		if (!leaf) {
			new Notice('Unable to open sidebar dashboard right now.');
			return;
		}

		await leaf.setViewState({ type: DASHBOARD_VIEW_TYPE, active: true });
		this.app.workspace.revealLeaf(leaf);
	}

	private showTodayJournalSummary(): void {
		const today = this.getTodayRecord();
		const entries = today.journalEntryIds
			.map((entryId) => this.settings.journal[entryId])
			.filter((entry): entry is JournalEntry => Boolean(entry));

		if (entries.length === 0) {
			new Notice('No journal entries for today yet.');
			return;
		}

		const summary = today.moodSummary;
		if (!summary) {
			new Notice(`Today has ${entries.length} journal entries.`);
			return;
		}

		const moodLabels = (summary.dominantMoodIds ?? [])
			.map((moodId) =>
				this.settings.moodCatalog.find((mood) => mood.id === moodId),
			)
			.filter((mood): mood is NonNullable<typeof mood> => Boolean(mood))
			.map((mood) => `${mood.emoji} ${mood.label}`)
			.join(', ');

		new Notice(
			`Journal today: ${entries.length} entries | avg mood ${summary.avgMoodScore ?? '-'} | avg pain ${summary.avgPainScore ?? '-'}${moodLabels ? ` | top moods ${moodLabels}` : ''}.`,
		);
	}

	private openInsertChartBlockModal(): void {
		new ChartBlockInsertModal(this.app, async (query) => {
			const inserted = await this.insertChartBlockInActiveNote(query);
			if (inserted) {
				new Notice('Inserted chart block into note.');
			}
		}).open();
	}

	private openInsertJournalBlockModal(): void {
		new JournalBlockInsertModal(this.app, async (query) => {
			const inserted = await this.insertJournalBlockInActiveNote(query);
			if (inserted) {
				new Notice('Inserted journal block into note.');
			}
		}).open();
	}

	private async insertChartBlockInActiveNote(query: ChartQuery): Promise<boolean> {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view) {
			new Notice('Open a Markdown note first to insert a chart block.');
			return false;
		}

		const lines = ['```spoonie-chart'];
		lines.push(`metric: ${query.metric}`);
		if (query.fromDate && query.toDate) {
			lines.push(`from: ${query.fromDate}`);
			lines.push(`to: ${query.toDate}`);
		} else {
			lines.push(`range: ${query.range}`);
		}
		if (query.title?.trim()) {
			lines.push(`title: ${query.title.trim()}`);
		}
		lines.push('```');

		const block = `\n${lines.join('\n')}\n`;
		view.editor.replaceSelection(block);
		return true;
	}

	private async insertJournalBlockInActiveNote(
		query: JournalBlockQuery,
	): Promise<boolean> {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view) {
			new Notice('Open a Markdown note first to insert a journal block.');
			return false;
		}

		const lines = ['```spoonie-journal'];
		if (query.fromDate && query.toDate) {
			lines.push(`from: ${query.fromDate}`);
			lines.push(`to: ${query.toDate}`);
		} else {
			lines.push(`range: ${query.range}`);
		}
		if (query.limit && query.limit > 0) {
			lines.push(`limit: ${query.limit}`);
		}
		lines.push(`order: ${query.order}`);
		if (query.title?.trim()) {
			lines.push(`title: ${query.title.trim()}`);
		}
		lines.push('```');

		const block = `\n${lines.join('\n')}\n`;
		view.editor.replaceSelection(block);
		return true;
	}

	private renderChartBlock(
		source: string,
		containerEl: HTMLElement,
		sourcePath?: string,
	): void {
		const query = this.parseChartQuery(source);
		const data = this.buildChartData(query);
		containerEl.empty();

		const card = containerEl.createDiv({ cls: 'spoonie-chart-card' });
		const title =
			query.title?.trim() ||
			`${query.metric === 'both' ? 'Mood and Pain' : query.metric === 'mood' ? 'Mood' : 'Pain'} trend`;
		card.createEl('h4', { text: title, cls: 'spoonie-chart-title' });

		const subtitle = card.createEl('p', { cls: 'spoonie-chart-subtitle' });
		subtitle.setText(this.describeChartWindow(query, data));

		if (data.length === 0) {
			card.createEl('p', {
				cls: 'spoonie-chart-empty',
				text: 'No mood/pain data found for this query.',
			});
			return;
		}

		const svgMarkup = this.buildChartSvg(query, data);
		const frame = card.createDiv({ cls: 'spoonie-chart-frame' });
		frame.innerHTML = svgMarkup;
		this.attachChartPointTooltips(frame);

		const actions = card.createDiv({ cls: 'spoonie-chart-actions' });
		const exportButton = actions.createEl('button', {
			cls: 'mod-cta spoonie-chart-export-btn',
			text: 'Export PNG Attachment',
		});
		exportButton.type = 'button';
		exportButton.addEventListener('click', async () => {
			exportButton.disabled = true;
			try {
				await this.exportChartAsPngAttachment(query, frame, sourcePath);
			} finally {
				exportButton.disabled = false;
			}
		});

		const legend = card.createDiv({ cls: 'spoonie-chart-legend' });
		if (query.metric === 'mood' || query.metric === 'both') {
			legend.createDiv({
				cls: 'spoonie-chart-legend-item mood',
				text: 'Mood',
			});
		}
		if (query.metric === 'pain' || query.metric === 'both') {
			legend.createDiv({
				cls: 'spoonie-chart-legend-item pain',
				text: 'Pain',
			});
		}
	}

	private renderJournalBlock(source: string, containerEl: HTMLElement): void {
		const query = this.parseJournalBlockQuery(source);
		const entries = this.buildJournalBlockEntries(query);
		containerEl.empty();

		const card = containerEl.createDiv({ cls: 'spoonie-chart-card spoonie-journal-block-card' });
		card.createEl('h4', {
			text: query.title?.trim() || 'Journal entries',
			cls: 'spoonie-chart-title',
		});

		const subtitle = card.createEl('p', { cls: 'spoonie-chart-subtitle' });
		subtitle.setText(this.describeJournalWindow(query, entries));

		if (entries.length === 0) {
			card.createEl('p', {
				cls: 'spoonie-chart-empty',
				text: 'No journal entries found for this query.',
			});
			return;
		}

		const list = card.createDiv({ cls: 'spoonie-journal-block-list' });
		for (const entry of entries) {
			const entryEl = list.createDiv({ cls: 'spoonie-journal-block-entry' });
			const header = entryEl.createDiv({ cls: 'spoonie-journal-block-header' });
			header.createEl('strong', { text: entry.date });
			header.createEl('span', {
				cls: 'spoonie-journal-block-time',
				text: this.getLocalTimeFromTimestamp(entry.timestamp),
			});

			entryEl.createEl('p', {
				cls: 'spoonie-journal-block-scores',
				text: `Mood ${entry.moodScore}/10 | Pain ${entry.painScore}/10`,
			});

			const moodLabels = this.getMoodSelectionLabels(entry.moodSelections);
			if (moodLabels.length > 0) {
				entryEl.createEl('p', {
					cls: 'spoonie-journal-block-meta',
					text: `Moods: ${moodLabels.join(', ')}`,
				});
			}

			const painLabels = this.getPainAreaLabels(entry.painAreaIds);
			if (painLabels.length > 0) {
				entryEl.createEl('p', {
					cls: 'spoonie-journal-block-meta',
					text: `Pain areas: ${painLabels.join(', ')}`,
				});
			}

			entryEl.createEl('p', {
				cls: 'spoonie-journal-block-note',
				text: entry.note?.trim() || 'No note.',
			});
		}
	}

	private attachChartPointTooltips(frame: HTMLElement): void {
		const points = frame.querySelectorAll<SVGCircleElement>('.spoonie-chart-point');
		if (points.length === 0) {
			return;
		}

		const tooltip = frame.createDiv({ cls: 'spoonie-chart-tooltip' });
		tooltip.style.display = 'none';

		const hideTooltip = (): void => {
			tooltip.style.display = 'none';
		};

		points.forEach((point) => {
			const showTooltip = (event: MouseEvent): void => {
				const metric = point.dataset.metric ?? 'metric';
				const date = point.dataset.date ?? '';
				const value = point.dataset.value ?? '';
				tooltip.textContent = `${metric}: ${value} (${date})`;
				tooltip.style.display = 'block';

				const frameRect = frame.getBoundingClientRect();
				const x = event.clientX - frameRect.left + 10;
				const y = event.clientY - frameRect.top - 10;
				tooltip.style.left = `${x}px`;
				tooltip.style.top = `${y}px`;
			};

			point.addEventListener('mouseenter', showTooltip);
			point.addEventListener('mousemove', showTooltip);
			point.addEventListener('mouseleave', hideTooltip);
		});

		frame.addEventListener('mouseleave', hideTooltip);
	}

	private async exportChartAsPngAttachment(
		query: ChartQuery,
		frame: HTMLElement,
		sourcePath?: string,
	): Promise<void> {
		const svgEl = frame.querySelector('svg');
		if (!svgEl) {
			new Notice('Chart export failed: missing SVG content.');
			return;
		}

		const noteFile = sourcePath
			? this.app.vault.getAbstractFileByPath(sourcePath)
			: this.app.workspace.getActiveFile();
		if (!(noteFile instanceof TFile)) {
			new Notice('Chart export failed: note file not found.');
			return;
		}

		const svgText = new XMLSerializer().serializeToString(svgEl);
		const blob = new Blob([svgText], {
			type: 'image/svg+xml;charset=utf-8',
		});
		const url = URL.createObjectURL(blob);

		try {
			const image = await this.loadImageFromUrl(url);
			const pngData = await this.renderPngFromImage(image, 2);
			const attachmentPath = await this.getAvailableChartAttachmentPath(
				noteFile,
				query.title,
			);
			await this.app.vault.createBinary(attachmentPath, pngData);
			new Notice(`Chart exported: ${attachmentPath}`);
		} catch (error) {
			console.error('Spoonie chart export failed', error);
			new Notice('Chart export failed. See console for details.');
		} finally {
			URL.revokeObjectURL(url);
		}
	}

	private loadImageFromUrl(url: string): Promise<HTMLImageElement> {
		return new Promise((resolve, reject) => {
			const image = new Image();
			image.onload = () => resolve(image);
			image.onerror = () => reject(new Error('Unable to load chart SVG for export.'));
			image.src = url;
		});
	}

	private renderPngFromImage(
		image: HTMLImageElement,
		scale: number,
	): Promise<ArrayBuffer> {
		const width = Math.max(1, Math.round(image.width * scale));
		const height = Math.max(1, Math.round(image.height * scale));
		const canvas = document.createElement('canvas');
		canvas.width = width;
		canvas.height = height;
		const context = canvas.getContext('2d');
		if (!context) {
			return Promise.reject(new Error('Unable to create canvas context.'));
		}

		context.scale(scale, scale);
		context.drawImage(image, 0, 0);

		return new Promise((resolve, reject) => {
			canvas.toBlob(async (blob) => {
				if (!blob) {
					reject(new Error('Unable to encode PNG chart image.'));
					return;
				}
				resolve(await blob.arrayBuffer());
			}, 'image/png');
		});
	}

	private async getAvailableChartAttachmentPath(
		noteFile: TFile,
		title?: string,
	): Promise<string> {
		const parentPath = noteFile.parent?.path ?? '';
		const titleSlug = (title ?? 'chart')
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-+|-+$/g, '')
			.slice(0, 40);
		const baseName = titleSlug.length > 0 ? titleSlug : 'chart';
		const stamp = this.getTodayDateKey();
		let fileName = `spoonie-${baseName}-${stamp}.png`;
		let attachmentPath = parentPath ? `${parentPath}/${fileName}` : fileName;
		let index = 1;

		while (this.app.vault.getAbstractFileByPath(attachmentPath)) {
			fileName = `spoonie-${baseName}-${stamp}-${index}.png`;
			attachmentPath = parentPath ? `${parentPath}/${fileName}` : fileName;
			index += 1;
		}

		return attachmentPath;
	}

	private parseSimpleKeyValueBlock(source: string): Record<string, string> {
		const values: Record<string, string> = {};
		for (const rawLine of source.split(/\r?\n/)) {
			const line = rawLine.trim();
			if (!line || !line.includes(':')) {
				continue;
			}

			const separator = line.indexOf(':');
			const key = line.slice(0, separator).trim().toLowerCase();
			const value = line.slice(separator + 1).trim();
			if (!value) {
				continue;
			}

			values[key] = value;
		}

		return values;
	}

	private parseChartQuery(source: string): ChartQuery {
		const query: ChartQuery = {
			metric: 'both',
			range: '30d',
		};

		const values = this.parseSimpleKeyValueBlock(source);
		for (const [key, value] of Object.entries(values)) {

			if (key === 'metric') {
				const metric = value.toLowerCase();
				if (metric === 'mood' || metric === 'pain' || metric === 'both') {
					query.metric = metric;
				}
				continue;
			}

			if (key === 'range') {
				query.range = value.toLowerCase();
				continue;
			}

			if (key === 'from' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
				query.fromDate = value;
				continue;
			}

			if (key === 'to' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
				query.toDate = value;
				continue;
			}

			if (key === 'title') {
				query.title = value;
			}
		}

		if (!CHART_RANGE_OPTIONS.includes(query.range)) {
			query.range = '30d';
		}

		return query;
	}

	private parseJournalBlockQuery(source: string): JournalBlockQuery {
		const query: JournalBlockQuery = {
			range: '30d',
			limit: 10,
			order: 'desc',
		};

		const values = this.parseSimpleKeyValueBlock(source);
		for (const [key, value] of Object.entries(values)) {
			if (key === 'range') {
				query.range = value.toLowerCase();
				continue;
			}

			if (key === 'from' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
				query.fromDate = value;
				continue;
			}

			if (key === 'to' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
				query.toDate = value;
				continue;
			}

			if (key === 'title') {
				query.title = value;
				continue;
			}

			if (key === 'limit') {
				const limit = Number.parseInt(value, 10);
				if (!Number.isNaN(limit) && limit > 0) {
					query.limit = limit;
				}
				continue;
			}

			if (key === 'order') {
				const order = value.toLowerCase();
				if (order === 'asc' || order === 'desc') {
					query.order = order;
				}
			}
		}

		if (!CHART_RANGE_OPTIONS.includes(query.range)) {
			query.range = '30d';
		}

		return query;
	}

	private buildChartData(query: ChartQuery): ChartDataPoint[] {
		const bounds = this.getChartDateBounds(query);
		const dates = Object.keys(this.settings.daily)
			.filter((date) => date >= bounds.startDate && date <= bounds.endDate)
			.sort((a, b) => a.localeCompare(b));

		const points: ChartDataPoint[] = [];
		for (const date of dates) {
			const day = this.settings.daily[date];
			if (!day) {
				continue;
			}

			const summary = day.moodSummary;
			let mood = summary?.avgMoodScore;
			let pain = summary?.avgPainScore;

			if (mood === undefined || pain === undefined) {
				const entries = day.journalEntryIds
					.map((id) => this.settings.journal[id])
					.filter((entry): entry is JournalEntry => Boolean(entry));
				if (entries.length > 0) {
					if (mood === undefined) {
						mood =
							entries.reduce((sum, entry) => sum + entry.moodScore, 0) /
							entries.length;
					}
					if (pain === undefined) {
						pain =
							entries.reduce((sum, entry) => sum + entry.painScore, 0) /
							entries.length;
					}
				}
			}

			const point: ChartDataPoint = { date };
			if (typeof mood === 'number' && !Number.isNaN(mood)) {
				point.mood = Math.max(0, Math.min(10, mood));
			}
			if (typeof pain === 'number' && !Number.isNaN(pain)) {
				point.pain = Math.max(0, Math.min(10, pain));
			}

			if (
				(query.metric === 'mood' && point.mood !== undefined) ||
				(query.metric === 'pain' && point.pain !== undefined) ||
				(query.metric === 'both' && (point.mood !== undefined || point.pain !== undefined))
			) {
				points.push(point);
			}
		}

		return points;
	}

	private getChartDateBounds(query: ChartQuery): {
		startDate: string;
		endDate: string;
	} {
		const today = this.getTodayDateKey();
		if (query.fromDate && query.toDate) {
			return {
				startDate: query.fromDate <= query.toDate ? query.fromDate : query.toDate,
				endDate: query.toDate >= query.fromDate ? query.toDate : query.fromDate,
			};
		}

		if (query.range === 'all') {
			const allDates = Object.keys(this.settings.daily).sort((a, b) => a.localeCompare(b));
			return {
				startDate: allDates[0] ?? today,
				endDate: today,
			};
		}

		const days = Number.parseInt(query.range.replace('d', ''), 10);
		const safeDays = Number.isNaN(days) ? 30 : Math.max(1, days);
		return {
			startDate: this.getDateKeyWithOffset(today, -(safeDays - 1)),
			endDate: today,
		};
	}

	private getJournalDateBounds(query: JournalBlockQuery): {
		startDate: string;
		endDate: string;
	} {
		return this.getChartDateBounds({
			metric: 'both',
			range: query.range,
			fromDate: query.fromDate,
			toDate: query.toDate,
		});
	}

	private buildJournalBlockEntries(query: JournalBlockQuery): JournalEntry[] {
		const bounds = this.getJournalDateBounds(query);
		const entries = Object.values(this.settings.journal).filter(
			(entry) => entry.date >= bounds.startDate && entry.date <= bounds.endDate,
		);

		entries.sort((a, b) => {
			const byTime = a.timestamp.localeCompare(b.timestamp);
			return query.order === 'asc' ? byTime : -byTime;
		});

		return typeof query.limit === 'number' ? entries.slice(0, query.limit) : entries;
	}

	private describeChartWindow(query: ChartQuery, data: ChartDataPoint[]): string {
		if (data.length === 0) {
			if (query.fromDate && query.toDate) {
				return `${query.fromDate} to ${query.toDate}`;
			}
			return query.range === 'all' ? 'All time' : `Last ${query.range}`;
		}

		const start = data[0]?.date ?? '';
		const end = data[data.length - 1]?.date ?? '';
		const label = query.metric === 'both' ? 'Mood + Pain' : query.metric === 'mood' ? 'Mood' : 'Pain';
		return `${label} from ${start} to ${end}`;
	}

	private describeJournalWindow(
		query: JournalBlockQuery,
		entries: JournalEntry[],
	): string {
		if (entries.length === 0) {
			if (query.fromDate && query.toDate) {
				return `${query.fromDate} to ${query.toDate}`;
			}
			return query.range === 'all' ? 'All time' : `Last ${query.range}`;
		}

		const dates = entries.map((entry) => entry.date).sort((a, b) => a.localeCompare(b));
		const start = dates[0] ?? '';
		const end = dates[dates.length - 1] ?? '';
		const countLabel = `${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}`;
		return `${countLabel} from ${start} to ${end}`;
	}

	private getMoodSelectionLabels(selections: MoodSelection[]): string[] {
		return selections
			.map((selection) => {
				const mood = this.settings.moodCatalog.find(
					(candidate) => candidate.id === selection.moodId,
				);
				if (!mood) {
					return selection.moodId;
				}

				return `${mood.emoji} ${mood.label}`;
			})
			.filter((label) => label.length > 0);
	}

	private getPainAreaLabels(painAreaIds: string[]): string[] {
		return painAreaIds
			.map((painAreaId) => {
				const painArea = this.settings.painAreasCatalog.find(
					(candidate) => candidate.id === painAreaId,
				);
				return painArea?.label ?? painAreaId;
			})
			.filter((label) => label.length > 0);
	}

	private buildChartSvg(query: ChartQuery, points: ChartDataPoint[]): string {
		const width = 760;
		const height = 280;
		const marginLeft = 42;
		const marginRight = 18;
		const marginTop = 16;
		const marginBottom = 32;
		const chartW = width - marginLeft - marginRight;
		const chartH = height - marginTop - marginBottom;

		const xFor = (index: number): number => {
			if (points.length <= 1) {
				return marginLeft + chartW / 2;
			}
			return marginLeft + (index * chartW) / (points.length - 1);
		};
		const yFor = (score: number): number => {
			const clamped = Math.max(0, Math.min(10, score));
			return marginTop + chartH - (clamped / 10) * chartH;
		};

		const moodPath = this.buildMetricPath(points, 'mood', xFor, yFor);
		const painPath = this.buildMetricPath(points, 'pain', xFor, yFor);
		const moodPoints = this.buildMetricPointsMarkup(points, 'mood', xFor, yFor);
		const painPoints = this.buildMetricPointsMarkup(points, 'pain', xFor, yFor);

		const ticks = [0, 5, 10]
			.map((tick) => {
				const y = yFor(tick);
				return `<g><line x1="${marginLeft}" y1="${y}" x2="${width - marginRight}" y2="${y}" stroke="var(--background-modifier-border)" stroke-width="1" /><text x="${marginLeft - 8}" y="${y + 4}" text-anchor="end" fill="var(--text-muted)" font-size="11">${tick}</text></g>`;
			})
			.join('');

		const startDate = points[0]?.date ?? '';
		const endDate = points[points.length - 1]?.date ?? '';
		const startX = xFor(0);
		const endX = xFor(points.length - 1);

		const moodLine =
			(query.metric === 'mood' || query.metric === 'both') && moodPath
				? `<path d="${moodPath}" fill="none" stroke="#22c55e" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" />`
				: '';
		const moodDots =
			query.metric === 'mood' || query.metric === 'both' ? moodPoints : '';
		const painLine =
			(query.metric === 'pain' || query.metric === 'both') && painPath
				? `<path d="${painPath}" fill="none" stroke="#ef4444" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" />`
				: '';
		const painDots =
			query.metric === 'pain' || query.metric === 'both' ? painPoints : '';

		return `<svg viewBox="0 0 ${width} ${height}" class="spoonie-chart-svg" role="img" aria-label="Mood and pain chart">
	<rect x="0" y="0" width="${width}" height="${height}" fill="var(--background-primary)" rx="10" ry="10" />
	${ticks}
	<line x1="${marginLeft}" y1="${marginTop + chartH}" x2="${width - marginRight}" y2="${marginTop + chartH}" stroke="var(--text-muted)" stroke-width="1.2" />
	<line x1="${marginLeft}" y1="${marginTop}" x2="${marginLeft}" y2="${marginTop + chartH}" stroke="var(--text-muted)" stroke-width="1.2" />
	${moodLine}
	${moodDots}
	${painLine}
	${painDots}
	<text x="${startX}" y="${height - 10}" fill="var(--text-muted)" font-size="11" text-anchor="start">${startDate}</text>
	<text x="${endX}" y="${height - 10}" fill="var(--text-muted)" font-size="11" text-anchor="end">${endDate}</text>
</svg>`;
	}

	private buildMetricPath(
		points: ChartDataPoint[],
		metric: 'mood' | 'pain',
		xFor: (index: number) => number,
		yFor: (score: number) => number,
	): string {
		const segments: string[] = [];
		let drawing = false;

		for (let index = 0; index < points.length; index += 1) {
			const value = metric === 'mood' ? points[index]?.mood : points[index]?.pain;
			if (value === undefined) {
				drawing = false;
				continue;
			}

			const x = xFor(index).toFixed(2);
			const y = yFor(value).toFixed(2);
			if (!drawing) {
				segments.push(`M ${x} ${y}`);
				drawing = true;
			} else {
				segments.push(`L ${x} ${y}`);
			}
		}

		return segments.join(' ');
	}

	private buildMetricPointsMarkup(
		points: ChartDataPoint[],
		metric: 'mood' | 'pain',
		xFor: (index: number) => number,
		yFor: (score: number) => number,
	): string {
		const color = metric === 'mood' ? '#22c55e' : '#ef4444';
		const labels: string[] = [];
		for (let index = 0; index < points.length; index += 1) {
			const point = points[index];
			const value = metric === 'mood' ? point?.mood : point?.pain;
			if (value === undefined || !point) {
				continue;
			}

			const x = xFor(index).toFixed(2);
			const y = yFor(value).toFixed(2);
			labels.push(
				`<circle class="spoonie-chart-point" cx="${x}" cy="${y}" r="3.6" fill="${color}" data-metric="${metric}" data-date="${point.date}" data-value="${value.toFixed(1)}" />`,
			);
		}

		return labels.join('');
	}
}

class ItemPickerModal extends FuzzySuggestModal<TrackableItem> {
	private readonly items: TrackableItem[];
	private readonly onPick: (item: TrackableItem) => void | Promise<void>;

	constructor(
		app: App,
		items: TrackableItem[],
		placeholder: string,
		onPick: (item: TrackableItem) => void | Promise<void>,
	) {
		super(app);
		this.items = items;
		this.onPick = onPick;
		this.setPlaceholder(placeholder);
	}

	getItems(): TrackableItem[] {
		return this.items;
	}

	getItemText(item: TrackableItem): string {
		const activeLabel = item.active ? 'active' : 'archived';
		const recurrenceLabel = formatRecurrenceSummary(item.recurrence);
		return `${item.title} (${ITEM_TYPE_LABELS[item.type]}, ${item.priority}, ${item.spoonCost} spoons, ${recurrenceLabel}, ${activeLabel})`;
	}

	onChooseItem(item: TrackableItem): void {
		void this.onPick(item);
	}
}

class ItemFormModal extends Modal {
	private readonly titleText: string;
	private readonly submitLabel: string;
	private readonly onSubmit: (draft: ItemDraft) => Promise<void>;
	private draft: ItemDraft;

	constructor(
		app: App,
		options: {
			title: string;
			submitLabel: string;
			onSubmit: (draft: ItemDraft) => Promise<void>;
			initial?: Partial<ItemDraft>;
		},
	) {
		super(app);
		this.titleText = options.title;
		this.submitLabel = options.submitLabel;
		this.onSubmit = options.onSubmit;
		const initialRecurrence = options.initial?.recurrence
			? {
					mode: options.initial.recurrence.mode,
					startDate: options.initial.recurrence.startDate,
					weekdays: options.initial.recurrence.weekdays
						? [...options.initial.recurrence.weekdays]
						: undefined,
					intervalDays: options.initial.recurrence.intervalDays,
					dayOfMonth: options.initial.recurrence.dayOfMonth,
			  }
			: { mode: 'always' as RecurrenceMode };
		this.draft = {
			title: options.initial?.title ?? '',
			type: options.initial?.type ?? 'task',
			spoonCost: options.initial?.spoonCost ?? 1,
			spoonRecovery: options.initial?.spoonRecovery ?? 0,
			priority: options.initial?.priority ?? 'medium',
			isSelfCare: options.initial?.isSelfCare ?? false,
			recurrence: initialRecurrence,
			notes: options.initial?.notes ?? '',
			tags: options.initial?.tags ?? [],
		};
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl('h2', { text: this.titleText });

		new Setting(contentEl)
			.setName('Title')
			.setDesc('Name your task or habit')
			.addText((text) =>
				text
					.setPlaceholder('Morning meds')
					.setValue(this.draft.title)
					.onChange((value) => {
						this.draft.title = value;
					}),
			);

		new Setting(contentEl)
			.setName('Type')
			.addDropdown((dropdown) => {
				dropdown
					.addOption('task', 'Task')
					.addOption('habit', 'Habit')
					.setValue(this.draft.type)
					.onChange((value) => {
						if (value === 'task' || value === 'habit') {
							this.draft.type = value;
						}
					});
			});

		new Setting(contentEl)
			.setName('Spoon cost')
			.setDesc('How many spoons this costs')
			.addText((text) =>
				text
					.setPlaceholder('1')
					.setValue(String(this.draft.spoonCost))
					.onChange((value) => {
						const parsed = Number.parseFloat(value);
						if (!Number.isNaN(parsed)) {
							this.draft.spoonCost = Math.max(1, Math.round(parsed));
						}
					}),
			);

		new Setting(contentEl)
			.setName('Spoons restored')
			.setDesc('Optional: spoons gained after completing this item (rest/pleasant events).')
			.addText((text) =>
				text
					.setPlaceholder('0')
					.setValue(String(this.draft.spoonRecovery))
					.onChange((value) => {
						const parsed = Number.parseFloat(value);
						if (!Number.isNaN(parsed)) {
							this.draft.spoonRecovery = Math.max(0, Math.round(parsed));
						}
					}),
			);

		new Setting(contentEl)
			.setName('Priority')
			.addDropdown((dropdown) => {
				dropdown
					.addOption('low', 'Low')
					.addOption('medium', 'Medium')
					.addOption('high', 'High')
					.addOption('critical', 'Critical')
					.setValue(this.draft.priority)
					.onChange((value) => {
						if (
							value === 'low' ||
							value === 'medium' ||
							value === 'high' ||
							value === 'critical'
						) {
							this.draft.priority = value;
						}
					});
			});

		new Setting(contentEl)
			.setName('Self-care/restful habit')
			.setDesc('Enable for habits like rest, hydration, or recovery activities.')
			.addToggle((toggle) =>
				toggle.setValue(this.draft.isSelfCare).onChange((value) => {
					this.draft.isSelfCare = value;
				}),
			);

		new Setting(contentEl)
			.setName('Recurrence')
			.setDesc('Choose how often this item should be due.')
			.addDropdown((dropdown) => {
				dropdown
					.addOption('always', 'Any day (manual cadence)')
					.addOption('daily', 'Every day')
					.addOption('weekly', 'Specific weekdays')
					.addOption('interval', 'Every N days')
					.addOption('monthly', 'Day of month')
					.setValue(this.draft.recurrence.mode)
					.onChange((value) => {
						if (
							value === 'always' ||
							value === 'daily' ||
							value === 'weekly' ||
							value === 'interval' ||
							value === 'monthly'
						) {
							this.draft.recurrence.mode = value;
							refreshRecurrenceControls();
						}
					});
			});

		let intervalInputEl: HTMLInputElement | null = null;
		let monthlyInputEl: HTMLInputElement | null = null;
		let weekdayChipsEl: HTMLElement | null = null;

		const refreshWeekdayChips = (): void => {
			if (!weekdayChipsEl) {
				return;
			}

			const selected = new Set(this.draft.recurrence.weekdays ?? []);
			const order = [1, 2, 3, 4, 5, 6, 0];
			weekdayChipsEl.empty();

			for (const weekday of order) {
				const chip = weekdayChipsEl.createEl('button', {
					cls: 'spoonie-chip spoonie-weekday-chip',
					text: WEEKDAY_LABELS[weekday],
				});
				chip.type = 'button';
				if (selected.has(weekday)) {
					chip.addClass('is-selected');
				}
				if (this.draft.recurrence.mode !== 'weekly') {
					chip.addClass('is-disabled');
					chip.disabled = true;
				}

				chip.addEventListener('click', () => {
					const weekdays = new Set(this.draft.recurrence.weekdays ?? []);
					if (weekdays.has(weekday)) {
						weekdays.delete(weekday);
					} else {
						weekdays.add(weekday);
					}

					this.draft.recurrence.weekdays = [...weekdays].sort((a, b) => a - b);
					refreshWeekdayChips();
				});
			}
		};

		const refreshRecurrenceControls = (): void => {
			if (intervalInputEl) {
				intervalInputEl.disabled = this.draft.recurrence.mode !== 'interval';
			}
			if (monthlyInputEl) {
				monthlyInputEl.disabled = this.draft.recurrence.mode !== 'monthly';
			}
			refreshWeekdayChips();
		};

		new Setting(contentEl)
			.setName('Recurrence start date')
			.setDesc('YYYY-MM-DD (optional, defaults to today)')
			.addText((text) =>
				text
					.setPlaceholder('2026-09-18')
					.setValue(this.draft.recurrence.startDate ?? '')
					.onChange((value) => {
						const trimmed = value.trim();
						this.draft.recurrence.startDate = /^\d{4}-\d{2}-\d{2}$/.test(trimmed)
							? trimmed
							: undefined;
					}),
			);

		const weeklySetting = new Setting(contentEl);
		weeklySetting
			.setName('Weekly weekdays')
			.setDesc('For weekly mode: tap one or more days');
		weekdayChipsEl = weeklySetting.controlEl.createDiv({
			cls: 'spoonie-chip-group spoonie-weekday-chip-group',
		});
		refreshWeekdayChips();

		new Setting(contentEl)
			.setName('Interval days')
			.setDesc('For interval mode: complete every N days')
			.addText((text) => {
				intervalInputEl = text.inputEl;
				text
					.setPlaceholder('2')
					.setValue(String(this.draft.recurrence.intervalDays ?? 1))
					.onChange((value) => {
						const parsed = Number.parseInt(value, 10);
						this.draft.recurrence.intervalDays = Number.isNaN(parsed)
							? 1
							: Math.max(1, parsed);
					});
			});

		new Setting(contentEl)
			.setName('Monthly day')
			.setDesc('For monthly mode: day of month (1-31)')
			.addText((text) => {
				monthlyInputEl = text.inputEl;
				text
					.setPlaceholder('15')
					.setValue(String(this.draft.recurrence.dayOfMonth ?? 1))
					.onChange((value) => {
						const parsed = Number.parseInt(value, 10);
						this.draft.recurrence.dayOfMonth = Number.isNaN(parsed)
							? 1
							: Math.max(1, Math.min(31, parsed));
					});
			});

		refreshRecurrenceControls();

		new Setting(contentEl)
			.setName('Tags')
			.setDesc('Comma-separated labels (optional)')
			.addText((text) =>
				text
					.setPlaceholder('health, admin')
					.setValue((this.draft.tags ?? []).join(', '))
					.onChange((value) => {
						this.draft.tags = value
							.split(',')
							.map((tag) => tag.trim())
							.filter((tag) => tag.length > 0);
					}),
			);

		new Setting(contentEl)
			.setName('Notes')
			.setDesc('Optional context for this item')
			.addTextArea((text) =>
				text.setValue(this.draft.notes ?? '').onChange((value) => {
					this.draft.notes = value;
				}),
			);

		new Setting(contentEl)
			.addButton((button) => {
				button.setButtonText(this.submitLabel).setCta().onClick(async () => {
					const trimmedTitle = this.draft.title.trim();
					if (!trimmedTitle) {
						new Notice('Title is required.');
						return;
					}

					this.draft.title = trimmedTitle;
					await this.onSubmit(this.draft);
					this.close();
				});
			})
			.addButton((button) => {
				button.setButtonText('Cancel').onClick(() => this.close());
			});
	}

	onClose(): void {
		this.contentEl.empty();
	}

}

class ChartBlockInsertModal extends Modal {
	private readonly onSubmit: (query: ChartQuery) => Promise<void>;
	private draft: ChartQuery;

	constructor(app: App, onSubmit: (query: ChartQuery) => Promise<void>) {
		super(app);
		this.onSubmit = onSubmit;
		this.draft = {
			metric: 'both',
			range: '30d',
			title: 'Mood and Pain Trend',
		};
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl('h2', { text: 'Insert mood/pain chart block' });

		new Setting(contentEl)
			.setName('Metric')
			.setDesc('Choose which score to chart.')
			.addDropdown((dropdown) => {
				dropdown
					.addOption('both', 'Mood + Pain')
					.addOption('mood', 'Mood only')
					.addOption('pain', 'Pain only')
					.setValue(this.draft.metric)
					.onChange((value) => {
						if (value === 'both' || value === 'mood' || value === 'pain') {
							this.draft.metric = value;
						}
					});
			});

		new Setting(contentEl)
			.setName('Range')
			.setDesc('Used when custom dates are not set.')
			.addDropdown((dropdown) => {
				for (const range of CHART_RANGE_OPTIONS) {
					dropdown.addOption(range, range === 'all' ? 'All time' : `Last ${range}`);
				}
				dropdown.setValue(this.draft.range).onChange((value) => {
					if (CHART_RANGE_OPTIONS.includes(value)) {
						this.draft.range = value;
					}
				});
			});

		new Setting(contentEl)
			.setName('From date')
			.setDesc('Optional YYYY-MM-DD. Set both from/to for custom range.')
			.addText((text) =>
				text
					.setPlaceholder('2026-01-01')
					.setValue(this.draft.fromDate ?? '')
					.onChange((value) => {
						const trimmed = value.trim();
						this.draft.fromDate = /^\d{4}-\d{2}-\d{2}$/.test(trimmed)
							? trimmed
							: undefined;
					}),
			);

		new Setting(contentEl)
			.setName('To date')
			.setDesc('Optional YYYY-MM-DD.')
			.addText((text) =>
				text
					.setPlaceholder('2026-09-18')
					.setValue(this.draft.toDate ?? '')
					.onChange((value) => {
						const trimmed = value.trim();
						this.draft.toDate = /^\d{4}-\d{2}-\d{2}$/.test(trimmed)
							? trimmed
							: undefined;
					}),
			);

		new Setting(contentEl)
			.setName('Chart title')
			.setDesc('Optional title shown above the chart.')
			.addText((text) =>
				text
					.setPlaceholder('Mood and Pain Trend')
					.setValue(this.draft.title ?? '')
					.onChange((value) => {
						this.draft.title = value;
					}),
			);

		new Setting(contentEl)
			.addButton((button) => {
				button.setButtonText('Insert').setCta().onClick(async () => {
					await this.onSubmit(this.draft);
					this.close();
				});
			})
			.addButton((button) => {
				button.setButtonText('Cancel').onClick(() => this.close());
			});
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

class JournalBlockInsertModal extends Modal {
	private readonly onSubmit: (query: JournalBlockQuery) => Promise<void>;
	private draft: JournalBlockQuery;

	constructor(app: App, onSubmit: (query: JournalBlockQuery) => Promise<void>) {
		super(app);
		this.onSubmit = onSubmit;
		this.draft = {
			range: '30d',
			limit: 10,
			order: 'desc',
			title: 'Journal Entries',
		};
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl('h2', { text: 'Insert journal block' });

		new Setting(contentEl)
			.setName('Range')
			.setDesc('Used when custom dates are not set.')
			.addDropdown((dropdown) => {
				for (const range of CHART_RANGE_OPTIONS) {
					dropdown.addOption(range, range === 'all' ? 'All time' : `Last ${range}`);
				}
				dropdown.setValue(this.draft.range).onChange((value) => {
					if (CHART_RANGE_OPTIONS.includes(value)) {
						this.draft.range = value;
					}
				});
			});

		new Setting(contentEl)
			.setName('From date')
			.setDesc('Optional YYYY-MM-DD. Set both from/to for custom range.')
			.addText((text) =>
				text
					.setPlaceholder('2026-01-01')
					.setValue(this.draft.fromDate ?? '')
					.onChange((value) => {
						const trimmed = value.trim();
						this.draft.fromDate = /^\d{4}-\d{2}-\d{2}$/.test(trimmed)
							? trimmed
							: undefined;
					}),
			);

		new Setting(contentEl)
			.setName('To date')
			.setDesc('Optional YYYY-MM-DD.')
			.addText((text) =>
				text
					.setPlaceholder('2026-09-19')
					.setValue(this.draft.toDate ?? '')
					.onChange((value) => {
						const trimmed = value.trim();
						this.draft.toDate = /^\d{4}-\d{2}-\d{2}$/.test(trimmed)
							? trimmed
							: undefined;
					}),
			);

		new Setting(contentEl)
			.setName('Limit')
			.setDesc('Maximum number of entries to show.')
			.addText((text) =>
				text
					.setPlaceholder('10')
					.setValue(String(this.draft.limit ?? 10))
					.onChange((value) => {
						const parsed = Number.parseInt(value, 10);
						if (!Number.isNaN(parsed) && parsed > 0) {
							this.draft.limit = parsed;
						}
					}),
			);

		new Setting(contentEl)
			.setName('Order')
			.setDesc('Choose whether to show oldest or newest entries first.')
			.addDropdown((dropdown) => {
				dropdown
					.addOption('desc', 'Newest first')
					.addOption('asc', 'Oldest first')
					.setValue(this.draft.order)
					.onChange((value) => {
						if (value === 'asc' || value === 'desc') {
							this.draft.order = value;
						}
					});
			});

		new Setting(contentEl)
			.setName('Block title')
			.setDesc('Optional title shown above the journal entries.')
			.addText((text) =>
				text
					.setPlaceholder('Journal Entries')
					.setValue(this.draft.title ?? '')
					.onChange((value) => {
						this.draft.title = value;
					}),
			);

		new Setting(contentEl)
			.addButton((button) => {
				button.setButtonText('Insert').setCta().onClick(async () => {
					await this.onSubmit(this.draft);
					this.close();
				});
			})
			.addButton((button) => {
				button.setButtonText('Cancel').onClick(() => this.close());
			});
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

class ActivityFormModal extends Modal {
	private readonly targetDate: string;
	private readonly onSubmit: (draft: ActivityDraft) => Promise<void>;
	private draft: ActivityDraft;

	constructor(
		app: App,
		options: {
			targetDate: string;
			onSubmit: (draft: ActivityDraft) => Promise<void>;
		},
	) {
		super(app);
		this.targetDate = options.targetDate;
		this.onSubmit = options.onSubmit;
		this.draft = {
			title: '',
			spoons: 1,
			isRestorative: false,
		};
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl('h2', { text: `Log activity (${this.targetDate})` });

		new Setting(contentEl)
			.setName('Activity title')
			.setDesc('Short label for what happened.')
			.addText((text) =>
				text
					.setPlaceholder('Walked to pharmacy')
					.setValue(this.draft.title)
					.onChange((value) => {
						this.draft.title = value;
					}),
			);

		new Setting(contentEl)
			.setName('Spoons amount')
			.setDesc('How many spoons this used or restored.')
			.addText((text) =>
				text
					.setPlaceholder('2')
					.setValue(String(this.draft.spoons))
					.onChange((value) => {
						const parsed = Number.parseFloat(value);
						if (!Number.isNaN(parsed)) {
							this.draft.spoons = Math.max(0, Math.round(parsed));
						}
					}),
			);

		new Setting(contentEl)
			.setName('Restorative activity')
			.setDesc('Enable if this gives spoons back instead of using them.')
			.addToggle((toggle) =>
				toggle.setValue(this.draft.isRestorative).onChange((value) => {
					this.draft.isRestorative = value;
				}),
			);

		new Setting(contentEl)
			.addButton((button) => {
				button.setButtonText('Log Activity').setCta().onClick(async () => {
					const title = this.draft.title.trim();
					if (!title) {
						new Notice('Activity title is required.');
						return;
					}
					if (this.draft.spoons <= 0) {
						new Notice('Spoons amount must be at least 1.');
						return;
					}

					this.draft.title = title;
					await this.onSubmit(this.draft);
					this.close();
				});
			})
			.addButton((button) => {
				button.setButtonText('Cancel').onClick(() => this.close());
			});
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

function renderDashboardContent(
	containerEl: HTMLElement,
	plugin: SpoonieLrpgPlugin,
	options: {
		dateKey: string;
		setDateKey: (dateKey: string) => void;
		closeLabel: string;
		onClose: () => void;
		rerender: () => void;
		closeBeforeNavigation: boolean;
	},
): void {
	containerEl.empty();
	containerEl.createEl('h2', { text: 'Spoonie Dashboard' });

	const realToday = plugin.getTodayDateKey();
	const dashboardDate = options.dateKey;
	const today = plugin.getOrCreateDailyRecord(dashboardDate);
	const profile = plugin.settings.profile;
	const spoonsLeft = plugin.getSpoonsLeftForDate(dashboardDate);
	const dueDebugEnabled = plugin.isDueDebugModeEnabled();
	const activeItems = plugin.getActiveItems();
	const dueItems = plugin
		.getDueItemsForDate(dashboardDate)
		.filter((item) => !today.completedItemIds.includes(item.id));
	const completedItems = today.completedItemIds
		.map((id) => plugin.settings.items[id])
		.filter((item): item is TrackableItem => Boolean(item));
	const journalEntries = plugin.getJournalEntriesForDate(dashboardDate);
	const activities = today.activities ?? [];
	const activityNetSpoons = plugin.getActivityNetSpoonsForDate(dashboardDate);

	const dateControls = containerEl.createDiv({ cls: 'spoonie-dashboard-date-controls' });
	dateControls.createEl('p', {
		cls: 'spoonie-dashboard-date-label',
		text: 'Dashboard day',
	});
	const dateControlsSetting = new Setting(dateControls);
	dateControlsSetting
		.addButton((button) => {
			button.setButtonText('Switch to Yesterday').onClick(() => {
				options.setDateKey(plugin.getDateKeyWithOffset(dashboardDate, -1));
				options.rerender();
			});
		})
		.addButton((button) => {
			button.setButtonText('Today').onClick(() => {
				options.setDateKey(realToday);
				options.rerender();
			});
		})
		.addButton((button) => {
			button.setButtonText('Switch to Tomorrow').onClick(() => {
				options.setDateKey(plugin.getDateKeyWithOffset(dashboardDate, 1));
				options.rerender();
			});
		})
		.addText((text) => {
			text.inputEl.type = 'date';
			text.setValue(dashboardDate);
			text.onChange((value) => {
				if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
					options.setDateKey(value);
					options.rerender();
				}
			});
		});

	const statsEl = containerEl.createDiv({ cls: 'spoonie-dashboard-stats' });
	statsEl.createEl('p', {
		text:
			dashboardDate === realToday
				? `Date: ${dashboardDate}`
				: `Date: ${dashboardDate} (viewing past day)`,
	});
	statsEl.createEl('p', {
		text: `Spoons left: ${spoonsLeft} / ${today.availableSpoons}`,
	});
	statsEl.createEl('p', { text: `XP today: ${today.xpEarned}` });
	statsEl.createEl('p', { text: `Level: ${profile.level}` });
	statsEl.createEl('p', { text: `Total XP: ${profile.totalXp}` });
	statsEl.createEl('p', {
		text: `Streak: ${profile.currentStreak} (best ${profile.longestStreak})`,
	});
	statsEl.createEl('p', { text: `Freezes: ${profile.freezeTokens}` });
	statsEl.createEl('p', {
		text: `Flare day: ${today.flareDay ? 'Yes' : 'No'}`,
	});
	statsEl.createEl('p', {
		text: `Use freeze today: ${today.useFreezeToday ? 'Yes' : 'No'}`,
	});

	containerEl.createEl('h3', { text: 'Tasks and Habits' });
	if (dueDebugEnabled) {
		containerEl.createEl('p', {
			cls: 'spoonie-dashboard-debug-banner',
			text: 'Due-debug mode is ON (toggle via command palette).',
		});
	}
	containerEl.createEl('p', { text: `Active: ${activeItems.length}` });
	containerEl.createEl('p', { text: `Due today: ${dueItems.length}` });
	containerEl.createEl('p', { text: `Completed today: ${completedItems.length}` });
	containerEl.createEl('p', {
		text: `Activities: ${activities.length} (net ${activityNetSpoons >= 0 ? '+' : ''}${activityNetSpoons} spoons)`,
	});

	containerEl.createEl('h4', { text: 'Do now' });
	const attachRowEditAction = (rowEl: HTMLElement, item: TrackableItem): void => {
		rowEl.addClass('spoonie-dashboard-editable-row');
		rowEl.tabIndex = 0;
		rowEl.setAttribute('role', 'button');
		rowEl.setAttribute('aria-label', `Edit ${item.title}`);

		const openEdit = (): void => {
			if (options.closeBeforeNavigation) {
				options.onClose();
			}
			plugin.openEditItemFromDashboard(item.id);
		};

		rowEl.addEventListener('click', (event) => {
			const target = event.target;
			if (target instanceof HTMLElement && target.closest('button')) {
				return;
			}
			openEdit();
		});

		rowEl.addEventListener('keydown', (event) => {
			if (event.key === 'Enter' || event.key === ' ') {
				event.preventDefault();
				openEdit();
			}
		});
	};

	if (dueItems.length > 0) {
		const dueList = containerEl.createEl('ul', { cls: 'spoonie-dashboard-due-list' });
		for (const item of dueItems.slice(0, 8)) {
			const row = dueList.createEl('li', { cls: 'spoonie-dashboard-due-row' });
			attachRowEditAction(row, item);
			row.createEl('span', {
				cls: 'spoonie-dashboard-due-title',
				text: `${item.title} (${item.priority}, ${item.spoonCost} spoons)`,
			});
			row.createEl('span', {
				cls: 'spoonie-recurrence-badge',
				text: formatRecurrenceSummary(item.recurrence),
			});
			if (dueDebugEnabled) {
				row.createEl('p', {
					cls: 'spoonie-dashboard-due-debug',
					text: plugin.getDueDebugInfo(item, today.date, today.completedItemIds),
				});
			}
		}
		if (dueItems.length > 8) {
			containerEl.createEl('p', {
				text: `...and ${dueItems.length - 8} more due items.`,
			});
		}
	} else {
		containerEl.createEl('p', { text: 'Nothing due right now.' });
	}

	if (completedItems.length > 0) {
		containerEl.createEl('h4', { text: 'Completed today' });
		const completedList = containerEl.createEl('ul', {
			cls: 'spoonie-dashboard-due-list',
		});
		for (const item of completedItems.slice(0, 8)) {
			const row = completedList.createEl('li', {
				cls: 'spoonie-dashboard-due-row spoonie-dashboard-completed-row',
			});
			attachRowEditAction(row, item);
			row.createEl('span', {
				cls: 'spoonie-dashboard-due-title',
				text: `Done: ${item.title} (${item.priority}, ${item.spoonCost} spoons)`,
			});
			row.createEl('span', {
				cls: 'spoonie-recurrence-badge',
				text: formatRecurrenceSummary(item.recurrence),
			});
			if (dueDebugEnabled) {
				row.createEl('p', {
					cls: 'spoonie-dashboard-due-debug',
					text: plugin.getDueDebugInfo(item, today.date, today.completedItemIds),
				});
			}
		}
		if (completedItems.length > 8) {
			containerEl.createEl('p', {
				text: `...and ${completedItems.length - 8} more completed items.`,
			});
		}
	}

	containerEl.createEl('h4', { text: 'Activities' });
	if (activities.length === 0) {
		containerEl.createEl('p', { text: 'No activities logged for this day.' });
	} else {
		const activityList = containerEl.createEl('ul', {
			cls: 'spoonie-dashboard-due-list',
		});
		for (const activity of activities.slice(-8).reverse()) {
			const row = activityList.createEl('li', {
				cls: 'spoonie-dashboard-due-row spoonie-dashboard-activity-row',
			});
			row.createEl('span', {
				cls: 'spoonie-dashboard-due-title',
				text: activity.title,
			});
			row.createEl('span', {
				cls: 'spoonie-recurrence-badge',
				text: `${activity.spoonDelta >= 0 ? '+' : ''}${activity.spoonDelta} spoons`,
			});
		}
		if (activities.length > 8) {
			containerEl.createEl('p', {
				text: `...and ${activities.length - 8} more activities.`,
			});
		}
	}

	containerEl.createEl('h3', { text: 'Journal Snapshot' });
	containerEl.createEl('p', { text: `Entries today: ${journalEntries.length}` });
	if (today.moodSummary) {
		containerEl.createEl('p', {
			text: `Avg mood: ${today.moodSummary.avgMoodScore ?? '-'}`,
		});
		containerEl.createEl('p', {
			text: `Avg pain: ${today.moodSummary.avgPainScore ?? '-'}`,
		});
	}

	const actions = containerEl.createDiv({ cls: 'spoonie-dashboard-actions' });
	actions.createEl('h3', { text: 'Quick Actions' });

	const beforeNavigate = (): void => {
		if (options.closeBeforeNavigation) {
			options.onClose();
		}
	};

	new Setting(actions)
		.addButton((button) => {
			button.setButtonText('Add Task/Habit').setCta().onClick(() => {
				beforeNavigate();
				plugin.openCreateItemFromDashboard();
			});
		})
		.addButton((button) => {
			button.setButtonText('Log Activity').setCta().onClick(() => {
				beforeNavigate();
				plugin.openAddActivityFromDashboardDate(dashboardDate);
			});
		})
		.addButton((button) => {
			button.setButtonText('Set Day').setCta().onClick(() => {
				beforeNavigate();
				plugin.openDailySetupFromDashboard(dashboardDate);
			});
		})
		.addButton((button) => {
			button.setButtonText('Complete Item').setCta().onClick(() => {
				beforeNavigate();
				plugin.openCompleteItemFromDashboardDate(dashboardDate);
			});
		})
		.addButton((button) => {
			button.setButtonText('Skip to Tomorrow').onClick(() => {
				beforeNavigate();
				plugin.openSkipItemFromDashboardDate(dashboardDate);
			});
		})
		.addButton((button) => {
			button.setButtonText('Undo Complete').onClick(() => {
				beforeNavigate();
				plugin.openUncompleteItemFromDashboardDate(dashboardDate);
			});
		})
		.addButton((button) => {
			button.setButtonText('New Journal Entry').setCta().onClick(() => {
				beforeNavigate();
				plugin.openJournalEntryFromDashboardDate(dashboardDate);
			});
		})
		.addButton((button) => {
			button.setButtonText('Journal History').onClick(() => {
				beforeNavigate();
				plugin.openJournalHistoryFromDashboard();
			});
		})
		.addButton((button) => {
			button.setButtonText('Finalize Day').setWarning().onClick(async () => {
				const result = await plugin.finalizeDayAndUpdateStreak(dashboardDate);
				plugin.refreshStatusBar();
				new Notice(
					result.freezeUsed
						? `Day finalized with freeze. Bonus XP: ${result.bonusXpAwarded}.`
						: `Day finalized. Current streak: ${result.streakAfter}.`,
				);
				options.rerender();
			});
		})
		.addButton((button) => {
			button.setButtonText('Refresh').onClick(() => options.rerender());
		})
		.addButton((button) => {
			button.setButtonText(options.closeLabel).onClick(() => options.onClose());
		});
}

class DashboardModal extends Modal {
	private readonly plugin: SpoonieLrpgPlugin;
	private keyboardAwareCleanup?: () => void;
	private dashboardDateKey: string;

	constructor(app: App, plugin: SpoonieLrpgPlugin) {
		super(app);
		this.plugin = plugin;
		this.dashboardDateKey = this.plugin.getTodayDateKey();
	}

	onOpen(): void {
		this.dashboardDateKey = this.plugin.getTodayDateKey();
		this.enableMobileKeyboardAwarePositioning();
		this.render();
	}

	private render(): void {
		renderDashboardContent(this.contentEl, this.plugin, {
			dateKey: this.dashboardDateKey,
			setDateKey: (dateKey: string) => {
				this.dashboardDateKey = dateKey;
			},
			closeLabel: 'Close',
			onClose: () => this.close(),
			rerender: () => this.render(),
			closeBeforeNavigation: true,
		});
	}

	onClose(): void {
		if (this.keyboardAwareCleanup) {
			this.keyboardAwareCleanup();
			this.keyboardAwareCleanup = undefined;
		}
		this.contentEl.empty();
	}

	private enableMobileKeyboardAwarePositioning(): void {
		const isLikelyMobile =
			window.matchMedia('(pointer: coarse)').matches ||
			window.matchMedia('(max-width: 900px)').matches;
		const viewport = window.visualViewport;
		if (!isLikelyMobile || !viewport) {
			return;
		}

		this.modalEl.addClass('spoonie-dashboard-modal');

		const updatePosition = (): void => {
			const keyboardHeight = Math.max(
				0,
				window.innerHeight - (viewport.height + viewport.offsetTop),
			);
			const bottomOffset = 8 + keyboardHeight;
			const maxHeight = Math.max(280, window.innerHeight - bottomOffset - 8);

			this.modalEl.style.position = 'fixed';
			this.modalEl.style.left = '8px';
			this.modalEl.style.right = '8px';
			this.modalEl.style.top = 'auto';
			this.modalEl.style.bottom = `${bottomOffset}px`;
			this.modalEl.style.margin = '0 auto';
			this.modalEl.style.maxHeight = `${maxHeight}px`;
			this.modalEl.style.overflow = 'auto';
		};

		updatePosition();
		viewport.addEventListener('resize', updatePosition);
		viewport.addEventListener('scroll', updatePosition);

		this.keyboardAwareCleanup = () => {
			viewport.removeEventListener('resize', updatePosition);
			viewport.removeEventListener('scroll', updatePosition);
			this.modalEl.removeClass('spoonie-dashboard-modal');
			this.modalEl.style.removeProperty('position');
			this.modalEl.style.removeProperty('left');
			this.modalEl.style.removeProperty('right');
			this.modalEl.style.removeProperty('top');
			this.modalEl.style.removeProperty('bottom');
			this.modalEl.style.removeProperty('margin');
			this.modalEl.style.removeProperty('max-height');
			this.modalEl.style.removeProperty('overflow');
		};
	}
}

class DashboardView extends ItemView {
	private readonly plugin: SpoonieLrpgPlugin;
	private dashboardDateKey: string;

	constructor(leaf: WorkspaceLeaf, plugin: SpoonieLrpgPlugin) {
		super(leaf);
		this.plugin = plugin;
		this.dashboardDateKey = this.plugin.getTodayDateKey();
	}

	getViewType(): string {
		return DASHBOARD_VIEW_TYPE;
	}

	getDisplayText(): string {
		return 'Spoonie Dashboard';
	}

	getIcon(): string {
		return SPOON_ICON_NAME;
	}

	async onOpen(): Promise<void> {
		this.dashboardDateKey = this.plugin.getTodayDateKey();
		this.render();
	}

	async onClose(): Promise<void> {
		this.contentEl.empty();
	}

	refresh(): void {
		this.render();
	}

	private render(): void {
		renderDashboardContent(this.contentEl, this.plugin, {
			dateKey: this.dashboardDateKey,
			setDateKey: (dateKey: string) => {
				this.dashboardDateKey = dateKey;
			},
			closeLabel: 'Close View',
			onClose: () => this.leaf.detach(),
			rerender: () => this.render(),
			closeBeforeNavigation: false,
		});
	}
}

class DailySetupModal extends Modal {
	private readonly plugin: SpoonieLrpgPlugin;
	private readonly targetDate: string;
	private availableSpoons: number;
	private flareDay: boolean;
	private useFreezeToday: boolean;

	constructor(app: App, plugin: SpoonieLrpgPlugin, targetDate: string) {
		super(app);
		this.plugin = plugin;
		this.targetDate = targetDate;
		const day = this.plugin.getOrCreateDailyRecord(targetDate);
		this.availableSpoons = day.availableSpoons;
		this.flareDay = day.flareDay;
		this.useFreezeToday = day.useFreezeToday;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl('h2', { text: `Day setup (${this.targetDate})` });

		new Setting(contentEl)
			.setName('Available spoons')
			.setDesc('Used for dynamic XP scaling.')
			.addText((text) =>
				text
					.setPlaceholder('10')
					.setValue(String(this.availableSpoons))
					.onChange((value) => {
						const parsed = Number.parseFloat(value);
						if (!Number.isNaN(parsed)) {
							this.availableSpoons = Math.max(0, Math.round(parsed));
						}
					}),
			);

		new Setting(contentEl)
			.setName('Flare day')
			.setDesc('Marks this day as a flare day for streak freeze logic.')
			.addToggle((toggle) =>
				toggle.setValue(this.flareDay).onChange((value) => {
					this.flareDay = value;
					if (!value) {
						this.useFreezeToday = false;
					}
				}),
			);

		new Setting(contentEl)
			.setName('Use freeze for this day')
			.setDesc('Consumes a freeze on finalize if this day is a flare day.')
			.addToggle((toggle) =>
				toggle.setValue(this.useFreezeToday).onChange((value) => {
					this.useFreezeToday = value;
				}),
			);

		new Setting(contentEl)
			.addButton((button) => {
				button.setButtonText('Save').setCta().onClick(async () => {
					const day = this.plugin.getOrCreateDailyRecord(this.targetDate);
					day.availableSpoons = this.availableSpoons;
					day.flareDay = this.flareDay;
					day.useFreezeToday = this.flareDay
						? this.useFreezeToday
						: false;
					day.updatedAt = new Date().toISOString();
					await this.plugin.saveSettings();
					new Notice(`Day setup saved for ${this.targetDate}.`);
					this.plugin.refreshStatusBar();
					this.close();
				});
			})
			.addButton((button) => {
				button.setButtonText('Cancel').onClick(() => this.close());
			});
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

class JournalEntryFormModal extends Modal {
	private readonly plugin: SpoonieLrpgPlugin;
	private readonly modalTitle: string;
	private readonly submitLabel: string;
	private readonly onSubmitEntry: (draft: JournalEntryDraft) => Promise<void>;
	private moodScore = 5;
	private painScore = 5;
	private note = '';
	private date: string;
	private time: string;
	private readonly selectedMoodIds = new Set<string>();
	private readonly selectedPainAreaIds = new Set<string>();
	private keyboardAwareCleanup?: () => void;

	constructor(
		app: App,
		plugin: SpoonieLrpgPlugin,
		options: {
			title: string;
			submitLabel: string;
			onSubmit: (draft: JournalEntryDraft) => Promise<void>;
			initial?: Partial<JournalEntryDraft>;
		},
	) {
		super(app);
		this.plugin = plugin;
		this.modalTitle = options.title;
		this.submitLabel = options.submitLabel;
		this.onSubmitEntry = options.onSubmit;
		this.date = options.initial?.date ?? this.plugin.getTodayDateKey();
		this.time = options.initial?.time ?? this.plugin.getCurrentLocalTime();
		this.moodScore = options.initial?.moodScore ?? 5;
		this.painScore = options.initial?.painScore ?? 5;
		this.note = options.initial?.note ?? '';
		for (const moodSelection of options.initial?.moodSelections ?? []) {
			this.selectedMoodIds.add(moodSelection.moodId);
		}
		for (const painAreaId of options.initial?.painAreaIds ?? []) {
			this.selectedPainAreaIds.add(painAreaId);
		}
	}

	onOpen(): void {
		this.enableMobileKeyboardAwarePositioning();
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('spoonie-journal-modal-content');
		contentEl.createEl('h2', { text: this.modalTitle });

		new Setting(contentEl)
			.setName('Date (YYYY-MM-DD)')
			.setDesc('Journal date to attach this entry to.')
			.addText((text) =>
				text.setValue(this.date).onChange((value) => {
					this.date = value.trim();
				}),
			);

		new Setting(contentEl)
			.setName('Time (HH:mm)')
			.setDesc('Entry time in 24-hour format.')
			.addText((text) =>
				text.setPlaceholder('14:30').setValue(this.time).onChange((value) => {
					this.time = value.trim();
				}),
			);

		const moodSection = contentEl.createDiv({ cls: 'spoonie-journal-section' });
		moodSection.createEl('h3', { text: 'Mood' });

		new Setting(moodSection)
			.setName('Mood score (0-10)')
			.addText((text) =>
				text
					.setPlaceholder('5')
					.setValue(String(this.moodScore))
					.onChange((value) => {
						const parsed = Number.parseFloat(value);
						if (!Number.isNaN(parsed)) {
							this.moodScore = Math.max(0, Math.min(10, parsed));
						}
					}),
			);

		moodSection.createEl('p', {
			cls: 'spoonie-journal-help',
			text: 'Tap one or more moods:',
		});
		const moodChipGroup = moodSection.createDiv({ cls: 'spoonie-chip-group' });
		for (const mood of this.plugin.settings.moodCatalog) {
			const moodChip = moodChipGroup.createEl('button', {
				cls: 'spoonie-chip',
				text: `${mood.emoji} ${mood.label}`,
			});
			moodChip.type = 'button';
			this.setChipSelected(
				moodChip,
				this.selectedMoodIds.has(mood.id),
			);
			moodChip.addEventListener('click', () => {
				if (this.selectedMoodIds.has(mood.id)) {
					this.selectedMoodIds.delete(mood.id);
				} else {
					this.selectedMoodIds.add(mood.id);
				}
				this.setChipSelected(
					moodChip,
					this.selectedMoodIds.has(mood.id),
				);
			});
		}

		const painSection = contentEl.createDiv({ cls: 'spoonie-journal-section' });
		painSection.createEl('h3', { text: 'Pain' });

		new Setting(painSection)
			.setName('Pain score (0-10)')
			.addText((text) =>
				text
					.setPlaceholder('5')
					.setValue(String(this.painScore))
					.onChange((value) => {
						const parsed = Number.parseFloat(value);
						if (!Number.isNaN(parsed)) {
							this.painScore = Math.max(0, Math.min(10, parsed));
						}
					}),
			);

		painSection.createEl('p', {
			cls: 'spoonie-journal-help',
			text: 'Tap pain areas:',
		});
		const painChipGroup = painSection.createDiv({ cls: 'spoonie-chip-group' });
		for (const area of this.plugin.settings.painAreasCatalog) {
			const painChip = painChipGroup.createEl('button', {
				cls: 'spoonie-chip',
				text: area.label,
			});
			painChip.type = 'button';
			this.setChipSelected(
				painChip,
				this.selectedPainAreaIds.has(area.id),
			);
			painChip.addEventListener('click', () => {
				if (this.selectedPainAreaIds.has(area.id)) {
					this.selectedPainAreaIds.delete(area.id);
				} else {
					this.selectedPainAreaIds.add(area.id);
				}
				this.setChipSelected(
					painChip,
					this.selectedPainAreaIds.has(area.id),
				);
			});
		}

		const notesSection = contentEl.createDiv({ cls: 'spoonie-journal-section' });
		notesSection.createEl('h3', { text: 'Notes' });

		new Setting(notesSection)
			.setName('Note')
			.setDesc('Optional details for this check-in')
			.addTextArea((text) =>
				text.setValue(this.note).onChange((value) => {
					this.note = value;
				}),
			);

		new Setting(contentEl)
			.addButton((button) => {
				button.setButtonText(this.submitLabel).setCta().onClick(async () => {
					if (this.selectedMoodIds.size === 0) {
						new Notice('Select at least one mood.');
						return;
					}
					if (!/^\d{4}-\d{2}-\d{2}$/.test(this.date)) {
						new Notice('Date must be in YYYY-MM-DD format.');
						return;
					}
					if (!this.plugin.isValidTime(this.time)) {
						new Notice('Time must be in HH:mm (24-hour) format.');
						return;
					}

					const moodSelections: MoodSelection[] = [...this.selectedMoodIds].map(
						(moodId) => ({ moodId }),
					);

					await this.onSubmitEntry({
						date: this.date,
						time: this.time,
						moodScore: this.moodScore,
						moodSelections,
						painScore: this.painScore,
						painAreaIds: [...this.selectedPainAreaIds],
						note: this.note,
					});
					this.close();
				});
			})
			.addButton((button) => {
				button.setButtonText('Cancel').onClick(() => this.close());
			});
	}

	onClose(): void {
		if (this.keyboardAwareCleanup) {
			this.keyboardAwareCleanup();
			this.keyboardAwareCleanup = undefined;
		}
		this.contentEl.empty();
	}

	private setChipSelected(chipEl: HTMLButtonElement, isSelected: boolean): void {
		chipEl.toggleClass('is-selected', isSelected);
		chipEl.setAttribute('aria-pressed', isSelected ? 'true' : 'false');
	}

	private enableMobileKeyboardAwarePositioning(): void {
		const isLikelyMobile =
			window.matchMedia('(pointer: coarse)').matches ||
			window.matchMedia('(max-width: 900px)').matches;
		const viewport = window.visualViewport;
		if (!isLikelyMobile || !viewport) {
			return;
		}

		this.modalEl.addClass('spoonie-journal-modal');

		const updatePosition = (): void => {
			const keyboardHeight = Math.max(
				0,
				window.innerHeight - (viewport.height + viewport.offsetTop),
			);
			const bottomOffset = 8 + keyboardHeight;
			const maxHeight = Math.max(320, window.innerHeight - bottomOffset - 8);

			this.modalEl.style.position = 'fixed';
			this.modalEl.style.left = '8px';
			this.modalEl.style.right = '8px';
			this.modalEl.style.top = 'auto';
			this.modalEl.style.bottom = `${bottomOffset}px`;
			this.modalEl.style.margin = '0 auto';
			this.modalEl.style.maxHeight = `${maxHeight}px`;
			this.modalEl.style.overflow = 'auto';
		};

		const handleFocusIn = (event: FocusEvent): void => {
			const target = event.target;
			if (!(target instanceof HTMLElement)) {
				return;
			}
			window.setTimeout(() => {
				target.scrollIntoView({ block: 'center', behavior: 'smooth' });
			}, 60);
		};

		updatePosition();
		viewport.addEventListener('resize', updatePosition);
		viewport.addEventListener('scroll', updatePosition);
		this.modalEl.addEventListener('focusin', handleFocusIn);

		this.keyboardAwareCleanup = () => {
			viewport.removeEventListener('resize', updatePosition);
			viewport.removeEventListener('scroll', updatePosition);
			this.modalEl.removeEventListener('focusin', handleFocusIn);
			this.modalEl.removeClass('spoonie-journal-modal');
			this.modalEl.style.removeProperty('position');
			this.modalEl.style.removeProperty('left');
			this.modalEl.style.removeProperty('right');
			this.modalEl.style.removeProperty('top');
			this.modalEl.style.removeProperty('bottom');
			this.modalEl.style.removeProperty('margin');
			this.modalEl.style.removeProperty('max-height');
			this.modalEl.style.removeProperty('overflow');
		};
	}
}

class JournalHistoryModal extends Modal {
	private readonly plugin: SpoonieLrpgPlugin;
	private selectedDate: string;

	constructor(app: App, plugin: SpoonieLrpgPlugin) {
		super(app);
		this.plugin = plugin;
		this.selectedDate = this.plugin.getTodayDateKey();
	}

	onOpen(): void {
		this.render();
	}

	private render(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl('h2', { text: 'Journal history' });

		new Setting(contentEl)
			.setName('Date (YYYY-MM-DD)')
			.setDesc('View and manage entries for a specific day.')
			.addText((text) =>
				text.setValue(this.selectedDate).onChange((value) => {
					this.selectedDate = value.trim();
					this.render();
				}),
			);

		const entries = this.plugin.getJournalEntriesForDate(this.selectedDate);
		if (entries.length === 0) {
			contentEl.createEl('p', { text: 'No journal entries for this date.' });
			return;
		}

		for (const entry of entries) {
			const moodLabels = entry.moodSelections
				.map((selection) =>
					this.plugin.settings.moodCatalog.find(
						(mood) => mood.id === selection.moodId,
					),
				)
				.filter((mood): mood is NonNullable<typeof mood> => Boolean(mood))
				.map((mood) => `${mood.emoji} ${mood.label}`)
				.join(', ');

			const painLabels = entry.painAreaIds
				.map((painAreaId) =>
					this.plugin.settings.painAreasCatalog.find(
						(area) => area.id === painAreaId,
					)?.label,
				)
				.filter((label): label is string => Boolean(label))
				.join(', ');

			const card = contentEl.createDiv({ cls: 'spoonie-journal-history-entry' });
			card.createEl('h3', { text: new Date(entry.timestamp).toLocaleTimeString() });
			card.createEl('p', {
				text: `Mood ${entry.moodScore}/10 | Pain ${entry.painScore}/10`,
			});
			card.createEl('p', { text: `Moods: ${moodLabels || 'None'}` });
			card.createEl('p', { text: `Pain areas: ${painLabels || 'None'}` });
			card.createEl('p', { text: `Note: ${entry.note ?? 'No note'}` });

			new Setting(card)
				.addButton((button) => {
					button.setButtonText('Edit').onClick(() => {
						new JournalEntryFormModal(this.app, this.plugin, {
							title: 'Edit journal entry',
							submitLabel: 'Save',
							initial: {
								date: entry.date,
								time: this.plugin.getLocalTimeFromTimestamp(entry.timestamp),
								moodScore: entry.moodScore,
								moodSelections: entry.moodSelections,
								painScore: entry.painScore,
								painAreaIds: entry.painAreaIds,
								note: entry.note,
							},
							onSubmit: async (draft) => {
								const updated = await this.plugin.updateJournalEntry(
									entry.id,
									draft,
								);
								if (!updated) {
									new Notice('Journal entry no longer exists.');
									return;
								}
								new Notice('Journal entry updated.');
								this.selectedDate = updated.date;
								this.render();
							},
						}).open();
					});
				})
				.addButton((button) => {
					button
						.setButtonText('Delete')
						.setWarning()
						.onClick(async () => {
							const deleted = await this.plugin.deleteJournalEntry(entry.id);
							if (!deleted) {
								new Notice('Journal entry no longer exists.');
								return;
							}
							new Notice('Journal entry deleted.');
							this.render();
						});
				});
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
