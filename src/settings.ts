import { App, PluginSettingTab, Setting } from 'obsidian';
import MyPlugin from './main';

export const CURRENT_SCHEMA_VERSION = 5;

export type Priority = 'low' | 'medium' | 'high' | 'critical';
export type ItemType = 'habit' | 'task';
export type RecurrenceMode =
	| 'always'
	| 'daily'
	| 'weekly'
	| 'interval'
	| 'monthly';

export interface RecurrenceRule {
	mode: RecurrenceMode;
	startDate?: string;
	weekdays?: number[];
	intervalDays?: number;
	dayOfMonth?: number;
}

export interface MoodOption {
	id: string;
	label: string;
	emoji: string;
}

export interface PainAreaOption {
	id: string;
	label: string;
}

export interface MoodSelection {
	moodId: string;
	intensity?: number;
}

export interface JournalEntry {
	id: string;
	date: string;
	timestamp: string;
	moodScore: number;
	moodSelections: MoodSelection[];
	painScore: number;
	painAreaIds: string[];
	note?: string;
}

export interface DailyMoodPainSummary {
	avgMoodScore?: number;
	avgPainScore?: number;
	dominantMoodIds?: string[];
	worstPainAreaIds?: string[];
}

export interface DailyActivity {
	id: string;
	title: string;
	spoonDelta: number;
	createdAt: string;
}

export interface DailyRecord {
	date: string;
	availableSpoons: number;
	flareDay: boolean;
	useFreezeToday: boolean;
	completedItemIds: string[];
	completedItemXpById?: Record<string, number>;
	completedItemSpoonsRecoveredById?: Record<string, number>;
	xpEarned: number;
	streakCounted: boolean;
	freezeUsed: boolean;
	moodSummary?: DailyMoodPainSummary;
	journalEntryIds: string[];
	activities: DailyActivity[];
	createdAt: string;
	updatedAt: string;
}

export interface TrackableItem {
	id: string;
	title: string;
	type: ItemType;
	spoonCost: number;
	spoonRecovery?: number;
	priority: Priority;
	isSelfCare?: boolean;
	recurrence?: RecurrenceRule;
	deferUntilDate?: string;
	active: boolean;
	createdAt: string;
	archivedAt?: string;
	notes?: string;
	tags?: string[];
}

export interface UserProfile {
	totalXp: number;
	level: number;
	currentStreak: number;
	longestStreak: number;
	freezeTokens: number;
	streakDaysTowardNextFreeze: number;
	baselineSpoons: number;
	lastActiveDate?: string;
}

export interface SystemConfig {
	minCompletionsForStreakDay: number;
	maxFreezeTokens: number;
	daysPerFreezeReward: number;
	baseXp: number;
	scarcityAlpha: number;
	noSpoonsXpMultiplier: number;
	freezeDayTaskXpBonusPct: number;
	freezeDaySelfCareHabitBonusPct: number;
	autoOpenDashboardSidebarOnLoad: boolean;
	priorityMultipliers: Record<Priority, number>;
}

export interface MyPluginSettings {
	schemaVersion: number;
	profile: UserProfile;
	config: SystemConfig;
	items: Record<string, TrackableItem>;
	daily: Record<string, DailyRecord>;
	journal: Record<string, JournalEntry>;
	moodCatalog: MoodOption[];
	painAreasCatalog: PainAreaOption[];
}

const DEFAULT_MOOD_CATALOG: MoodOption[] = [
	{ id: 'happy', label: 'Happy', emoji: '😀' },
	{ id: 'joyful', label: 'Joyful', emoji: '😁' },
	{ id: 'proud', label: 'Proud', emoji: '😄' },
	{ id: 'hopeful', label: 'Hopeful', emoji: '🙏' },
	{ id: 'connected', label: 'Connected', emoji: '🖇️' },
	{ id: 'peaceful', label: 'Peaceful', emoji: '😊' },
	{ id: 'loving', label: 'Loving', emoji: '😍' },
	{ id: 'inspired', label: 'Inspired', emoji: '💡' },
	{ id: 'energized', label: 'Energized', emoji: '💪' },
	{ id: 'determined', label: 'Determined', emoji: '👊' },
	{ id: 'surprised', label: 'Surprised', emoji: '😲' },
	{ id: 'inquisitive', label: 'Inquisitive', emoji: '🤔' },
	{ id: 'amazed', label: 'Amazed', emoji: '🤩' },
	{ id: 'confused', label: 'Confused', emoji: '😖' },
	{ id: 'scared', label: 'Scared', emoji: '😨' },
	{ id: 'anxious', label: 'Anxious', emoji: '😰' },
	{ id: 'worried', label: 'Worried', emoji: '😟' },
	{ id: 'overwhelmed', label: 'Overwhelmed', emoji: '😵' },
	{ id: 'insecure', label: 'Insecure', emoji: '😅' },
	{ id: 'embarrassed', label: 'Embarrassed', emoji: '😳' },
	{ id: 'annoyed', label: 'Annoyed', emoji: '🙄' },
	{ id: 'mad', label: 'Mad', emoji: '😠' },
	{ id: 'angry', label: 'Angry', emoji: '😡' },
	{ id: 'furious', label: 'Furious', emoji: '🤬' },
	{ id: 'discouraged', label: 'Discouraged', emoji: '😔' },
	{ id: 'disgust', label: 'Disgust', emoji: '🤮' },
	{ id: 'disappointed', label: 'Disappointed', emoji: '😟' },
	{ id: 'awful', label: 'Awful', emoji: '😣' },
	{ id: 'dispirited', label: 'Dispirited', emoji: '😕' },
	{ id: 'critical', label: 'Critical', emoji: '😒' },
	{ id: 'sad', label: 'Sad', emoji: '😢' },
	{ id: 'guilty', label: 'Guilty', emoji: '😓' },
	{ id: 'rejected', label: 'Rejected', emoji: '🚫' },
	{ id: 'unseen', label: 'Unseen', emoji: '🙈' },
	{ id: 'depressed', label: 'Depressed', emoji: '😭' },
	{ id: 'lonely', label: 'Lonely', emoji: '💔' },
	{ id: 'bored', label: 'Bored', emoji: '😐' },
	{ id: 'apathetic', label: 'Apathetic', emoji: '🤷' },
	{ id: 'melancholy', label: 'Melancholy', emoji: '🥺' },
	{ id: 'frozen', label: 'Frozen', emoji: '🥶' },
	{ id: 'grieving', label: 'Grieving', emoji: '😫' },
	{ id: 'frustrated', label: 'Frustrated', emoji: '😤' },
	{ id: 'safe', label: 'Safe', emoji: '🤗' },
	{ id: 'relieved', label: 'Relieved', emoji: '😮‍💨' },
];

const DEFAULT_PAIN_AREAS_CATALOG: PainAreaOption[] = [
	{ id: 'head', label: 'Head' },
	{ id: 'neck', label: 'Neck' },
	{ id: 'upper-arms', label: 'Upper Arms' },
	{ id: 'elbows', label: 'Elbows' },
	{ id: 'lower-arms', label: 'Lower Arms' },
	{ id: 'shoulders', label: 'Shoulders' },
	{ id: 'upper-back', label: 'Upper Back' },
	{ id: 'lower-back', label: 'Lower Back' },
	{ id: 'chest', label: 'Chest' },
	{ id: 'abdomen', label: 'Abdomen' },
	{ id: 'hips', label: 'Hips' },
	{ id: 'thighs', label: 'Thighs' },
	{ id: 'calves', label: 'Calves' },
	{ id: 'knees', label: 'Knees' },
	{ id: 'hands', label: 'Hands' },
	{ id: 'feet', label: 'Feet' },
];

export function getDefaultMoodCatalog(): MoodOption[] {
	return DEFAULT_MOOD_CATALOG.map((mood) => ({ ...mood }));
}

export function getDefaultPainAreasCatalog(): PainAreaOption[] {
	return DEFAULT_PAIN_AREAS_CATALOG.map((painArea) => ({ ...painArea }));
}

export const DEFAULT_SETTINGS: MyPluginSettings = createDefaultSettings();

export function createDefaultSettings(): MyPluginSettings {
	return {
		schemaVersion: CURRENT_SCHEMA_VERSION,
		profile: {
			totalXp: 0,
			level: 1,
			currentStreak: 0,
			longestStreak: 0,
			freezeTokens: 3,
			streakDaysTowardNextFreeze: 0,
			baselineSpoons: 10,
		},
		config: {
			minCompletionsForStreakDay: 1,
			maxFreezeTokens: 5,
			daysPerFreezeReward: 7,
			baseXp: 8,
			scarcityAlpha: 1,
			noSpoonsXpMultiplier: 2,
			freezeDayTaskXpBonusPct: 0.25,
			freezeDaySelfCareHabitBonusPct: 0.2,
			autoOpenDashboardSidebarOnLoad: true,
			priorityMultipliers: {
				low: 1,
				medium: 1.25,
				high: 1.6,
				critical: 2,
			},
		},
		items: {},
		daily: {},
		journal: {},
		moodCatalog: getDefaultMoodCatalog(),
		painAreasCatalog: getDefaultPainAreasCatalog(),
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

function asStringArray(value: unknown): string[] {
	if (!Array.isArray(value)) {
		return [];
	}
	return value.filter((entry): entry is string => typeof entry === 'string');
}

function asNonNegativeNumberRecord(
	value: unknown,
): Record<string, number> {
	if (!isRecord(value)) {
		return {};
	}

	const normalized: Record<string, number> = {};
	for (const [key, entry] of Object.entries(value)) {
		if (typeof entry === 'number' && entry >= 0) {
			normalized[key] = Math.round(entry);
		}
	}
	return normalized;
}

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, value));
}

function normalizeRecurrenceRule(
	value: unknown,
	fallbackStartDate: string,
): RecurrenceRule {
	if (!isRecord(value)) {
		return { mode: 'always', startDate: fallbackStartDate };
	}

	const mode: RecurrenceMode =
		value.mode === 'always' ||
		value.mode === 'daily' ||
		value.mode === 'weekly' ||
		value.mode === 'interval' ||
		value.mode === 'monthly'
			? value.mode
			: 'always';

	const startDate =
		typeof value.startDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value.startDate)
			? value.startDate
			: fallbackStartDate;

	if (mode === 'weekly') {
		const weekdays = Array.isArray(value.weekdays)
			? [...new Set(value.weekdays)]
					.filter(
						(day): day is number =>
							typeof day === 'number' && Number.isInteger(day) && day >= 0 && day <= 6,
					)
					.sort((a, b) => a - b)
			: [1];
		return {
			mode,
			startDate,
			weekdays: weekdays.length > 0 ? weekdays : [1],
		};
	}

	if (mode === 'interval') {
		const intervalDays =
			typeof value.intervalDays === 'number'
				? Math.max(1, Math.round(value.intervalDays))
				: 1;
		return { mode, startDate, intervalDays };
	}

	if (mode === 'monthly') {
		const dayOfMonth =
			typeof value.dayOfMonth === 'number'
				? clamp(Math.round(value.dayOfMonth), 1, 31)
				: 1;
		return { mode, startDate, dayOfMonth };
	}

	if (mode === 'daily') {
		return { mode, startDate };
	}

	return { mode: 'always', startDate };
}

function normalizeTrackableItem(
	itemId: string,
	value: unknown,
): TrackableItem | null {
	if (!isRecord(value) || typeof value.title !== 'string') {
		return null;
	}

	const createdAt =
		typeof value.createdAt === 'string' ? value.createdAt : new Date().toISOString();
	const fallbackStartDate = createdAt.slice(0, 10);
	const type: ItemType = value.type === 'habit' ? 'habit' : 'task';
	const priority: Priority =
		value.priority === 'low' ||
		value.priority === 'medium' ||
		value.priority === 'high' ||
		value.priority === 'critical'
			? value.priority
			: 'medium';

	return {
		id: typeof value.id === 'string' ? value.id : itemId,
		title: value.title,
		type,
		spoonCost:
			typeof value.spoonCost === 'number' ? Math.max(1, Math.round(value.spoonCost)) : 1,
		spoonRecovery:
			typeof value.spoonRecovery === 'number'
				? Math.max(0, Math.round(value.spoonRecovery))
				: 0,
		priority,
		isSelfCare: Boolean(value.isSelfCare),
		recurrence: normalizeRecurrenceRule(value.recurrence, fallbackStartDate),
		deferUntilDate:
			typeof value.deferUntilDate === 'string' &&
			/^\d{4}-\d{2}-\d{2}$/.test(value.deferUntilDate)
				? value.deferUntilDate
				: undefined,
		active: value.active !== false,
		createdAt,
		archivedAt: typeof value.archivedAt === 'string' ? value.archivedAt : undefined,
		notes: typeof value.notes === 'string' ? value.notes : undefined,
		tags: asStringArray(value.tags),
	};
}

function normalizeJournalEntry(
	entryId: string,
	value: unknown,
): JournalEntry | null {
	if (!isRecord(value)) {
		return null;
	}

	const moodSelectionsFromLegacy: MoodSelection[] =
		typeof value.moodId === 'string' ? [{ moodId: value.moodId }] : [];

	const moodSelections = Array.isArray(value.moodSelections)
		? value.moodSelections
				.filter(isRecord)
				.map((selection) => {
					const moodId =
						typeof selection.moodId === 'string' ? selection.moodId : '';
					if (!moodId) {
						return null;
					}
					const normalized: MoodSelection = { moodId };
					if (typeof selection.intensity === 'number') {
						normalized.intensity = clamp(
							Math.round(selection.intensity),
							1,
							5,
						);
					}
					return normalized;
				})
				.filter((selection): selection is MoodSelection => selection !== null)
		: moodSelectionsFromLegacy;

	const nowIso = new Date().toISOString();
	const date = typeof value.date === 'string' ? value.date : nowIso.slice(0, 10);
	const timestamp = typeof value.timestamp === 'string' ? value.timestamp : nowIso;

	return {
		id: typeof value.id === 'string' ? value.id : entryId,
		date,
		timestamp,
		moodScore:
			typeof value.moodScore === 'number'
				? clamp(value.moodScore, 0, 10)
				: 0,
		moodSelections,
		painScore:
			typeof value.painScore === 'number'
				? clamp(value.painScore, 0, 10)
				: 0,
		painAreaIds: asStringArray(value.painAreaIds),
		note: typeof value.note === 'string' ? value.note : undefined,
	};
}

function normalizeMoodOption(value: unknown): MoodOption | null {
	if (!isRecord(value)) {
		return null;
	}
	if (
		typeof value.id !== 'string' ||
		typeof value.label !== 'string' ||
		typeof value.emoji !== 'string'
	) {
		return null;
	}

	return {
		id: value.id,
		label: value.label,
		emoji: value.emoji,
	};
}

function normalizePainAreaOption(value: unknown): PainAreaOption | null {
	if (!isRecord(value)) {
		return null;
	}
	if (typeof value.id !== 'string' || typeof value.label !== 'string') {
		return null;
	}

	return {
		id: value.id,
		label: value.label,
	};
}

export function migrateSettings(rawData: unknown): MyPluginSettings {
	const defaults = createDefaultSettings();
	if (!isRecord(rawData)) {
		return defaults;
	}

	const rawProfile = isRecord(rawData.profile) ? rawData.profile : {};
	const rawConfig = isRecord(rawData.config) ? rawData.config : {};
	const rawItems = isRecord(rawData.items) ? rawData.items : {};
	const rawDaily = isRecord(rawData.daily) ? rawData.daily : {};
	const rawJournal = isRecord(rawData.journal) ? rawData.journal : {};

	const migratedItems: Record<string, TrackableItem> = {};
	for (const [itemId, value] of Object.entries(rawItems)) {
		const normalized = normalizeTrackableItem(itemId, value);
		if (normalized) {
			migratedItems[itemId] = normalized;
		}
	}

	const migratedJournal: Record<string, JournalEntry> = {};
	for (const [entryId, entry] of Object.entries(rawJournal)) {
		const normalized = normalizeJournalEntry(entryId, entry);
		if (normalized) {
			migratedJournal[entryId] = normalized;
		}
	}

	const migratedDaily: Record<string, DailyRecord> = {};
	for (const [dateKey, recordValue] of Object.entries(rawDaily)) {
		if (!isRecord(recordValue)) {
			continue;
		}

		const summary = isRecord(recordValue.moodSummary)
			? recordValue.moodSummary
			: undefined;
		const dominantMoodIds = summary
			? asStringArray(summary.dominantMoodIds)
			: [];
		const legacyMoodId = summary && typeof summary.dominantMoodId === 'string'
			? summary.dominantMoodId
			: undefined;

		migratedDaily[dateKey] = {
			date: typeof recordValue.date === 'string' ? recordValue.date : dateKey,
			availableSpoons:
				typeof recordValue.availableSpoons === 'number'
					? Math.max(0, recordValue.availableSpoons)
					: 0,
			flareDay: Boolean(recordValue.flareDay),
			useFreezeToday:
				typeof recordValue.useFreezeToday === 'boolean'
					? recordValue.useFreezeToday
					: Boolean(recordValue.flareDay),
			completedItemIds: asStringArray(recordValue.completedItemIds),
			completedItemXpById: asNonNegativeNumberRecord(
				recordValue.completedItemXpById,
			),
			completedItemSpoonsRecoveredById: asNonNegativeNumberRecord(
				recordValue.completedItemSpoonsRecoveredById,
			),
			xpEarned:
				typeof recordValue.xpEarned === 'number'
					? Math.max(0, recordValue.xpEarned)
					: 0,
			streakCounted: Boolean(recordValue.streakCounted),
			freezeUsed: Boolean(recordValue.freezeUsed),
			moodSummary: summary
				? {
						avgMoodScore:
							typeof summary.avgMoodScore === 'number'
								? clamp(summary.avgMoodScore, 0, 10)
								: undefined,
						avgPainScore:
							typeof summary.avgPainScore === 'number'
								? clamp(summary.avgPainScore, 0, 10)
								: undefined,
						dominantMoodIds:
							dominantMoodIds.length > 0
								? dominantMoodIds
								: legacyMoodId
									? [legacyMoodId]
									: undefined,
						worstPainAreaIds: asStringArray(summary.worstPainAreaIds),
					}
				: undefined,
			journalEntryIds: asStringArray(recordValue.journalEntryIds),
			activities: Array.isArray(recordValue.activities)
				? recordValue.activities
						.filter(isRecord)
						.map((entry, index) => {
							if (typeof entry.title !== 'string') {
								return null;
							}
							const spoonDelta =
								typeof entry.spoonDelta === 'number'
									? Math.round(entry.spoonDelta)
									: 0;
							return {
								id:
									typeof entry.id === 'string'
										? entry.id
										: `${dateKey}-activity-${index}`,
								title: entry.title,
								spoonDelta,
								createdAt:
									typeof entry.createdAt === 'string'
										? entry.createdAt
										: new Date().toISOString(),
							};
						})
						.filter(
							(entry): entry is DailyActivity => Boolean(entry),
						)
				: [],
			createdAt:
				typeof recordValue.createdAt === 'string'
					? recordValue.createdAt
					: new Date().toISOString(),
			updatedAt:
				typeof recordValue.updatedAt === 'string'
					? recordValue.updatedAt
					: new Date().toISOString(),
		};
	}

	const moodCatalog = Array.isArray(rawData.moodCatalog)
		? rawData.moodCatalog
				.map((option) => normalizeMoodOption(option))
				.filter((option): option is MoodOption => option !== null)
		: defaults.moodCatalog;

	const painAreasCatalog = Array.isArray(rawData.painAreasCatalog)
		? rawData.painAreasCatalog
				.map((option) => normalizePainAreaOption(option))
				.filter((option): option is PainAreaOption => option !== null)
		: defaults.painAreasCatalog;

	return {
		schemaVersion: CURRENT_SCHEMA_VERSION,
		profile: {
			...defaults.profile,
			...rawProfile,
			freezeTokens:
				typeof rawProfile.freezeTokens === 'number'
					? Math.max(0, Math.round(rawProfile.freezeTokens))
					: defaults.profile.freezeTokens,
			baselineSpoons:
				typeof rawProfile.baselineSpoons === 'number'
					? Math.max(0, rawProfile.baselineSpoons)
					: defaults.profile.baselineSpoons,
		},
		config: {
			...defaults.config,
			...rawConfig,
			noSpoonsXpMultiplier:
				typeof rawConfig.noSpoonsXpMultiplier === 'number'
					? Math.max(1, rawConfig.noSpoonsXpMultiplier)
					: defaults.config.noSpoonsXpMultiplier,
			autoOpenDashboardSidebarOnLoad:
				typeof rawConfig.autoOpenDashboardSidebarOnLoad === 'boolean'
					? rawConfig.autoOpenDashboardSidebarOnLoad
					: defaults.config.autoOpenDashboardSidebarOnLoad,
			priorityMultipliers: {
				...defaults.config.priorityMultipliers,
				...(isRecord(rawConfig.priorityMultipliers)
					? rawConfig.priorityMultipliers
					: {}),
			},
		},
		items: migratedItems,
		daily: migratedDaily,
		journal: migratedJournal,
		moodCatalog: moodCatalog.length > 0 ? moodCatalog : defaults.moodCatalog,
		painAreasCatalog:
			painAreasCatalog.length > 0
				? painAreasCatalog
				: defaults.painAreasCatalog,
	};
}

export class SampleSettingTab extends PluginSettingTab {
	plugin: MyPlugin;

	constructor(app: App, plugin: MyPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;

		containerEl.empty();

		new Setting(containerEl)
			.setName('Baseline spoons')
			.setDesc('Default spoon capacity used by XP scarcity scaling.')
			.addText((text) =>
				text
					.setPlaceholder('10')
					.setValue(String(this.plugin.settings.profile.baselineSpoons))
					.onChange(async (value) => {
						const parsed = Number.parseFloat(value);
						if (Number.isNaN(parsed) || parsed < 0) {
							return;
						}
						this.plugin.settings.profile.baselineSpoons = parsed;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Base XP')
			.setDesc('Base XP multiplier for task completion.')
			.addText((text) =>
				text
					.setPlaceholder('8')
					.setValue(String(this.plugin.settings.config.baseXp))
					.onChange(async (value) => {
						const parsed = Number.parseFloat(value);
						if (Number.isNaN(parsed) || parsed < 0) {
							return;
						}
						this.plugin.settings.config.baseXp = parsed;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('No-spoons XP multiplier')
			.setDesc('Applied when completing an item with zero or fewer spoons left.')
			.addText((text) =>
				text
					.setPlaceholder('2')
					.setValue(String(this.plugin.settings.config.noSpoonsXpMultiplier))
					.onChange(async (value) => {
						const parsed = Number.parseFloat(value);
						if (Number.isNaN(parsed) || parsed < 1) {
							return;
						}
						this.plugin.settings.config.noSpoonsXpMultiplier = parsed;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Freeze day task bonus (%)')
			.setDesc('Bonus XP applied to all completed items when a freeze is used.')
			.addText((text) =>
				text
					.setPlaceholder('25')
					.setValue(
						String(this.plugin.settings.config.freezeDayTaskXpBonusPct * 100),
					)
					.onChange(async (value) => {
						const parsed = Number.parseFloat(value);
						if (Number.isNaN(parsed) || parsed < 0) {
							return;
						}
						this.plugin.settings.config.freezeDayTaskXpBonusPct = parsed / 100;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Freeze day self-care bonus (%)')
			.setDesc(
				'Additional bonus XP for self-care/restful habits when a freeze is used.',
			)
			.addText((text) =>
				text
					.setPlaceholder('20')
					.setValue(
						String(
							this.plugin.settings.config.freezeDaySelfCareHabitBonusPct * 100,
						),
					)
					.onChange(async (value) => {
						const parsed = Number.parseFloat(value);
						if (Number.isNaN(parsed) || parsed < 0) {
							return;
						}
						this.plugin.settings.config.freezeDaySelfCareHabitBonusPct =
							parsed / 100;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Auto-open dashboard sidebar on load')
			.setDesc('Automatically opens the dashboard in the right sidebar at startup.')
			.addToggle((toggle) =>
				toggle
					.setValue(
						this.plugin.settings.config.autoOpenDashboardSidebarOnLoad,
					)
					.onChange(async (value) => {
						this.plugin.settings.config.autoOpenDashboardSidebarOnLoad = value;
						await this.plugin.saveSettings();
					}),
			);
	}
}
