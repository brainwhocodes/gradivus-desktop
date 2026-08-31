<script lang="ts">
  import { onMount, tick } from "svelte";
  import ArrowDown from "@solar-icons/svelte/linear/arrow-down";
  import ArrowRight from "@solar-icons/svelte/linear/arrow-right";
  import Bolt from "@solar-icons/svelte/linear/bolt";
  import ClockCircle from "@solar-icons/svelte/linear/clock-circle";
  import CloseCircle from "@solar-icons/svelte/linear/close-circle";
  import CodeSquare from "@solar-icons/svelte/linear/code-square";
  import Pen2 from "@solar-icons/svelte/linear/pen-2";
  import Stop from "@solar-icons/svelte/linear/stop";
  import type { AgentHubAgent, AgentHubMessagePage, AgentHubSnapshot, AgentSettingTab, AgentSettingValue, AgentSettingView, AuthAccountView, AuthEvent, BootstrapSnapshot, GradivusEvent, GradivusSettings, ExtensionView, FileDiffView, InterruptMode, ModelOption, OAuthAccountsView, OpenRouterModelRouting, PromptAttachmentUpload, PromptAttachmentView, QueueMode, SessionKind, SessionRecordV1, SessionSnapshot, SlashCommand, SubagentView, ThinkingLevel, TimelineItem } from "../../../shared/contracts";
  import { MAX_INLINE_PROMPT_BYTES, MAX_PROMPT_ATTACHMENT_BATCH_BYTES, MAX_PROMPT_ATTACHMENT_BYTES, MAX_PROMPT_ATTACHMENT_COUNT } from "../../../shared/contracts";
  import type { AgentPromptScope, AgentPromptView, SessionStatsView, TimelineToolActivity, TodoPhase, TodoState } from "../../../shared/contracts";
  import type { PlanReviewResolutionResult, PlanReviewView } from "../../../shared/contracts";
  import type { TodoEditBuffer } from "../../todo-editing";
  import { promptAttachmentDisplayText } from "../../../shared/attachment-display";
  import { changedFiles, projectTimeline } from "../../../shared/projection";
  import {
    attachmentsReferencedByDraft,
    buildPromptComposition,
    insertAttachmentReferences,
    removeAttachmentReference,
    resolveAttachmentInsertionIndex,
  } from "../../attachment-composition";
  import { projectTurnFileSummaries } from "../../turn-file-summary";
  import { AUTH_DISCOVERY_PROVIDER } from "../../../shared/auth-events";
  import ApplicationSettingsPanel from "../organisms/ApplicationSettingsPanel.svelte";
  import SettingsShell from "../organisms/SettingsShell.svelte";
  import SubagentPromptEditor from "../organisms/SubagentPromptEditor.svelte";
import ModelCapabilityIcons from "../molecules/ModelCapabilityIcons.svelte";
import OpenRouterModelAccordion from "../molecules/OpenRouterModelAccordion.svelte";
import TimelineEntry from "../organisms/TimelineEntry.svelte";
  import CustomDropdown from "../atoms/CustomDropdown.svelte";
  import { agentSettingOptionToDropdownOption, agentSettingValueKey, type DropdownOption, type SettingsCategoryId, type SettingsRoute, type ApplicationSettingsCategoryId } from "../../settings-types";
  import FileDiffInspector from "../organisms/FileDiffInspector.svelte";
  import FileActivityPanel from "../organisms/FileActivityPanel.svelte";
  import AgentHubPanel from "../organisms/AgentHubPanel.svelte";
  import TodoDock from "../organisms/TodoDock.svelte";
  import { commandInsertion, searchSlashCommands, slashCommandQuery } from "../../command-search";
  import CommandMenu from "../molecules/CommandMenu.svelte";
  import AttachmentChip from "../molecules/AttachmentChip.svelte";
  import IconButton from "../molecules/IconButton.svelte";
  import LabeledSelect from "../molecules/LabeledSelect.svelte";
  import ModalShell from "../molecules/ModalShell.svelte";
  import SessionStatsModal from "../molecules/SessionStatsModal.svelte";
  import StateCard from "../molecules/StateCard.svelte";
  import Toast from "../molecules/Toast.svelte";
  import TurnFileSummary from "../molecules/TurnFileSummary.svelte";
  import ToggleField from "../molecules/ToggleField.svelte";
  import ChatTerminalDrawer from "../organisms/ChatTerminalDrawer.svelte";
  import ContextMeter from "../organisms/ContextMeter.svelte";
  import SessionRail from "../organisms/SessionRail.svelte";
  import RunInspector from "../organisms/RunInspector.svelte";
  import Composer from "../organisms/Composer.svelte";
  import PlanReviewModal from "../organisms/PlanReviewModal.svelte";
  import type { WorkspaceTab } from "../../workspace-types";
  import type { ResolvedTheme } from "../../../shared/theme-palette";
  import type { SettingsSearchEntry } from "../../settings-search";
  import type { UpdateGradivusSettingsInput } from "../../../shared/contracts";
  export let appSettings: GradivusSettings | undefined = undefined;
  export let terminalTabs: WorkspaceTab[] = [];
  export let workspaceId = "";
  export let theme: ResolvedTheme = "dark";
  export let onActiveSessionChange: (sessionId: string) => void = () => undefined;
  export let settingsRoute: SettingsRoute = { open: false, activeCategory: "runtime", query: "" };
  export let onOpenSettings: (category: SettingsCategoryId, trigger: HTMLElement) => void = () => undefined;
  export let onSettingsRouteChange: (updates: Partial<Pick<SettingsRoute, "activeCategory" | "query">>) => void = () => undefined;
  export let onCloseSettings: () => void = () => undefined;
  export let onUpdateAppSetting: (key: string, updates: UpdateGradivusSettingsInput, label: string) => Promise<void> = async () => undefined;
  export let onResetAppSettings: () => Promise<void> = async () => undefined;
  export let appSettingsBusy: ReadonlySet<string> = new Set<string>();
  const QUICK_COMMAND_NAMES = ["mcp", "tree", "export", "share"] as const;
  export let appSettingsStatus: { key: string; tone: "saving" | "success" | "error"; message: string } | undefined = undefined;
  export let active = true;
  export let chatPresentationReady = true;
  export let onPlanReviewCountChange: (count: number) => void = () => undefined;

  type SettingKey = "model" | "thinking" | "fast" | "steering" | "follow-up" | "interrupt" | "compaction" | "retry";
  const SETTINGS_THINKING_OPTIONS: readonly DropdownOption[] = [
    { key: "inherit", value: "inherit", label: "Session default" },
    { key: "off", value: "off", label: "Off" },
    { key: "minimal", value: "minimal", label: "Minimal" },
    { key: "low", value: "low", label: "Low" },
    { key: "medium", value: "medium", label: "Medium" },
    { key: "high", value: "high", label: "High" },
    { key: "xhigh", value: "xhigh", label: "Extra high" },
    { key: "max", value: "max", label: "Maximum supported" },
  ];
  const QUEUE_MODE_OPTIONS: readonly DropdownOption[] = [
    { key: "all", value: "all", label: "Deliver all" },
    { key: "one-at-a-time", value: "one-at-a-time", label: "One at a time" },
  ];
  const INTERRUPT_MODE_OPTIONS: readonly DropdownOption[] = [
    { key: "immediate", value: "immediate", label: "Interrupt immediately" },
    { key: "wait", value: "wait", label: "Wait for a safe boundary" },
  ];
  const AGENT_SETTING_CATEGORIES: ReadonlyArray<{
    tab: AgentSettingTab;
    category: SettingsCategoryId;
    label: string;
  }> = [
    { tab: "appearance", category: "omp-appearance", label: "Appearance" },
    { tab: "model", category: "omp-model", label: "Model" },
    { tab: "interaction", category: "omp-interaction", label: "Interaction" },
    { tab: "context", category: "omp-context", label: "Context" },
    { tab: "files", category: "omp-files", label: "Files" },
    { tab: "shell", category: "omp-shell", label: "Shell" },
    { tab: "tools", category: "omp-tools", label: "Tools" },
    { tab: "tasks", category: "omp-tasks", label: "Tasks" },
  ];
  const RUNTIME_SEARCH_ENTRIES: readonly SettingsSearchEntry[] = [
    { id: "runtime.model", category: "runtime", group: "Active session", label: "Current model", description: "Choose the model used by the active session.", keywords: ["model provider", "search models"] },
    { id: "runtime.thinking", category: "runtime", group: "Active session", label: "Thinking level", description: "Set the reasoning depth for the active session.", keywords: ["reasoning", "minimal low medium high extra high"] },
    { id: "runtime.fast", category: "runtime", group: "Active session", label: "Fast mode", description: "Use accelerated serving when the selected model supports it.", keywords: ["speed accelerated"] },
    { id: "runtime.steering", category: "runtime", group: "Turn behavior", label: "Steering delivery", description: "Control how messages steer an active turn.", keywords: ["queue all one at a time"] },
    { id: "runtime.follow-up", category: "runtime", group: "Turn behavior", label: "Follow-up delivery", description: "Control how queued messages enter subsequent turns.", keywords: ["queue all one at a time"] },
    { id: "runtime.interrupt", category: "runtime", group: "Turn behavior", label: "Interrupt behavior", description: "Choose whether new input interrupts immediately or waits.", keywords: ["immediate wait safe boundary"] },
    { id: "runtime.compaction", category: "runtime", group: "Turn behavior", label: "Automatic compaction", description: "Compact context before it reaches the model limit.", keywords: ["context"] },
    { id: "runtime.retry", category: "runtime", group: "Turn behavior", label: "Automatic retry", description: "Retry recoverable provider failures without a manual resend.", keywords: ["provider failure"] },
  ];
  const APPLICATION_SEARCH_ENTRIES: readonly SettingsSearchEntry[] = [
    { id: "theme", category: "app-appearance", group: "Appearance", label: "Theme", description: "Color palette for the desktop window and controls.", keywords: ["dark light system"] },
    { id: "density", category: "app-appearance", group: "Appearance", label: "Interface density", description: "Choose the amount of spacing around controls and content.", keywords: ["comfortable compact spacing"] },
    { id: "reduceMotion", category: "app-appearance", group: "Appearance", label: "Reduce motion", description: "Limit interface animation in addition to the operating system preference.", keywords: ["animation accessibility"] },
    { id: "confirmCloseTab", category: "app-behavior", group: "Behavior", label: "Confirm before closing tabs", description: "Prompt before closing a tab containing active panes.", keywords: ["close confirmation"] },
    { id: "showToolDetails", category: "app-behavior", group: "Behavior", label: "Show tool details", description: "Show tool previews and argument badges in the transcript.", keywords: ["transcript previews arguments"] },
    { id: "terminal.shell", category: "terminal", group: "Terminal", label: "Shell", description: "Shell used for newly opened terminals.", keywords: ["command interpreter"] },
    { id: "terminal.fontFamily", category: "terminal", group: "Terminal", label: "Font family", description: "Font stack used by the terminal drawer.", keywords: ["typeface"] },
    { id: "terminal.fontSize", category: "terminal", group: "Terminal", label: "Font size", description: "Terminal font size from 8 to 48.", keywords: ["text scale"] },
    { id: "terminal.cursorStyle", category: "terminal", group: "Terminal", label: "Cursor style", description: "Shape used by the terminal cursor.", keywords: ["bar block underline"], optionLabels: ["Bar", "Block", "Underline"] },
    { id: "terminal.cursorBlink", category: "terminal", group: "Terminal", label: "Cursor blink", description: "Animate the terminal cursor while focused.", keywords: ["animation caret"] },
    { id: "terminal.scrollback", category: "terminal", group: "Terminal", label: "Scrollback", description: "Stored terminal lines from 500 to 100,000.", keywords: ["history lines"] },
    { id: "browser.defaultUrl", category: "browser", group: "Browser", label: "Default homepage URL", description: "Address loaded when creating new browser tabs.", keywords: ["home page new tab"] },
    { id: "browser.searchEngine", category: "browser", group: "Browser", label: "Search engine URL template", description: "Use %s where the search query should be inserted.", keywords: ["web search provider"] },
    { id: "workspace.defaultPath", category: "workspace", group: "Workspace", label: "Default root directory", description: "Root folder used for new workspaces.", keywords: ["path folder terminal surface"] },
  ];
  let bootstrap: BootstrapSnapshot | undefined;
  let kind: SessionKind = "work";
  let activeId = "";
  let planReviewsBySession = new Map<string, PlanReviewView>();
  let planReviewVisible = false;
  let planReviewSessionId = "";
  let planReviewOpener: HTMLElement | null = null;
  let lastAutomaticallyPresentedReviewId = "";
  let activePlanReview: PlanReviewView | undefined;
  let sessionSelectionToken = 0;
  let current: SessionSnapshot | undefined;
  let draft = "";
  const draftBySession = new Map<string, string>();
  let errorMessage = "";
  let promptFailure = "";
  type NoticeTone = "neutral" | "info" | "success" | "warning" | "error";
  interface ChatNotice {
    message: string;
    tone: NoticeTone;
    title: string;
  }
  let notice: ChatNotice | undefined;
  let extensionStatus = "";
  let extensionWidget = "";
  let extensionTitle = "";
  let aboutOpen = false;
  let aboutReturnFocus: HTMLButtonElement | undefined;
  let loading = false;
  let loadingOlder = false;
  let reasoningLoading = new Set<string>();
  let timelineToolDetails = new Map<string, TimelineToolActivity>();
  let timelineToolDetailLoading = new Set<string>();
  let timelineToolDetailErrors = new Map<string, string>();
  let openReasoning = new Set<string>();
  let renameValue = "";
  let renaming = false;
  let pendingExtension: ExtensionView | undefined;
  const respondedExtensionIds = new Set<string>();
  let selectedSubagent = "";
  let subagentTranscript = "";
  let subagentByte = 0;
  let subagentLoading = false;
  let subagentRequestToken = 0;
  let unsubscribe: (() => void) | undefined;
  let timelineScrollToken = 0;
  let timelineSessionSource: string | undefined;
  let timelineScroller: HTMLDivElement | undefined;
  let timelineContent: HTMLDivElement | undefined;
  let observedTimelineContent: HTMLDivElement | undefined;
  let timelineResizeObserver: ResizeObserver | undefined;
  let timelineProgrammaticScroll = false;
  let timelineProgrammaticScrollTimer: number | undefined;
  let followTimeline = true;
  let followBySession = new Map<string, boolean>();
  const TIMELINE_BOTTOM_THRESHOLD = 48;
  let promptAttachments: PromptAttachmentView[] = [];
  let attachmentInput: HTMLInputElement | undefined;
  let attachmentBusy = false;
  let attachmentStatus = "";
  let dragDepth = 0;
  let attachmentGeneration = 0;
  let spillInFlight = false;
  $: hasComposerContent = Boolean(draft.trim() || promptAttachments.length > 0);
  $: isComposerBusy = attachmentBusy || spillInFlight;
  $: if (promptAttachments.length > 0) reconcileAttachmentReferences(draft);
  interface AttachmentBatch {
    ids: string[];
    views: PromptAttachmentView[];
  }
  interface ComposeAdmission {
    sessionId: string;
    selectionToken: number;
  }
  interface PendingTurn {
    requestId?: string;
    attachmentIds: string[];
    attachments: PromptAttachmentView[];
    optimisticUserId: string;
    canonicalUserId?: string;
    optimisticAssistantId: string;
    startedAt: number;
    draft: string;
    reconciliation: "awaiting-ack" | "running" | "completed" | "rolled-back";
    resultReceived?: boolean;
  }
  interface MessageEditState {
    sessionId: string;
    timelineItemId: string;
    originalText: string;
    value: string;
    saving: boolean;
  }
  interface QueuedPrompt {
    sessionId: string;
    optimisticId: string;
    text: string;
    displayText: string;
    batch: AttachmentBatch;
    route: "steer" | "follow-up";
    status: "submitting" | "queued" | "steering" | "steered";
    error?: string;
    canonicalUserId?: string;
    canonicalItem?: TimelineItem;
  }
  let queuedPrompts = new Map<string, QueuedPrompt>();
  let pendingTurns = new Map<string, PendingTurn>();
  let messageEdit: MessageEditState | undefined;
  let messageEditTextarea: HTMLTextAreaElement | undefined;
  let messageEditComposing = false;
  let admittedAttachmentBatches = new Map<string, AttachmentBatch>();
  let earlyPromptResults = new Map<string, GradivusEvent>();
  let explicitStopSessions = new Set<string>();
  let canceledPromptTextsBySession = new Map<string, string[]>();
  let turnStartTime: number | null = null;
  let elapsedSeconds = 0;
  let isScrolledUp = false;
  let unseenCount = 0;
  let unseenIdsBySession = new Map<string, Set<string>>();
  let turnInterval: NodeJS.Timeout | undefined;
  let authAccounts: AuthAccountView[] = [];
  let authQuery = "";
  let oauthAccounts: OAuthAccountsView = { providers: [] };
  let authBusyProvider = "";
  let authBusyAccount = "";
  let authStatusMessage = "";
  let authDiscoveryError = "";
  let authPrompt: Extract<AuthEvent, { type: "prompt" }> | undefined;
  let authPromptValue = "";
  let unsubscribeAuth: (() => void) | undefined;
  let availableCommands: SlashCommand[] = [];
  let availableModels: ModelOption[] = [];
  let modelQuery = "";
  let modelProviderFilter = "all";
  let commandsLoading = false;
  let commandError = "";
  let commandRequestToken = 0;
  let commandMenuDismissed = false;
  let selectedCommandIndex = 0;
  let composerInput: HTMLTextAreaElement | undefined;
  let modelsLoading = false;
  let modelError = "";
  let modelRequestToken = 0;
  const EMPTY_PROVIDER_IDS = new Set<string>();
  let expandedOpenRouterModel = "";
  let openRouterRouting = new Map<string, OpenRouterModelRouting>();
  let openRouterRoutingLoading = new Set<string>();
  let openRouterRoutingErrors = new Map<string, string>();
  let openRouterProviderBusy = new Map<string, Set<string>>();
  let settingsRefreshing = false;
  let settingsBusy = new Set<SettingKey>();
  let settingsStatusMessage = "";
  let agentSettings: AgentSettingView[] = [];
  let agentSettingsBusy = new Set<string>();
  let agentPrompts: AgentPromptView[] = [];
  let agentPromptsLoading = false;
  let agentPromptsError = "";
  let agentPromptEditorDirty = false;
  let pendingSettingsNavigation: { category?: SettingsCategoryId; close?: true } | undefined;
  let settingsNavigationReturnFocus: HTMLElement | undefined;
  let promptDirtyDefaultAction: HTMLButtonElement | undefined;
  let activeAgentSettingTab: AgentSettingTab | undefined;
  let settingsSearchEntries: readonly SettingsSearchEntry[] = [];
  let settingsRequestGeneration = 0;
  let settingsRefreshToken = 0;
  let observedSettingsOpen = false;
  interface SettingsLoadGuard {
    generation: number;
    sessionId: string;
  }
  let selectedDiffPath = "";
  let selectedDiff: FileDiffView | undefined;
  let diffLoading = false;
  let diffError = "";
  let diffRequestToken = 0;
  let selectedProviderOverride = "";
  let terminalOpen = false;

  type InspectorTab = "agents" | "files";
  let inspectorOpen = false;
  let inspectorTab: InspectorTab = "agents";
  let fileInspectorTarget = "";
  let agentHubWindowOpen = false;
  let agentHubDialog: HTMLDialogElement | undefined;
  let agentHubReturnFocus: HTMLElement | undefined;
  let transcriptPane: HTMLElement | undefined;
  let agentHubPaneResizeObserver: ResizeObserver | undefined;
  let inspectorTabBySession = new Map<string, InspectorTab>();
  let todoEditBuffers = new Map<string, TodoEditBuffer>();
  let todoUndoStates = new Map<string, TodoState>();
  let todoWriteQueues = new Map<string, Promise<void>>();
  type ParityDialog = "compact" | "handoff" | "restart";
  let parityDialog: ParityDialog | undefined;
  let parityInstructions = "";
  let parityBusy: ParityDialog | "retry" | "stats" | "export" | "abort-retry" | undefined;
  let parityStatus = "";
  let sessionStats: SessionStatsView | undefined;
  let parityDefaultButton: HTMLButtonElement | undefined;
  let agentHubSnapshot: AgentHubSnapshot = { agents: [] };
  let agentHubSelectedAgentId = "";
  let agentHubSelectedAgent: AgentHubAgent | undefined;
  let agentHubSelectedBySession = new Map<string, string>();
  let agentHubMessages: unknown[] = [];
  let agentHubMessageByte = 0;
  let agentHubMessagesLoading = false;
  let agentHubMessageError = "";
  let agentHubDraft = "";
  let agentHubActionBusy = "";
  let agentHubRequestToken = 0;
  let agentHubUnreadBySession = new Map<string, Map<string, number>>();
  interface WorkspaceGroup {
    cwd: string;
    folderName: string;
    sessions: SessionRecordV1[];
    isRunning: boolean;
  }

  function extractFolderName(cwd: string): string {
    if (!cwd) return "Workspace";
    const parts = cwd.replace(/[\\/]+$/, "").split(/[\\/]/);
    return parts[parts.length - 1] || cwd;
  }

  let sessionLiveStatus = new Map<string, { status: "idle" | "running" | "error"; lastCompletedAt?: number; hasUnseenComplete?: boolean; planReview?: PlanReviewView["status"] }>();

  function updateSessionStatus(sessionId: string, status: "idle" | "running" | "error"): void {
    const prev = sessionLiveStatus.get(sessionId);
    const hasUnseen = (sessionId !== activeId && prev?.status === "running" && status === "idle") || Boolean(prev?.hasUnseenComplete && sessionId !== activeId);
    const next = new Map(sessionLiveStatus);
    next.set(sessionId, {
      status,
      lastCompletedAt: status === "idle" && prev?.status === "running" ? Date.now() : prev?.lastCompletedAt,
      hasUnseenComplete: hasUnseen,
      planReview: prev?.planReview,
    });
    sessionLiveStatus = next;
  }
  function setSessionPlanReview(sessionId: string, review: PlanReviewView | undefined): void {
    const reviews = new Map(planReviewsBySession);
    if (review) reviews.set(sessionId, review);
    else reviews.delete(sessionId);
    planReviewsBySession = reviews;
    const live = sessionLiveStatus.get(sessionId) ?? { status: "idle" as const };
    sessionLiveStatus = new Map(sessionLiveStatus).set(sessionId, {
      ...live,
      planReview: review?.status,
    });
    if (current?.record.id === sessionId) {
      current = { ...current, planReview: review };
    }
    onPlanReviewCountChange(reviews.size);
    if (!review && planReviewSessionId === sessionId) {
      planReviewVisible = false;
      planReviewSessionId = "";
    }
  }

  function syncSnapshotPlanReview(snapshot: SessionSnapshot): void {
    setSessionPlanReview(snapshot.record.id, snapshot.planReview);
  }

  function planReviewBlockingDialogOpen(): boolean {
    return Boolean(
      settingsRoute.open ||
      parityDialog ||
      sessionStats ||
      pendingSettingsNavigation ||
      aboutOpen ||
      authPrompt ||
      pendingExtension ||
      agentHubWindowOpen ||
      selectedDiffPath,
    );
  }

  async function maybePresentPlanReview(sessionId: string, review: PlanReviewView): Promise<void> {
    if (
      review.status !== "ready" ||
      review.id === lastAutomaticallyPresentedReviewId ||
      !active ||
      !chatPresentationReady ||
      activeId !== sessionId ||
      current?.record.id !== sessionId ||
      planReviewBlockingDialogOpen()
    ) return;
    await tick();
    if (!active || !chatPresentationReady || activeId !== sessionId || planReviewBlockingDialogOpen()) return;
    lastAutomaticallyPresentedReviewId = review.id;
    planReviewSessionId = sessionId;
    planReviewOpener = composerInput ?? null;
    planReviewVisible = true;
  }

  async function openActivePlanReview(trigger?: HTMLElement): Promise<void> {
    if (!current) return;
    const sessionId = current.record.id;
    let review = planReviewsBySession.get(sessionId);
    if (!review) {
      if (!current.planReviewSupported) {
        showNotice("Plan review controls require a current OMP runtime.", "warning", "Plan review unavailable");
        return;
      }
      try {
        review = await window.gradivus.requestPlanReview(sessionId);
        setSessionPlanReview(sessionId, review);
      } catch (error) {
        showError(error);
        return;
      }
    }
    planReviewSessionId = sessionId;
    planReviewOpener = trigger ?? composerInput ?? null;
    planReviewVisible = true;
  }

  function closePlanReview(): void {
    planReviewVisible = false;
    planReviewSessionId = "";
  }

  function planReviewDisabledReason(): string | undefined {
    if (!current) return "The chat is unavailable.";
    if (current.state === "stopped") return "OMP is stopped. Restart the chat to continue reviewing.";
    if (current.state === "error") return current.warning ?? "OMP disconnected. Reconnect before changing the plan.";
    return undefined;
  }

  async function updateVisiblePlanReview(input: {
    reviewId: string;
    content: string;
    expectedRevision: string;
    annotationState: PlanReviewView["annotationState"];
  }): Promise<PlanReviewView> {
    if (!current) throw new Error("No active chat");
    const updated = await window.gradivus.updatePlanReview(
      current.record.id,
      input.reviewId,
      input.content,
      input.expectedRevision,
      input.annotationState,
    );
    setSessionPlanReview(current.record.id, updated);
    return updated;
  }

  async function reloadVisiblePlanReview(): Promise<PlanReviewView> {
    if (!current) throw new Error("No active chat");
    const updated = await window.gradivus.requestPlanReview(current.record.id);
    setSessionPlanReview(current.record.id, updated);
    return updated;
  }

  async function resolveVisiblePlanReview(decision: Parameters<typeof window.gradivus.resolvePlanReview>[3]): Promise<PlanReviewResolutionResult> {
    if (!current || !activePlanReview) throw new Error("No active plan review");
    return window.gradivus.resolvePlanReview(
      current.record.id,
      activePlanReview.id,
      activePlanReview.revision,
      decision,
    );
  }

  function acceptPlanReview(result: PlanReviewResolutionResult): void {
    if (!result.accepted) return;
    closePlanReview();
    if (result.createdSession) {
      const snapshot = result.createdSession;
      if (bootstrap) {
        bootstrap = {
          ...bootstrap,
          registry: {
            ...bootstrap.registry,
            sessions: [...bootstrap.registry.sessions.filter(session => session.id !== snapshot.record.id), snapshot.record],
            activeByKind: { ...bootstrap.registry.activeByKind, [snapshot.record.kind]: snapshot.record.id },
          },
        };
      }
      void selectSession(snapshot.record.id);
      return;
    }
    if (result.awaitingRefinement) void tick().then(() => composerInput?.focus({ preventScroll: true }));
  }

  $: activePlanReview = planReviewsBySession.get(planReviewSessionId || activeId);
  $: if (active && chatPresentationReady && !settingsRoute.open && activePlanReview && !planReviewVisible) {
    void maybePresentPlanReview(activeId, activePlanReview);
  }

  $: workspaceGroups = (() => {
    const map = new Map<string, typeof sessions>();
    for (const session of sessions) {
      const key = session.cwd || "default";
      const list = map.get(key) || [];
      list.push(session);
      map.set(key, list);
    }
    const groups: WorkspaceGroup[] = [];
    for (const [cwd, groupSessions] of map.entries()) {
      const hasRunning = groupSessions.some(s => sessionLiveStatus.get(s.id)?.status === "running");
      groups.push({
        cwd,
        folderName: extractFolderName(cwd),
        sessions: groupSessions,
        isRunning: hasRunning,
      });
    }
    return groups;
  })();
  async function createNewChatInWorkspace(targetCwd?: string): Promise<void> {
    loading = true;
    try {
      const created = await window.gradivus.chooseAndCreate(kind, targetCwd);
      if (created) await selectSession(created.record.id);
    } catch (error) {
      showError(error);
    } finally {
      loading = false;
    }
  }

  $: currentModelParts = (() => {
    const model = current?.model ?? "";
    const slash = model.indexOf("/");
    return slash < 0 ? ["", model] : [model.slice(0, slash), model.slice(slash + 1)];
  })();
  $: currentProviderFromModel = currentModelParts[0] || (availableModels.find(m => m.id === currentModelParts[1])?.provider ?? "");
  $: activeProvider = selectedProviderOverride || currentProviderFromModel || modelProviders[0] || "";
  $: modelsForActiveProvider = availableModels.filter(model => model.provider === activeProvider);
  $: activeModelId = (selectedModelOption?.provider === activeProvider ? selectedModelOption.id : undefined) ?? currentModelParts[1] ?? (modelsForActiveProvider[0]?.id ?? "");
  $: contextLimit = current?.contextWindow ?? selectedModelOption?.contextWindow ?? 200_000;
  $: usedTokens = current?.contextTokens ?? 0;


  function handleProviderDropdownChange(newProvider: string): void {
    selectedProviderOverride = newProvider;
    const firstModel = availableModels.find(model => model.provider === newProvider);
    if (firstModel) {
      void changeModel(firstModel);
    }
  }

  function handleModelDropdownChange(newModelId: string): void {
    const target = availableModels.find(model => model.provider === activeProvider && model.id === newModelId)
      ?? availableModels.find(model => model.id === newModelId);
    if (target) {
      void changeModel(target);
    }
  }
  function stringDropdownValue(option: DropdownOption): string | undefined {
    return typeof option.value === "string" ? option.value : undefined;
  }

  function handleProviderDropdownSelect(option: DropdownOption): void {
    const provider = stringDropdownValue(option);
    if (provider !== undefined) handleProviderDropdownChange(provider);
  }

  function handleModelDropdownSelect(option: DropdownOption): void {
    const modelId = stringDropdownValue(option);
    if (modelId !== undefined) handleModelDropdownChange(modelId);
  }

  function handleThinkingDropdownSelect(option: DropdownOption): void {
    const thinking = stringDropdownValue(option);
    if (thinking !== undefined) void changeSetting("thinking", thinking as ThinkingLevel);
  }

  function handleQueueDropdownSelect(kind: "steering" | "follow-up", option: DropdownOption): void {
    const mode = stringDropdownValue(option);
    if (mode !== undefined) void changeQueueSetting(kind, mode as QueueMode);
  }

  function handleInterruptDropdownSelect(option: DropdownOption): void {
    const mode = stringDropdownValue(option);
    if (mode !== undefined) void changeInterruptSetting(mode as InterruptMode);
  }
  function handleModelProviderFilterSelect(option: DropdownOption): void {
    const provider = stringDropdownValue(option);
    if (provider !== undefined) modelProviderFilter = provider;
  }

  function formatProviderName(provider: string): string {
    if (!provider) return "Default";
    const map: Record<string, string> = {
      anthropic: "Anthropic",
      openai: "OpenAI",
      google: "Google",
      openrouter: "OpenRouter",
      deepseek: "DeepSeek",
      groq: "Groq",
      ollama: "Ollama",
      xai: "xAI",
      mistral: "Mistral",
      bedrock: "AWS Bedrock",
      vertex: "Google Vertex",
      azure: "Azure OpenAI",
    };
    return map[provider.toLowerCase()] ?? (provider.charAt(0).toUpperCase() + provider.slice(1));
  }

  function sessionDisplayName(record?: { title?: string | null; cwd?: string }, fallbackKind: SessionKind = kind): string {
    if (!record) return fallbackKind === "work" ? "Untitled workspace" : "Untitled code workspace";
    if (record.title && record.title.trim().length > 0) return record.title.trim();
    const folderName = record.cwd ? record.cwd.split(/[\\/]/).filter(Boolean).pop() : undefined;
    return folderName || (fallbackKind === "work" ? "Untitled workspace" : "Untitled code workspace");
  }
  type SessionViewModel = SessionSnapshot;

  function formatElapsed(seconds: number): string {
    const s = Math.max(0, Math.floor(seconds));
    const mins = Math.floor(s / 60);
    const secs = s % 60;
    return `${mins}:${secs.toString().padStart(2, "0")}s`;
  }

  function formatToolArgs(args: unknown, fallbackDetail?: string): string | undefined {
    if (!args && !fallbackDetail) return undefined;
    if (typeof args === "string") return args;
    if (args && typeof args === "object") {
      const record = args as Record<string, unknown>;
      const priorityKeys = ["path", "file", "command", "pattern", "query", "url", "action", "key", "signal", "name"];
      for (const key of priorityKeys) {
        if (record[key] !== undefined && record[key] !== null && typeof record[key] !== "object") {
          return String(record[key]);
        }
      }
      const entries = Object.entries(record);
      if (entries.length > 0) {
        const [k, v] = entries[0];
        if (v !== undefined && v !== null && typeof v !== "object") {
          return `${k}: ${String(v)}`;
        }
      }
    }
    if (fallbackDetail && fallbackDetail.trim().length > 0) {
      return fallbackDetail.trim();
    }
    return undefined;
  }

  function activeTurnActivity(current: SessionViewModel): { type: "thinking" | "tool" | "generating"; label: string; detail?: string } {
    const items = current.timeline ?? [];
    for (let i = items.length - 1; i >= 0; i--) {
      const item = items[i];
      if (item.status === "running" && item.kind === "tool") {
        const label = item.toolName || item.text || "Tool";
        const detail = formatToolArgs(item.args, item.detail);
        return { type: "tool", label, detail };
      }
    }
    for (let i = items.length - 1; i >= 0; i--) {
      const item = items[i];
      if (item.status === "running" && item.kind === "thinking") {
        const charCount = item.text?.length ?? 0;
        const tokens = Math.max(1, Math.round(charCount / 3.8));
        const detail = tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k tokens` : `${tokens} tokens`;
        return { type: "thinking", label: "Reasoning & Thinking...", detail };
      }
    }
    for (let i = items.length - 1; i >= 0; i--) {
      const item = items[i];
      if (item.kind === "assistant" && (item.status === "running" || (current.state === "running" && i === items.length - 1))) {
        const detail = current.tokensPerSecond && current.tokensPerSecond > 0
          ? `${Math.round(current.tokensPerSecond)} tok/s`
          : undefined;
        return { type: "generating", label: "Generating response...", detail };
      }
    }
    const pending = pendingTurns.get(current.record.id);
    if (pending) {
      return { type: "generating", label: pending.reconciliation === "awaiting-ack" ? "Preparing turn & thinking..." : "Generating response..." };
    }
    return { type: "generating", label: "Turn in progress..." };
  }

  function followIntent(sessionId: string | undefined = timelineSessionSource): boolean {
    if (!sessionId) return followTimeline;
    return followBySession.get(sessionId) ?? true;
  }

  function setFollowIntent(sessionId: string | undefined, following: boolean): void {
    if (sessionId) {
      const next = new Map(followBySession);
      next.set(sessionId, following);
      followBySession = next;
    }
    if (!sessionId || sessionId === timelineSessionSource) followTimeline = following;
  }

  function clearUnseen(sessionId: string | undefined = timelineSessionSource): void {
    if (!sessionId) {
      unseenCount = 0;
      return;
    }
    if (unseenIdsBySession.has(sessionId)) {
      const next = new Map(unseenIdsBySession);
      next.delete(sessionId);
      unseenIdsBySession = next;
    }
    if (sessionId === timelineSessionSource) unseenCount = 0;
  }

  function markUnseen(sessionId: string, itemId: string): void {
    const existing = unseenIdsBySession.get(sessionId) ?? new Set<string>();
    if (existing.has(itemId)) return;
    const nextIds = new Set(existing);
    nextIds.add(itemId);
    const next = new Map(unseenIdsBySession);
    next.set(sessionId, nextIds);
    unseenIdsBySession = next;
    if (sessionId === timelineSessionSource) unseenCount = nextIds.size;
  }

  function scrollTimelineElementToEnd(): void {
    if (!timelineScroller) return;
    const scrollBehavior = timelineScroller.style.scrollBehavior;
    timelineScroller.style.scrollBehavior = "auto";
    timelineScroller.scrollTop = timelineScroller.scrollHeight;
    timelineScroller.style.scrollBehavior = scrollBehavior;
  }

  function scrollToLatest(): void {
    const sessionId = timelineSessionSource;
    setFollowIntent(sessionId, true);
    clearUnseen(sessionId);
    scrollTimelineElementToEnd();
    isScrolledUp = false;
  }

  function ensureCanCompose(
    sessionId: string | undefined,
    selectionToken: number,
    snapshot = current,
    selectedId = activeId,
    isLoading = loading,
  ): sessionId is string {
    return !isLoading &&
      snapshot !== undefined &&
      snapshot.record.id === sessionId &&
      snapshot.record.id === selectedId &&
      selectionToken === sessionSelectionToken &&
      snapshot.state !== "starting" &&
      snapshot.state !== "stopping" &&
      snapshot.state !== "error";
  }

  $: {
    const pending = current ? pendingTurns.get(current.record.id) : undefined;
    if (pending) {
      if (turnStartTime !== pending.startedAt) {
        turnStartTime = pending.startedAt;
        elapsedSeconds = 0;
      }
      if (!turnInterval) {
        turnInterval = setInterval(() => {
          if (turnStartTime !== null) {
            elapsedSeconds = Math.max(0, Math.floor((Date.now() - turnStartTime) / 1000));
          }
        }, 500);
      }
    } else {
      if (turnStartTime !== null) turnStartTime = null;
      if (elapsedSeconds !== 0) elapsedSeconds = 0;
      if (turnInterval) {
        clearInterval(turnInterval);
        turnInterval = undefined;
      }
    }
  }
  $: sessions = bootstrap?.registry.sessions ?? [];
  $: onActiveSessionChange(activeId);
  $: hasSessions = sessions.length > 0;
  $: isTurnActive = Boolean(
    (current && pendingTurns.has(current.record.id))
    || current?.state === "running"
    || current?.isStreaming
    || current?.isCompacting
    || current?.retryState
    || parityBusy === "compact"
    || parityBusy === "handoff"
  );
  $: isRunning = isTurnActive;
  $: canCompose = ensureCanCompose(current?.record.id, sessionSelectionToken, current, activeId, loading);
  $: canEditMessages = Boolean(
    current &&
    canCompose &&
    !isTurnActive &&
    current.state === "ready" &&
    current.queuedMessageCount === 0
  );
  $: messageEditSubmitDisabled = !messageEdit ||
    messageEdit.saving ||
    !messageEdit.value.trim() ||
    messageEdit.value.trim() === messageEdit.originalText.trim();
  $: if (messageEdit && (current?.record.id !== messageEdit.sessionId || activeId !== messageEdit.sessionId)) {
    messageEdit = undefined;
    messageEditTextarea = undefined;
    messageEditComposing = false;
  } else if (messageEdit && !messageEdit.saving && !canEditMessages) {
    messageEdit = undefined;
    messageEditTextarea = undefined;
    messageEditComposing = false;
  }
  $: timelineItems = projectTimeline(current?.record.kind ?? "work", current?.timeline ?? []);
  $: visibleTimeline = timelineItems;
  $: turnFileSummaries = projectTurnFileSummaries(visibleTimeline);
  $: hiddenTimelineCount = current?.timelineStart ?? 0;
  $: outputFiles = changedFiles(current?.timeline ?? []);
  $: selectedAgent = current?.subagents.find(agent => agent.id === selectedSubagent);
  $: agentHubAgents = agentHubSnapshot.agents;
  $: agentHubSelectedAgent = agentHubAgents.find(agent => agent.id === agentHubSelectedAgentId);
  $: agentHubUnreadCount = Array.from(agentHubUnreadBySession.get(activeId)?.keys() ?? []).length;
  $: fileActivityCount = outputFiles.length;
  $: commandShortcuts = QUICK_COMMAND_NAMES.flatMap(name => {
    const command = availableCommands.find(candidate => candidate.name === name || candidate.aliases?.includes(name));
    return command ? [command] : [];
  }).slice(0, 4);
  $: todoEditBuffer = todoEditBuffers.get(activeId);
  $: todoUndoState = todoUndoStates.get(activeId);
  $: commandQuery = slashCommandQuery(draft);
  $: commandMatches = commandQuery === null ? [] : searchSlashCommands(availableCommands, commandQuery);
  $: commandMenuVisible = commandQuery !== null && !commandMenuDismissed && canCompose;
  $: if (selectedCommandIndex >= commandMatches.length) {
    const clamped = Math.max(0, commandMatches.length - 1);
    if (selectedCommandIndex !== clamped) selectedCommandIndex = clamped;
  }
  $: modelProviders = Array.from(new Set(availableModels.map(model => model.provider))).sort((left, right) => left.localeCompare(right));
  $: filteredModels = filterModelOptions(availableModels, modelQuery, modelProviderFilter, current?.model);
  $: visibleModels = filteredModels.slice(0, 120);
  $: filteredAuthAccounts = filterAuthAccounts(authAccounts, authQuery);
  $: selectedModelOption = availableModels.find(model => modelIdentifier(model) === current?.model);
  $: providerDropdownOptions = modelProviders.map(provider => ({
    key: provider,
    value: provider,
    label: formatProviderName(provider),
  }));
  $: composerModelDropdownOptions = modelsForActiveProvider.map(model => ({
    key: `${model.provider}/${model.id}`,
    value: model.id,
    label: model.name || model.id,
  }));
  $: modelFilterDropdownOptions = [
    { key: "all", value: "all", label: "All providers" },
    ...modelProviders.map(provider => ({ key: provider, value: provider, label: provider })),
  ];
  $: signedInAccountCount = authAccounts.filter(account => account.signedIn).length;
  $: activeAgentSettingTab = AGENT_SETTING_CATEGORIES.find(
    item => item.category === settingsRoute.activeCategory,
  )?.tab;
  $: settingsSearchEntries = buildSettingsSearchEntries(agentSettings, agentPrompts, authAccounts, oauthAccounts);
  $: if (timelineContent !== observedTimelineContent) {
    timelineResizeObserver?.disconnect();
    observedTimelineContent = timelineContent;
    if (timelineContent) {
      timelineResizeObserver = new ResizeObserver(() => {
        const sessionId = timelineSessionSource;
        if (sessionId && followIntent(sessionId)) void scrollTimelineToEnd(false, sessionId);
      });
      timelineResizeObserver.observe(timelineContent);
    } else {
      timelineResizeObserver = undefined;
    }
  }
  $: if (agentHubWindowOpen && agentHubDialog && !agentHubDialog.open) {
    syncAgentHubWindowGeometry();
    agentHubDialog.show();
    void tick().then(() =>
      agentHubDialog?.querySelector<HTMLElement>('[aria-label="Close Agent Hub session"]')?.focus(),
    );
  }
  $: if (settingsRoute.open && !observedSettingsOpen) {
    observedSettingsOpen = true;
    settingsRequestGeneration += 1;
    settingsStatusMessage = "";
    void refreshSettingsData();
  } else if (!settingsRoute.open && observedSettingsOpen) {
    observedSettingsOpen = false;
    settingsRequestGeneration += 1;
    settingsRefreshToken += 1;
    settingsRefreshing = false;
  }
  $: if (pendingSettingsNavigation && promptDirtyDefaultAction) {
    promptDirtyDefaultAction.focus({ preventScroll: true });
  }



  onMount(() => {
    unsubscribe = window.gradivus.onEvent(handleEvent);
    unsubscribeAuth = window.gradivus.onAuthEvent(handleAuthEvent);
    agentHubPaneResizeObserver = new ResizeObserver(syncAgentHubWindowGeometry);
    if (transcriptPane) agentHubPaneResizeObserver.observe(transcriptPane);
    void (async () => {
      try {
        applyAuthAccounts(await window.gradivus.getAuthStatus());
        bootstrap = await window.gradivus.bootstrap();
        const initial = bootstrap.registry.activeByKind.work ?? bootstrap.registry.activeByKind.code ?? bootstrap.registry.sessions[0]?.id;
        if (initial) await selectSession(initial);
      } catch (error) { showError(error); }
    })();
    return () => {
      discardVisibleAttachments();
      unsubscribe?.();
      unsubscribeAuth?.();
      clearTimelineProgrammaticScroll();
      timelineResizeObserver?.disconnect();
      agentHubPaneResizeObserver?.disconnect();
      if (turnInterval) clearInterval(turnInterval);
    };
  });

  function selectSessionFromRail(id: string): void {
    const live = sessionLiveStatus.get(id);
    if (live?.hasUnseenComplete) {
      updateSessionStatus(id, live.status);
    }
    void selectSession(id);
  }
  async function selectSession(id: string): Promise<void> {
    const sameSession = current?.record.id === id && activeId === id;
    if (!sameSession && current?.record.id) {
      discardVisibleAttachments(current.record.id);
      draftBySession.set(current.record.id, draft);
    }
    if (!sameSession) {
      agentHubWindowOpen = false;
      closePlanReview();
    }
    const requestToken = ++sessionSelectionToken;
    resetFileDiff();
    pendingExtension = undefined;
    resetOpenRouterModelState();
    if (!sameSession) resetSubagentSelection();
    if (!sameSession) resetAgentHubState(id);
    inspectorTab = inspectorTabBySession.get(id) ?? "agents";
    openReasoning = new Set();
    const storedFollow = followBySession.get(id) ?? true;
    setFollowIntent(id, storedFollow);
    isScrolledUp = !storedFollow;
    unseenCount = unseenIdsBySession.get(id)?.size ?? 0;
    if (!sameSession) draft = draftBySession.get(id) ?? "";
    activeId = id;
    timelineSessionSource = id;
    errorMessage = "";
    commandError = "";
    modelError = "";
    try {
      const snapshot = await window.gradivus.openSession(id);
      current = snapshot;
      syncSnapshotPlanReview(snapshot);
      if (snapshot.pendingExtension) pendingExtension = snapshot.pendingExtension;
      agentHubSnapshot = { agents: [] };
      if (snapshot.agentHub) applyAgentHubSnapshot(id, snapshot.agentHub);
      else void refreshAgentHub(id);
      if (agentHubSelectedAgentId) void loadAgentHubMessages(true);
      kind = snapshot.record.kind;
      availableCommands = snapshot.commands ?? [];
      availableModels = [];
      updateSessionStatus(id, snapshot.state === "running" ? "running" : snapshot.state === "error" ? "error" : "idle");
      if (bootstrap) {
        const existingIndex = bootstrap.registry.sessions.findIndex(s => s.id === id);
        const updatedSessions = existingIndex >= 0
          ? bootstrap.registry.sessions.map(session => session.id === id ? snapshot.record : session)
          : [snapshot.record, ...bootstrap.registry.sessions];
        bootstrap = {
          ...bootstrap,
          registry: {
            ...bootstrap.registry,
            activeByKind: { ...bootstrap.registry.activeByKind, [snapshot.record.kind]: id },
            sessions: updatedSessions,
          },
        };
      }
      void loadModels(id);
      void loadCommands(id);
      if (storedFollow) await scrollTimelineToEnd(!sameSession, id);
    } catch (error) {
      if (requestToken !== sessionSelectionToken || activeId !== id) return;
      showError(error);
    } finally {
      if (requestToken === sessionSelectionToken) loading = false;
    }
  }

  async function selectKind(nextKind: SessionKind): Promise<void> {
    kind = nextKind;
    resetFileDiff();
    resetSubagentSelection();
    const id = bootstrap?.registry.activeByKind[nextKind] ?? bootstrap?.registry.sessions.find(session => session.kind === nextKind)?.id;
    if (id) {
      await selectSession(id);
      loading = false;
    } else {
      if (current?.record.id) {
        discardVisibleAttachments(current.record.id);
        draftBySession.set(current.record.id, draft);
      }
      draft = "";
      sessionSelectionToken += 1;
      activeId = "";
      current = undefined;
      timelineSessionSource = undefined;
      loading = false;
      availableCommands = [];
      availableModels = [];
      resetOpenRouterModelState();
    }
  }

  async function openFileDiff(path: string): Promise<void> {
    if (!current) return;
    const sessionId = current.record.id;
    const requestToken = ++diffRequestToken;
    selectedDiffPath = path;
    selectedDiff = undefined;
    diffLoading = true;
    diffError = "";
    await tick();
    composerInput?.focus();
    try {
      const result = await window.gradivus.loadFileDiff(sessionId, path);
      if (requestToken !== diffRequestToken || current?.record.id !== sessionId) return;
      selectedDiff = result;
    } catch (error) {
      if (requestToken !== diffRequestToken || current?.record.id !== sessionId) return;
      diffError = error instanceof Error ? error.message : String(error);
    } finally {
      if (requestToken === diffRequestToken) diffLoading = false;
    }
  }

  function resetFileDiff(): void {
    diffRequestToken += 1;
    selectedDiffPath = "";
    selectedDiff = undefined;
    diffLoading = false;
    diffError = "";
  }

  function closeFileDiff(): void {
    resetFileDiff();
    void tick().then(() => composerInput?.focus());
  }

  async function revealOlder(): Promise<void> {
    if (!current || loadingOlder || hiddenTimelineCount <= 0) return;
    loadingOlder = true;
    const sessionId = current.record.id;
    const wasFollowing = followIntent(sessionId);
    try {
      const page = await window.gradivus.loadTimelinePage(sessionId, hiddenTimelineCount, 100);
      const scroller = timelineScroller;
      const previousHeight = scroller?.scrollHeight ?? 0;
      const previousTop = scroller?.scrollTop ?? 0;
      current = {
        ...current,
        timeline: [...page.items, ...current.timeline],
        timelineStart: page.start,
        timelineTotal: page.total,
      };
      await tick();
      if (scroller && scroller === timelineScroller) {
        scroller.scrollTop = previousTop + scroller.scrollHeight - previousHeight;
        const stillFollowing = wasFollowing && timelineAtBottom();
        setFollowIntent(sessionId, stillFollowing);
        isScrolledUp = !stillFollowing;
        if (stillFollowing) clearUnseen(sessionId);
      }
    } catch (error) {
      showError(error);
    } finally {
      loadingOlder = false;
    }
  }

  function timelineAtBottom(): boolean {
    if (!timelineScroller) return true;
    return timelineScroller.scrollHeight - timelineScroller.scrollTop - timelineScroller.clientHeight <= TIMELINE_BOTTOM_THRESHOLD;
  }

  function clearTimelineProgrammaticScroll(): void {
    timelineProgrammaticScroll = false;
    if (timelineProgrammaticScrollTimer !== undefined) {
      window.clearTimeout(timelineProgrammaticScrollTimer);
      timelineProgrammaticScrollTimer = undefined;
    }
    timelineScroller?.removeEventListener("scrollend", clearTimelineProgrammaticScroll);
  }

  function handleTimelineScroll(): void {
    if (timelineProgrammaticScroll) return;
    timelineScrollToken += 1;
    const atBottom = timelineAtBottom();
    if (atBottom) {
      setFollowIntent(timelineSessionSource, true);
      isScrolledUp = false;
      clearUnseen(timelineSessionSource);
      return;
    }
    setFollowIntent(timelineSessionSource, false);
    isScrolledUp = true;
    unseenCount = unseenIdsBySession.get(timelineSessionSource ?? "")?.size ?? 0;
  }

  async function scrollTimelineToEnd(force = false, sessionId = timelineSessionSource): Promise<void> {
    ++timelineScrollToken;
    await tick();
    if (!timelineScroller || sessionId !== timelineSessionSource) return;
    if (!force && !followIntent(sessionId)) return;
    scrollTimelineElementToEnd();
    setFollowIntent(sessionId, true);
    isScrolledUp = false;
    clearUnseen(sessionId);
  }

  async function createSession(): Promise<void> {
    loading = true;
    errorMessage = "";
    try {
      const snapshot = await window.gradivus.chooseAndCreate(kind);
      if (!snapshot) return;
      discardVisibleAttachments();
      current = snapshot;
      syncSnapshotPlanReview(snapshot);
      activeId = snapshot.record.id;
      timelineSessionSource = activeId;
      updateSessionStatus(activeId, snapshot.state === "running" ? "running" : "idle");
      if (bootstrap) {
        bootstrap = {
          ...bootstrap,
          registry: {
            ...bootstrap.registry,
            sessions: [...bootstrap.registry.sessions, snapshot.record],
            activeByKind: { ...bootstrap.registry.activeByKind, [kind]: snapshot.record.id },
          },
        };
      }
      availableCommands = snapshot.commands ?? [];
      availableModels = [];
      resetOpenRouterModelState();
      void loadModels(activeId);
      void loadCommands(activeId);
      await scrollTimelineToEnd(true, activeId);
    } catch (error) {
      showError(error);
    } finally {
      loading = false;
    }
  }

  async function resumeSession(): Promise<void> {
    if (!current) return;
    const id = current.record.id;
    loading = true;
    try {
      current = await window.gradivus.resume(id);
      updateSessionStatus(id, "idle");
      availableCommands = current.commands ?? [];
      void loadModels(id);
      void loadCommands(id);
    } catch (error) {
      showError(error);
    } finally {
      loading = false;
    }
  }

  async function stopSession(): Promise<void> {
    if (!current) return;
    if (current.state === "running" && !window.confirm("Stop the OMP session and interrupt this turn?")) return;
    const id = current.record.id;
    explicitStopSessions = new Set(explicitStopSessions).add(id);
    loading = true;
    try {
      current = await window.gradivus.stop(id);
      clearPendingTurn(id, true);
      updateSessionStatus(id, "idle");
      errorMessage = "";
    } catch (error) {
      showError(error);
    } finally {
      loading = false;
    }
  }
  function byteLength(value: string): number {
    return new TextEncoder().encode(value).byteLength;
  }

  function visibleAttachmentBytes(): number {
    return promptAttachments.reduce((total, attachment) => total + attachment.size, 0);
  }

  function attachmentDisplayName(name: string): string {
    const normalized = name.replaceAll("\\", "/");
    return normalized.slice(normalized.lastIndexOf("/") + 1) || "Attachment";
  }


  function restoreDraftAfterFailure(failedDraft: string): void {
    const newerDraft = draft;
    if (!newerDraft) {
      draft = failedDraft;
    } else if (!failedDraft) {
      draft = newerDraft;
    } else {
      draft = `${failedDraft}\n\n${newerDraft}`;
    }
  }

  function restoreAttachmentBatch(batch: AttachmentBatch): void {
    if (!batch.views.length) return;
    const existing = new Set(promptAttachments.map(attachment => attachment.id));
    promptAttachments = [...batch.views.filter(attachment => !existing.has(attachment.id)), ...promptAttachments];
  }

  function clearAttachmentInput(): void {
    if (attachmentInput) attachmentInput.value = "";
  }

  function hasFileDrag(event: DragEvent): boolean {
    return Array.from(event.dataTransfer?.types ?? []).includes("Files");
  }

  async function stageFiles(files: FileList | File[], insertionIndex = composerInput?.selectionEnd ?? draft.length): Promise<void> {
    const sessionId = current?.record.id;
    const selectionToken = sessionSelectionToken;
    if (!ensureCanCompose(sessionId, selectionToken) || attachmentBusy || spillInFlight) return;
    const admission: ComposeAdmission = { sessionId, selectionToken };
    const generation = attachmentGeneration;
    const selected = Array.from(files);
    const originalDraft = draft;
    const originalInsertionIndex = Math.min(Math.max(insertionIndex, 0), originalDraft.length);
    if (!selected.length) return;
    const incomingBytes = selected.reduce((total, file) => total + file.size, 0);
    if (promptAttachments.length + selected.length > MAX_PROMPT_ATTACHMENT_COUNT) {
      attachmentStatus = `You can attach up to ${MAX_PROMPT_ATTACHMENT_COUNT} files.`;
      clearAttachmentInput();
      return;
    }
    if (visibleAttachmentBytes() + incomingBytes > MAX_PROMPT_ATTACHMENT_BATCH_BYTES) {
      attachmentStatus = "Attachments exceed the 32 MiB batch limit.";
      clearAttachmentInput();
      return;
    }
    for (const file of selected) {
      if (file.size <= 0 || file.size > MAX_PROMPT_ATTACHMENT_BYTES) {
        attachmentStatus = `${file.name} exceeds the 25 MiB attachment limit.`;
        clearAttachmentInput();
        return;
      }
    }
    const uploads: PromptAttachmentUpload[] = [];
    attachmentBusy = true;
    attachmentStatus = `Staging ${selected.length} attachment${selected.length === 1 ? "" : "s"}…`;
    try {
      for (const file of selected) {
        uploads.push({ name: file.name, mimeType: file.type || undefined, data: new Uint8Array(await file.arrayBuffer()) });
      }
      if (!ensureCanCompose(admission.sessionId, admission.selectionToken)) return;
      const staged = await window.gradivus.stagePromptAttachments(sessionId, uploads);
      if (
        !ensureCanCompose(admission.sessionId, admission.selectionToken) ||
        current?.record.id !== sessionId ||
        attachmentGeneration !== generation
      ) {
        await window.gradivus.releasePromptAttachments(sessionId, staged.map(view => view.id));
        return;
      }
      const currentInsertionIndex = resolveAttachmentInsertionIndex(
        originalDraft,
        draft,
        originalInsertionIndex,
        composerInput?.selectionEnd ?? draft.length,
      );
      const insertion = insertAttachmentReferences(draft, staged, currentInsertionIndex);
      promptAttachments = [...promptAttachments, ...staged];
      draft = insertion.draft;
      commandMenuDismissed = false;
      await tick();
      composerInput?.focus({ preventScroll: true });
      composerInput?.setSelectionRange(insertion.caret, insertion.caret);
      attachmentStatus = `${staged.length} attachment${staged.length === 1 ? "" : "s"} ready.`;
    } catch (error) {
      attachmentStatus = error instanceof Error ? error.message : String(error);
    } finally {
      clearAttachmentInput();
      attachmentBusy = false;
    }
  }

  async function removeAttachment(view: PromptAttachmentView): Promise<void> {
    const sessionId = current?.record.id;
    const selectionToken = sessionSelectionToken;
    if (!ensureCanCompose(sessionId, selectionToken)) return;
    const previousDraft = draft;
    draft = removeAttachmentReference(draft, view.reference);
    promptAttachments = promptAttachments.filter(candidate => candidate.id !== view.id);
    attachmentStatus = "";
    try {
      await window.gradivus.releasePromptAttachments(sessionId, [view.id]);
    } catch (error) {
      if (current?.record.id === sessionId && sessionSelectionToken === selectionToken) {
        draft = previousDraft;
        restoreAttachmentBatch({ ids: [view.id], views: [view] });
      }
      attachmentStatus = error instanceof Error ? error.message : String(error);
    }
  }

  async function spillPromptText(value: string, startedAdmission?: ComposeAdmission): Promise<boolean> {
    const sessionId = startedAdmission?.sessionId ?? current?.record.id;
    const selectionToken = startedAdmission?.selectionToken ?? sessionSelectionToken;
    if (!ensureCanCompose(sessionId, selectionToken)) return false;
    const admission: ComposeAdmission = { sessionId, selectionToken };
    const valueBytes = byteLength(value);
    if (valueBytes <= MAX_INLINE_PROMPT_BYTES || spillInFlight) return valueBytes <= MAX_INLINE_PROMPT_BYTES;

    const sourceAttachments = attachmentsReferencedByDraft(value, promptAttachments);
    const sourceById = new Map(sourceAttachments.map(attachment => [attachment.id, attachment]));
    const sourceComposition = buildPromptComposition(value, sourceAttachments);
    const textPartCount = sourceComposition.parts.filter(part => part.type === "text" && part.text.length > 0).length;
    if (sourceAttachments.length + textPartCount > MAX_PROMPT_ATTACHMENT_COUNT) {
      attachmentStatus = `You can attach up to ${MAX_PROMPT_ATTACHMENT_COUNT} files.`;
      return false;
    }
    const sourceAttachmentBytes = sourceAttachments.reduce((total, attachment) => total + attachment.size, 0);
    if (sourceAttachmentBytes + valueBytes > MAX_PROMPT_ATTACHMENT_BATCH_BYTES) {
      attachmentStatus = "Attachments exceed the 32 MiB batch limit.";
      return false;
    }

    const generation = attachmentGeneration;
    const stagedPrompts: PromptAttachmentView[] = [];
    const orderedViews: PromptAttachmentView[] = [];
    spillInFlight = true;
    attachmentStatus = "Staging oversized prompt…";
    try {
      for (const part of sourceComposition.parts) {
        if (part.type === "attachment") {
          const attachment = sourceById.get(part.id);
          if (attachment) orderedViews.push(attachment);
          continue;
        }
        if (!part.text) continue;
        const staged = await window.gradivus.stagePromptText(sessionId, part.text);
        stagedPrompts.push(staged);
        orderedViews.push(staged);
      }
      if (
        !ensureCanCompose(admission.sessionId, admission.selectionToken) ||
        current?.record.id !== sessionId ||
        attachmentGeneration !== generation
      ) {
        await window.gradivus.releasePromptAttachments(sessionId, stagedPrompts.map(attachment => attachment.id));
        return false;
      }
      const retainedIds = new Set(sourceAttachments.map(attachment => attachment.id));
      const removedIds = promptAttachments
        .filter(attachment => !retainedIds.has(attachment.id))
        .map(attachment => attachment.id);
      if (removedIds.length > 0) await window.gradivus.releasePromptAttachments(sessionId, removedIds);
      promptAttachments = orderedViews;
      draft = orderedViews.map(attachment => attachment.reference).join(" ");
      attachmentStatus = "Oversized prompt sections are ready as contextual attachments.";
      return true;
    } catch (error) {
      if (stagedPrompts.length > 0) {
        await window.gradivus
          .releasePromptAttachments(sessionId, stagedPrompts.map(attachment => attachment.id))
          .catch(() => undefined);
      }
      attachmentStatus = error instanceof Error ? error.message : String(error);
      return false;
    } finally {
      spillInFlight = false;
    }
  }

  async function handleComposerPaste(event: ClipboardEvent): Promise<void> {
    const input = composerInput;
    const pasted = event.clipboardData?.getData("text/plain") ?? "";
    if (!input || !pasted) return;
    const start = input.selectionStart ?? draft.length;
    const end = input.selectionEnd ?? start;
    const composed = `${draft.slice(0, start)}${pasted}${draft.slice(end)}`;
    if (byteLength(composed) <= MAX_INLINE_PROMPT_BYTES) return;
    event.preventDefault();
    draft = composed;
    await spillPromptText(composed);
  }

  function handleDragEnter(event: DragEvent): void {
    if (!hasFileDrag(event)) return;
    event.preventDefault();
    dragDepth += 1;
  }

  function handleDragOver(event: DragEvent): void {
    if (!hasFileDrag(event)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
  }

  function handleDragLeave(event: DragEvent): void {
    if (!hasFileDrag(event)) return;
    event.preventDefault();
    dragDepth = Math.max(0, dragDepth - 1);
  }

  function handleDragEnd(): void {
    dragDepth = 0;
  }

  function handleDrop(event: DragEvent): void {
    if (!hasFileDrag(event)) return;
    event.preventDefault();
    dragDepth = 0;
    if (event.dataTransfer?.files.length) void stageFiles(event.dataTransfer.files);
  }
  function discardVisibleAttachments(sessionId = current?.record.id): void {
    attachmentGeneration += 1;
    const batch = takeAttachmentBatch();
    for (const attachment of batch.views) {
      draft = removeAttachmentReference(draft, attachment.reference);
    }
    if (sessionId) void releaseAttachmentBatch(sessionId, batch);
  }

  function takeAttachmentBatch(): AttachmentBatch {
    const views = promptAttachments;
    promptAttachments = [];
    attachmentStatus = "";
    return { views, ids: views.map(view => view.id) };
  }

  async function releaseAttachmentBatch(sessionId: string, batch: AttachmentBatch): Promise<void> {
    if (!batch.ids.length) return;
    try {
      await window.gradivus.releasePromptAttachments(sessionId, batch.ids);
    } catch (error) {
      attachmentStatus = error instanceof Error ? error.message : String(error);
    }
  }

  function retainAdmittedAttachmentBatch(sessionId: string, batch: AttachmentBatch): void {
    if (batch.ids.length === 0) return;
    const previous = admittedAttachmentBatches.get(sessionId);
    const ids = new Set(previous?.ids ?? []);
    const views = new Map((previous?.views ?? []).map(view => [view.id, view]));
    for (const id of batch.ids) ids.add(id);
    for (const view of batch.views) views.set(view.id, view);
    admittedAttachmentBatches = new Map(admittedAttachmentBatches).set(sessionId, {
      ids: [...ids],
      views: [...views.values()],
    });
  }

  async function releaseAdmittedAttachmentBatch(sessionId: string): Promise<void> {
    const batch = admittedAttachmentBatches.get(sessionId);
    if (!batch) return;
    const next = new Map(admittedAttachmentBatches);
    next.delete(sessionId);
    admittedAttachmentBatches = next;
    await releaseAttachmentBatch(sessionId, batch);
  }

  async function focusMessageEdit(timelineItemId: string): Promise<void> {
    await tick();
    if (messageEdit?.timelineItemId !== timelineItemId || !messageEditTextarea) return;
    messageEditTextarea.focus({ preventScroll: true });
    const caret = messageEditTextarea.value.length;
    messageEditTextarea.setSelectionRange(caret, caret);
  }

  function focusMessageEditAction(timelineItemId: string): void {
    void tick().then(() => {
      const buttons = timelineContent?.querySelectorAll<HTMLButtonElement>(".message-edit-button");
      const button = Array.from(buttons ?? []).find(candidate => candidate.dataset.timelineItemId === timelineItemId);
      button?.focus({ preventScroll: true });
    });
  }

  function startMessageEdit(item: TimelineItem): void {
    if (!current || item.kind !== "user" || !canEditMessages) return;
    messageEdit = {
      sessionId: current.record.id,
      timelineItemId: item.id,
      originalText: item.text,
      value: item.text,
      saving: false,
    };
    messageEditComposing = false;
    void focusMessageEdit(item.id);
  }

  function updateMessageEditValue(value: string): void {
    if (!messageEdit || messageEdit.saving) return;
    messageEdit = { ...messageEdit, value };
  }

  function cancelMessageEdit(): void {
    if (!messageEdit || messageEdit.saving) return;
    const timelineItemId = messageEdit.timelineItemId;
    messageEdit = undefined;
    messageEditTextarea = undefined;
    messageEditComposing = false;
    focusMessageEditAction(timelineItemId);
  }

  function removePendingTurnState(sessionId: string): void {
    if (!pendingTurns.has(sessionId)) return;
    const next = new Map(pendingTurns);
    next.delete(sessionId);
    pendingTurns = next;
  }

  function restoreEditedComposerText(sessionId: string, text: string): void {
    if (current?.record.id === sessionId && activeId === sessionId) {
      restoreDraftAfterFailure(text);
      commandMenuDismissed = false;
      return;
    }
    const savedDraft = draftBySession.get(sessionId) ?? "";
    draftBySession.set(sessionId, savedDraft ? `${text}\n\n${savedDraft}` : text);
  }

  async function submitMessageEdit(): Promise<void> {
    const editor = messageEdit;
    if (!editor || messageEditSubmitDisabled || !current || current.record.id !== editor.sessionId || !canEditMessages) return;
    const selectedIndex = current.timeline.findIndex(item => item.id === editor.timelineItemId);
    if (selectedIndex < 0) {
      showError("The message is no longer available to edit.");
      messageEdit = undefined;
      messageEditTextarea = undefined;
      return;
    }

    const preEditSnapshot = current;
    const editedText = editor.value.trim();
    const sessionId = editor.sessionId;
    const now = Date.now();
    const optimisticUserId = `opt-user-${now}-${++optimisticMessageSequence}`;
    const optimisticAssistantId = `opt-ast-${now}-${++optimisticMessageSequence}`;
    const optimisticUser: TimelineItem = {
      id: optimisticUserId,
      kind: "user",
      text: editedText,
      role: "user",
      createdAt: now,
    };
    const optimisticAssistant: TimelineItem = {
      id: optimisticAssistantId,
      kind: "thinking",
      text: "Reasoning & preparing response...",
      status: "running",
      role: "assistant",
      createdAt: now,
    };
    const timelineStart = preEditSnapshot.timelineStart ?? 0;
    const timeline = [
      ...preEditSnapshot.timeline.slice(0, selectedIndex),
      optimisticUser,
      optimisticAssistant,
    ];
    const timelineTotal = timelineStart + timeline.length;
    const shouldFollowTimeline = followIntent(sessionId);

    messageEdit = { ...editor, saving: true };
    errorMessage = "";
    promptFailure = "";
    current = {
      ...preEditSnapshot,
      state: "running",
      timeline,
      timelineStart,
      timelineTotal,
    };
    pendingTurns = new Map(pendingTurns).set(sessionId, {
      draft: editor.value,
      attachmentIds: [],
      attachments: [],
      optimisticUserId,
      optimisticAssistantId,
      startedAt: now,
      reconciliation: "awaiting-ack",
    });
    updateSessionStatus(sessionId, "running");
    setFollowIntent(sessionId, shouldFollowTimeline);
    if (shouldFollowTimeline) void scrollTimelineToEnd(true, sessionId);

    try {
      const result = await window.gradivus.editMessage(sessionId, editor.timelineItemId, editedText);
      if (result.cancelled) {
        removePendingTurnState(sessionId);
        earlyPromptResults.delete(sessionId);
        updateSessionStatus(sessionId, "idle");
        if (current?.record.id === sessionId && activeId === sessionId) {
          current = preEditSnapshot;
          if (messageEdit?.sessionId === sessionId) {
            messageEdit = { ...editor, saving: false };
            void focusMessageEdit(editor.timelineItemId);
          }
        }
        return;
      }

      if (result.error || !result.requestId) {
        const message = result.error ?? "OMP did not start the edited message.";
        removePendingTurnState(sessionId);
        earlyPromptResults.delete(sessionId);
        if (current?.record.id === sessionId && activeId === sessionId) current = result.snapshot;
        restoreEditedComposerText(sessionId, editor.value);
        if (messageEdit?.sessionId === sessionId) {
          messageEdit = undefined;
          messageEditTextarea = undefined;
          messageEditComposing = false;
        }
        promptFailure = message;
        updateSessionStatus(
          sessionId,
          result.snapshot.state === "running" ? "running" : result.snapshot.state === "error" ? "error" : "idle",
        );
        showError(message);
        return;
      }

      const pending = pendingTurns.get(sessionId);
      if (!pending || pending.reconciliation === "rolled-back") return;
      pendingTurns = new Map(pendingTurns).set(sessionId, {
        ...pending,
        requestId: result.requestId,
        reconciliation: "running",
      });
      if (messageEdit?.sessionId === sessionId) {
        messageEdit = undefined;
        messageEditTextarea = undefined;
        messageEditComposing = false;
      }
      const early = earlyPromptResults.get(sessionId);
      if (early && (!early.requestId || early.requestId === result.requestId)) {
        promptFailure = "";
        earlyPromptResults.delete(sessionId);
        await reconcilePromptResult(early);
      }
    } catch (error) {
      removePendingTurnState(sessionId);
      earlyPromptResults.delete(sessionId);
      updateSessionStatus(sessionId, "idle");
      if (current?.record.id === sessionId && activeId === sessionId) {
        current = preEditSnapshot;
        if (messageEdit?.sessionId === sessionId) {
          messageEdit = { ...editor, saving: false };
          void focusMessageEdit(editor.timelineItemId);
        }
      }
      showError(error);
    }
  }

  function handleMessageEditKeydown(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      cancelMessageEdit();
      return;
    }
    if (
      event.key !== "Enter" ||
      event.shiftKey ||
      event.isComposing ||
      messageEditComposing
    ) return;
    event.preventDefault();
    if (!messageEditSubmitDisabled) void submitMessageEdit();
  }

  function handleMessageEditSubmit(event: SubmitEvent): void {
    event.preventDefault();
    if (!messageEditSubmitDisabled) void submitMessageEdit();
  }

  async function sendPrimary(textInput?: string, startedAdmission?: ComposeAdmission): Promise<void> {
    const sessionId = startedAdmission?.sessionId ?? current?.record.id;
    const selectionToken = startedAdmission?.selectionToken ?? sessionSelectionToken;
    if (!ensureCanCompose(sessionId, selectionToken) || isComposerBusy) return;
    const admission: ComposeAdmission = { sessionId, selectionToken };
    const snapshot = current!;
    const rawText = typeof textInput === "string" ? textInput : draft;
    if (!rawText.trim() && promptAttachments.length === 0) return;
    if (byteLength(rawText) > MAX_INLINE_PROMPT_BYTES) {
      await spillPromptText(rawText, admission);
      return;
    }
    const text = rawText.trim();
    const awaitingReview = planReviewsBySession.get(sessionId);
    if (awaitingReview?.status === "awaiting_refinement") {
      const batch = takeAttachmentBatch();
      const composition = buildPromptComposition(text, batch.views);
      draft = "";
      commandMenuDismissed = true;
      errorMessage = "";
      try {
        const result = await window.gradivus.resolvePlanReview(
          sessionId,
          awaitingReview.id,
          awaitingReview.revision,
          { kind: "refine", feedback: "", composition },
        );
        if (!result.accepted) {
          await restoreRejectedAdmission(admission, rawText, batch);
          return;
        }
        setSessionPlanReview(sessionId, { ...awaitingReview, status: "applying", phase: "accepted" });
        await releaseAttachmentBatch(sessionId, batch);
      } catch (error) {
        await restoreRejectedAdmission(admission, rawText, batch);
        showError(error);
      }
      return;
    }
    const activeTurn = isTurnActive;
    if (activeTurn) {
      await admitActiveMessage("steer", rawText, admission);
      return;
    }
    const batch = takeAttachmentBatch();
    const composition = buildPromptComposition(text, batch.views);
    const shouldFollowTimeline = followIntent(sessionId);
    draft = "";
    commandMenuDismissed = true;
    errorMessage = "";
    promptFailure = "";

    const now = Date.now();
    const optUserId = `opt-user-${now}-${++optimisticMessageSequence}`;
    const optAstId = `opt-ast-${now}-${++optimisticMessageSequence}`;
    const optimisticText = text || attachmentDisplayName(batch.views[0]?.name ?? "Attached files");
    const userItem: TimelineItem = { id: optUserId, kind: "user", text: optimisticText, role: "user", createdAt: now };
    const astItem: TimelineItem = {
      id: optAstId,
      kind: "thinking",
      text: "Reasoning & preparing response...",
      status: "running",
      role: "assistant",
      createdAt: now,
    };
    const timeline = [...snapshot.timeline, userItem, astItem];
    const timelineTotal = (snapshot.timelineTotal ?? snapshot.timeline.length) + 2;
    current = { ...snapshot, state: "running", timeline, timelineStart: Math.max(0, timelineTotal - timeline.length), timelineTotal };
    pendingTurns = new Map(pendingTurns).set(sessionId, {
      draft: rawText,
      attachmentIds: batch.ids,
      attachments: batch.views,
      optimisticUserId: optUserId,
      optimisticAssistantId: optAstId,
      startedAt: now,
      reconciliation: "awaiting-ack",
    });
    updateSessionStatus(sessionId, "running");
    setFollowIntent(sessionId, shouldFollowTimeline);
    if (shouldFollowTimeline) void scrollTimelineToEnd(true, sessionId);

    const title = snapshot.record.title;
    const isDefaultTitle = !title || title.startsWith("New conversation") || title.startsWith("New Chat") || title.startsWith("Session ") || title === sessionId;
    const titleText = batch.views.reduce(
      (value, attachment) => value.replace(attachment.reference, ""),
      text,
    );
    if (isDefaultTitle && titleText) {
      const cleanTitle = titleText.replace(/^\[Subagent:\s*[^\]]+\]\s*/i, "").replace(/[#*`_~]/g, "").trim().slice(0, 38);
      if (cleanTitle) void renameSession(sessionId, cleanTitle);
    }

    try {
      const requestId = await window.gradivus.prompt(sessionId, composition);
      const pending = pendingTurns.get(sessionId);
      if (!pending || pending.reconciliation === "rolled-back") return;
      pendingTurns = new Map(pendingTurns).set(sessionId, { ...pending, requestId, reconciliation: "running" });
      const early = earlyPromptResults.get(sessionId);
      if (early && (!early.requestId || early.requestId === requestId)) {
        promptFailure = "";
        earlyPromptResults.delete(sessionId);
        await reconcilePromptResult(early);
      }
    } catch (error) {
      rollbackPendingTurn(sessionId, error instanceof Error ? error.message : String(error));
    }
  }


  async function queueFollowUp(): Promise<void> {
    await admitActiveMessage("follow-up");
  }

  function admittedMessageText(text: string, batch: AttachmentBatch): string {
    const normalized = promptAttachmentDisplayText(text);
    return normalized || batch.views.map(view => view.reference).join("\n") || "Attached files";
  }

  async function restoreRejectedAdmission(
    admission: ComposeAdmission,
    originalDraft: string,
    batch: AttachmentBatch,
  ): Promise<void> {
    if (current?.record.id === admission.sessionId && sessionSelectionToken === admission.selectionToken) {
      restoreDraftAfterFailure(originalDraft);
      restoreAttachmentBatch(batch);
      commandMenuDismissed = false;
      await tick();
      composerInput?.focus({ preventScroll: true });
      return;
    }
    await releaseAttachmentBatch(admission.sessionId, batch);
  }

  async function admitActiveMessage(
    route: "steer" | "follow-up",
    textInput?: string,
    startedAdmission?: ComposeAdmission,
  ): Promise<void> {
    const sessionId = startedAdmission?.sessionId ?? current?.record.id;
    const selectionToken = startedAdmission?.selectionToken ?? sessionSelectionToken;
    if (
      !ensureCanCompose(sessionId, selectionToken) ||
      !isTurnActive ||
      isComposerBusy ||
      (!(typeof textInput === "string" ? textInput : draft).trim() && promptAttachments.length === 0)
    ) return;
    const admission: ComposeAdmission = { sessionId, selectionToken };
    const originalDraft = typeof textInput === "string" ? textInput : draft;
    const text = originalDraft.trim();
    const batch = takeAttachmentBatch();
    const displayText = admittedMessageText(text, batch);
    const optimisticId = appendOptimisticUserMessage(sessionId, displayText);
    const admitted: QueuedPrompt = {
      sessionId,
      optimisticId,
      text,
      displayText,
      batch,
      route,
      status: "submitting",
    };
    queuedPrompts = new Map(queuedPrompts).set(optimisticId, admitted);
    draft = "";
    commandMenuDismissed = true;
    errorMessage = "";
    try {
      const composition = buildPromptComposition(text, batch.views);
      if (route === "steer") await window.gradivus.steer(sessionId, composition);
      else await window.gradivus.queueFollowUp(sessionId, composition);
      retainAdmittedAttachmentBatch(sessionId, batch);
      const currentAdmission = queuedPrompts.get(optimisticId);
      if (currentAdmission) {
        queuedPrompts = new Map(queuedPrompts).set(optimisticId, {
          ...currentAdmission,
          status: currentAdmission.canonicalUserId || route === "steer" ? "steered" : "queued",
          error: undefined,
        });
      }
      await refreshSessionMetrics(sessionId);
    } catch (error) {
      queuedPrompts = withoutQueuedPrompt(optimisticId);
      removeOptimisticUserMessage(sessionId, optimisticId);
      await restoreRejectedAdmission(admission, originalDraft, batch);
      showError(error);
    }
  }

  function withoutQueuedPrompt(id: string): Map<string, QueuedPrompt> {
    const next = new Map(queuedPrompts);
    next.delete(id);
    return next;
  }

  function findQueuedPromptForEvent(sessionId: string, item: TimelineItem): QueuedPrompt | undefined {
    if (item.kind !== "user" || item.id.startsWith("opt-")) return undefined;
    const itemText = promptAttachmentDisplayText(item.text);
    return [...queuedPrompts.values()].find(candidate =>
      candidate.sessionId === sessionId &&
      !candidate.canonicalUserId &&
      (promptAttachmentDisplayText(candidate.displayText) === itemText ||
        promptAttachmentDisplayText(candidate.text) === itemText),
    );
  }
  async function steerQueuedPrompt(id: string): Promise<void> {
    const queued = queuedPrompts.get(id);
    if (!queued || queued.status !== "queued") return;
    queuedPrompts = new Map(queuedPrompts).set(id, { ...queued, status: "steering", error: undefined });
    try {
      await window.gradivus.steerQueued(queued.sessionId, buildPromptComposition(queued.text, queued.batch.views));
      queuedPrompts = new Map(queuedPrompts).set(id, { ...queued, status: "steered", error: undefined });
      showNotice("Steering message sent", "success", "Steering");
      await refreshSessionMetrics(queued.sessionId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      queuedPrompts = new Map(queuedPrompts).set(id, { ...queued, status: "queued", error: message });
    }
  }
  async function abortTurn(): Promise<void> {
    if (!current) return;
    const sessionId = current.record.id;
    explicitStopSessions = new Set(explicitStopSessions).add(sessionId);
    try {
      await window.gradivus.abort(sessionId);
      clearPendingTurn(sessionId, true);
      errorMessage = "";
      showNotice("Turn stopped", "info", "Turn");
    } catch (error) {
      explicitStopSessions = new Set(explicitStopSessions);
      explicitStopSessions.delete(sessionId);
      showError(error);
    }
  }
  function rememberCanceledPrompt(sessionId: string, turn: PendingTurn): void {
    const text = turn.draft.trim();
    if (!text) return;
    const next = new Map(canceledPromptTextsBySession);
    const existing = next.get(sessionId) ?? [];
    next.set(sessionId, [...existing.filter(candidate => candidate !== text), text].slice(-4));
    canceledPromptTextsBySession = next;
  }

  function consumeCanceledPrompt(sessionId: string, text: string): boolean {
    const normalized = text.trim();
    if (!normalized) return false;
    const existing = canceledPromptTextsBySession.get(sessionId);
    if (!existing?.includes(normalized)) return false;
    const remaining = existing.filter(candidate => candidate !== normalized);
    const next = new Map(canceledPromptTextsBySession);
    if (remaining.length > 0) next.set(sessionId, remaining);
    else next.delete(sessionId);
    canceledPromptTextsBySession = next;
    return true;
  }

  function removeTurnItems(sessionId: string, turn: PendingTurn, removeUser: boolean): void {
    if (removeUser) rememberCanceledPrompt(sessionId, turn);
    if (current?.record.id !== sessionId) return;
    const removedIds = new Set([turn.optimisticAssistantId, ...(removeUser ? [turn.optimisticUserId, ...(turn.canonicalUserId ? [turn.canonicalUserId] : [])] : [])]);
    const timeline = current.timeline.filter(item => !removedIds.has(item.id));
    const removed = current.timeline.length - timeline.length;
    if (removed === 0) return;
    const timelineTotal = Math.max(0, (current.timelineTotal ?? current.timeline.length) - removed);
    current = { ...current, timeline, timelineStart: Math.max(0, timelineTotal - timeline.length), timelineTotal };
  }

  function clearPendingTurn(sessionId: string, removeUser: boolean): void {
    const turn = pendingTurns.get(sessionId);
    if (!turn) return;
    removeTurnItems(sessionId, turn, removeUser);
    if (current?.record.id === sessionId) {
      restoreDraftAfterFailure(turn.draft);
      restoreAttachmentBatch({ ids: turn.attachmentIds, views: turn.attachments });
    } else {
      void releaseAttachmentBatch(sessionId, { ids: turn.attachmentIds, views: turn.attachments });
    }
    const next = new Map(pendingTurns);
    next.delete(sessionId);
    pendingTurns = next;
  }

  function restorePendingAttachments(sessionId: string, turn: PendingTurn): void {
    const batch = { ids: turn.attachmentIds, views: turn.attachments };
    if (current?.record.id === sessionId) restoreAttachmentBatch(batch);
    else void releaseAttachmentBatch(sessionId, batch);
  }

  function rollbackPendingTurn(sessionId: string, message: string): void {
    const turn = pendingTurns.get(sessionId);
    if (turn) {
      removeTurnItems(sessionId, turn, true);
      restorePendingAttachments(sessionId, turn);
      const next = new Map(pendingTurns);
      next.delete(sessionId);
      pendingTurns = next;
    }
    if (current?.record.id === sessionId) {
      restoreDraftAfterFailure(turn?.draft ?? "");
      commandMenuDismissed = false;
      if (current.state === "running") {
        current = { ...current, state: "ready" };
      }
    }
    promptFailure = message;
    updateSessionStatus(sessionId, "error");
    showError(message);
  }

  async function reconcilePromptResult(event: GradivusEvent): Promise<void> {
    const sessionId = event.sessionId;
    const turn = pendingTurns.get(sessionId);
    if (!turn || turn.resultReceived) return;
    if (turn.requestId && event.requestId && turn.requestId !== event.requestId) return;
    const next = new Map(pendingTurns);
    next.set(sessionId, { ...turn, resultReceived: true, reconciliation: event.error ? "rolled-back" : "completed" });
    pendingTurns = next;
    if (event.error) {
      rollbackPendingTurn(sessionId, event.error.message);
      return;
    }
    if (event.agentInvoked === false) {
      removeTurnItems(sessionId, turn, true);
      restorePendingAttachments(sessionId, turn);
      const restored = new Map(pendingTurns);
      restored.delete(sessionId);
      pendingTurns = restored;
      if (current?.record.id === sessionId) {
        restoreDraftAfterFailure(turn.draft);
        current = { ...current, state: "ready" };
      }
      return;
    }
    removeTurnItems(sessionId, turn, false);
    await releaseAttachmentBatch(sessionId, { ids: turn.attachmentIds, views: turn.attachments });
    const cleared = new Map(pendingTurns);
    cleared.delete(sessionId);
    pendingTurns = cleared;
  }

  function preserveQueuedPrompts(sessionId: string, snapshot: SessionSnapshot): SessionSnapshot {
    let local = [...queuedPrompts.values()].filter(candidate => candidate.sessionId === sessionId);
    const serverQueuedCount = snapshot.queuedMessageCount ?? 0;
    const localQueued = local.filter(candidate => candidate.route === "follow-up" && candidate.status === "queued");
    const deliveredCount = Math.max(0, localQueued.length - serverQueuedCount);
    if (deliveredCount > 0) {
      const deliveredIds = new Set(localQueued.slice(0, deliveredCount).map(candidate => candidate.optimisticId));
      const next = new Map(queuedPrompts);
      for (const id of deliveredIds) {
        const candidate = next.get(id);
        if (candidate) next.set(id, { ...candidate, status: "steered", error: undefined });
      }
      queuedPrompts = next;
      local = [...next.values()].filter(candidate => candidate.sessionId === sessionId);
    }
    if (local.length === 0) return snapshot;
    let timeline = snapshot.timeline;
    let timelineTotal = snapshot.timelineTotal ?? snapshot.timeline.length;
    const settled: string[] = [];
    for (const queued of local) {
      const canonicalPresent = queued.canonicalUserId
        ? timeline.some(item =>
            item.id === queued.canonicalUserId ||
            (item.kind === "user" && item.text === queued.canonicalItem?.text),
          )
        : false;
      if (canonicalPresent) {
        settled.push(queued.optimisticId);
        continue;
      }
      if (timeline.some(item => item.id === queued.optimisticId)) continue;
      const item = queued.canonicalItem ?? {
        id: queued.optimisticId,
        kind: "user" as const,
        text: queued.displayText,
        role: "user",
        createdAt: Date.now(),
      };
      timeline = appendTimeline(timeline, item);
      timelineTotal += 1;
    }
    if (settled.length > 0) {
      const next = new Map(queuedPrompts);
      for (const id of settled) next.delete(id);
      queuedPrompts = next;
    }
    if (timeline === snapshot.timeline) return snapshot;
    return {
      ...snapshot,
      timeline,
      timelineStart: Math.max(0, timelineTotal - timeline.length),
      timelineTotal,
    };
  }

  async function refreshSessionMetrics(sessionId: string): Promise<void> {
    if (current?.record.id !== sessionId) return;
    try {
      const snapshot = await window.gradivus.openSession(sessionId);
      const mergedSnapshot = preserveQueuedPrompts(sessionId, snapshot);
      if (current?.record.id === sessionId) current = mergedSnapshot;
      if (bootstrap) {
        bootstrap = {
          ...bootstrap,
          registry: {
            ...bootstrap.registry,
            sessions: bootstrap.registry.sessions.map(session => session.id === sessionId ? mergedSnapshot.record : session),
          },
        };
      }
    } catch (error) {
      if (current?.record.id === sessionId) showError(error);
    }
  }

  async function renameSession(id: string, nextTitle: string): Promise<void> {
    if (!id || !nextTitle.trim()) return;
    const trimmed = nextTitle.trim();
    try {
      const updated = await window.gradivus.rename(id, trimmed);
      if (current && current.record.id === id) {
        current = updated;
      }
      if (bootstrap) {
        bootstrap = {
          ...bootstrap,
          registry: {
            ...bootstrap.registry,
            sessions: bootstrap.registry.sessions.map(s => (s.id === id ? { ...s, title: trimmed } : s)),
          },
        };
      }
    } catch (error) {
      showError(error);
    }
  }

  async function saveRename(): Promise<void> {
    if (!current || !renameValue.trim()) return;
    await renameSession(current.record.id, renameValue.trim());
    renaming = false;
  }
  async function deleteSessionFromRail(id: string): Promise<void> {
    const record = bootstrap?.registry.sessions.find(s => s.id === id);
    const name = record ? sessionDisplayName(record) : "this chat";
    if (!window.confirm(`Delete "${name}"? This permanently removes the chat from Gradivus. The OMP transcript file remains on disk.`)) return;
    try {
      const snapshot = await window.gradivus.deleteSession(id);
      bootstrap = { ...(bootstrap ?? snapshot), registry: snapshot.registry };
      sessionLiveStatus = (() => { const next = new Map(sessionLiveStatus); next.delete(id); return next; })();
      planReviewsBySession = (() => {
        const next = new Map(planReviewsBySession);
        next.delete(id);
        onPlanReviewCountChange(next.size);
        return next;
      })();
      unseenIdsBySession.delete(id);
      followBySession.delete(id);
      draftBySession.delete(id);
      if (current?.record.id === id || activeId === id) {
        const deletedKind: SessionKind = record?.kind ?? current?.record.kind ?? "work";
        const nextActive = snapshot.registry.activeByKind[deletedKind];
        if (nextActive && snapshot.registry.sessions.some(s => s.id === nextActive)) {
          await selectSession(nextActive);
        } else {
          discardVisibleAttachments();
          resetFileDiff();
          pendingExtension = undefined;
          sessionSelectionToken += 1;
          activeId = "";
          current = undefined;
          timelineSessionSource = undefined;
          availableCommands = [];
          availableModels = [];
          resetOpenRouterModelState();
        }
      }
      showNotice(`Deleted “${name}”.`, "info", "Chat");
    } catch (error) {
      showError(error);
    }
  }
  async function changeSetting(type: "thinking" | "fast", value: ThinkingLevel | boolean): Promise<void> {
    if (!current) return;
    const sessionId = current.record.id;
    if (type === "thinking" && typeof value === "string") {
      const level = value;
      await saveSessionSetting("thinking", () => window.gradivus.setThinking(sessionId, value), { thinkingLevel: value }, "Thinking level updated.");
    }
    if (type === "fast" && typeof value === "boolean") {
      const enabled = value;
      await saveSessionSetting("fast", () => window.gradivus.setFastMode(sessionId, value), { fastMode: value }, value ? "Fast mode enabled." : "Fast mode disabled.");
    }
  }

  async function changeModel(model: ModelOption): Promise<void> {
    if (!current) return;
    const sessionId = current.record.id;
    const providerId = model.provider;
    const modelId = model.id;
    selectedProviderOverride = model.provider;
    await saveSessionSetting(
      "model",
      () => window.gradivus.setModel(sessionId, model.provider, model.id),
      { model: `${model.provider}/${model.id}` },
      `Model changed to ${model.name}.`,
    );
  }

  async function changeQueueSetting(kind: "steering" | "follow-up", mode: QueueMode): Promise<void> {
    if (!current) return;
    const sessionId = current.record.id;
    await saveSessionSetting(
      kind,
      () => window.gradivus.setQueueMode(sessionId, kind, mode),
      kind === "steering" ? { steeringMode: mode } : { followUpMode: mode },
      `${kind === "steering" ? "Steering" : "Follow-up"} delivery updated.`,
    );
  }

  async function changeInterruptSetting(mode: InterruptMode): Promise<void> {
    if (!current) return;
    const sessionId = current.record.id;
    await saveSessionSetting(
      "interrupt",
      () => window.gradivus.setInterruptMode(sessionId, mode),
      { interruptMode: mode },
      "Interrupt behavior updated.",
    );
  }

  async function changeAutoCompaction(enabled: boolean): Promise<void> {
    if (!current) return;
    const sessionId = current.record.id;
    await saveSessionSetting(
      "compaction",
      () => window.gradivus.setAutoCompaction(sessionId, enabled),
      { autoCompactionEnabled: enabled },
      enabled ? "Automatic compaction enabled." : "Automatic compaction disabled.",
    );
  }

  async function changeAutoRetry(enabled: boolean): Promise<void> {
    if (!current) return;
    const sessionId = current.record.id;
    await saveSessionSetting(
      "retry",
      () => window.gradivus.setAutoRetry(sessionId, enabled),
      { autoRetryEnabled: enabled },
      enabled ? "Automatic retry enabled." : "Automatic retry disabled.",
    );
  }

  async function saveSessionSetting(
    key: SettingKey,
    action: () => Promise<void>,
    patch: Partial<SessionSnapshot>,
    message: string,
  ): Promise<void> {
    if (!current || settingsBusy.has(key)) return;
    const sessionId = current.record.id;
    const settingsGeneration = settingsRoute.open ? settingsRequestGeneration : undefined;
    const isResponseCurrent = (): boolean =>
      settingsGeneration === undefined
        ? current?.record.id === sessionId
        : isSettingsResponseCurrent(settingsGeneration, sessionId);
    setSettingBusy(key, true);
    settingsStatusMessage = "";
    try {
      await action();
      if (isResponseCurrent()) {
        current = { ...current, ...patch };
        settingsStatusMessage = message;
      }
    } catch (error) {
      if (isResponseCurrent()) {
        settingsStatusMessage = error instanceof Error ? error.message : String(error);
        showError(error);
      }
    } finally {
      setSettingBusy(key, false);
    }
  }

  function setSettingBusy(key: SettingKey, busy: boolean): void {
    const next = new Set(settingsBusy);
    if (busy) next.add(key);
    else next.delete(key);
    settingsBusy = next;
  }

  async function changeAgentSetting(setting: AgentSettingView, value: AgentSettingValue): Promise<void> {
    if (agentSettingsBusy.has(setting.path)) return;
    const generation = settingsRequestGeneration;
    const sessionId =
      current && current.state !== "stopped" && current.state !== "error" ? current.record.id : undefined;
    setAgentSettingBusy(setting.path, true);
    settingsStatusMessage = "";
    try {
      const updated = await window.gradivus.setAgentSetting(sessionId, setting.path, value);
      if (isSettingsResponseCurrent(generation, sessionId)) {
        agentSettings = agentSettings.map(candidate => candidate.path === updated.path ? updated : candidate);
        settingsStatusMessage = `${updated.label} updated.${updated.apply === "next-session" ? " Starts with the next session." : ""}`;
      }
    } catch (error) {
      if (isSettingsResponseCurrent(generation, sessionId)) {
        settingsStatusMessage = error instanceof Error ? error.message : String(error);
        showError(error);
      }
    } finally {
      setAgentSettingBusy(setting.path, false);
    }
  }

  function setAgentSettingBusy(path: string, busy: boolean): void {
    const next = new Set(agentSettingsBusy);
    if (busy) next.add(path);
    else next.delete(path);
    agentSettingsBusy = next;
  }

  function changeAgentSettingFromDropdown(setting: AgentSettingView, option: DropdownOption): void {
    void changeAgentSetting(setting, option.value);
  }

  async function saveAgentPrompt(
    name: string,
    scope: AgentPromptScope,
    systemPrompt: string,
    expectedRevision: string | null,
  ): Promise<AgentPromptView> {
    const sessionId = current?.record.id;
    const updated = await window.gradivus.saveAgentPrompt(sessionId, name, scope, systemPrompt, expectedRevision);
    agentPrompts = agentPrompts.map(agent => agent.name === updated.name ? updated : agent);
    return updated;
  }

  async function resetAgentPrompt(
    name: string,
    scope: AgentPromptScope,
    expectedRevision: string,
  ): Promise<AgentPromptView> {
    const sessionId = current?.record.id;
    const updated = await window.gradivus.resetAgentPrompt(sessionId, name, scope, expectedRevision);
    agentPrompts = agentPrompts.map(agent => agent.name === updated.name ? updated : agent);
    return updated;
  }

  function captureSettingsReturnFocus(): void {
    settingsNavigationReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
  }

  function requestSettingsCategoryChange(activeCategory: SettingsCategoryId): boolean {
    if (activeCategory === settingsRoute.activeCategory) return false;
    if (agentPromptEditorDirty && settingsRoute.activeCategory === "omp-agents") {
      captureSettingsReturnFocus();
      pendingSettingsNavigation = { category: activeCategory };
      return false;
    }
    onSettingsRouteChange({ activeCategory });
    return true;
  }
  function requestCloseSettings(): void {
    if (agentPromptEditorDirty && settingsRoute.activeCategory === "omp-agents") {
      captureSettingsReturnFocus();
      pendingSettingsNavigation = { close: true };
      return;
    }
    onCloseSettings();
  }

  function keepPromptDraft(): void {
    pendingSettingsNavigation = undefined;
    void tick().then(() => settingsNavigationReturnFocus?.focus({ preventScroll: true }));
  }

  function discardPromptDraftAndNavigate(): void {
    const pending = pendingSettingsNavigation;
    pendingSettingsNavigation = undefined;
    agentPromptEditorDirty = false;
    if (pending?.category) onSettingsRouteChange({ activeCategory: pending.category });
    else if (pending?.close) onCloseSettings();
  }

  async function loadCommands(sessionId: string): Promise<void> {
    const requestToken = ++commandRequestToken;
    commandsLoading = true;
    commandError = "";
    try {
      const commands = await window.gradivus.getAvailableCommands(sessionId);
      if (requestToken === commandRequestToken && current?.record.id === sessionId) availableCommands = commands;
    } catch (error) {
      if (requestToken === commandRequestToken && current?.record.id === sessionId) commandError = error instanceof Error ? error.message : String(error);
    } finally {
      if (requestToken === commandRequestToken) commandsLoading = false;
    }
  }

  async function loadModels(sessionId: string, settingsGuard?: SettingsLoadGuard): Promise<void> {
    const requestToken = ++modelRequestToken;
    modelsLoading = true;
    modelError = "";
    try {
      const models = await window.gradivus.getAvailableModels(sessionId);
      const valid = requestToken === modelRequestToken && current?.record.id === sessionId &&
        (!settingsGuard || isSettingsResponseCurrent(settingsGuard.generation, settingsGuard.sessionId));
      if (valid) availableModels = models;
    } catch (error) {
      const valid = requestToken === modelRequestToken && current?.record.id === sessionId &&
        (!settingsGuard || isSettingsResponseCurrent(settingsGuard.generation, settingsGuard.sessionId));
      if (valid) modelError = error instanceof Error ? error.message : String(error);
    } finally {
      if (requestToken === modelRequestToken) modelsLoading = false;
    }
  }
  function resetOpenRouterModelState(): void {
    expandedOpenRouterModel = "";
    openRouterRouting = new Map();
    openRouterRoutingLoading = new Set();
    openRouterRoutingErrors = new Map();
    openRouterProviderBusy = new Map();
  }

  function toggleOpenRouterModel(model: ModelOption): void {
    if (expandedOpenRouterModel === model.id) {
      expandedOpenRouterModel = "";
      return;
    }
    expandedOpenRouterModel = model.id;
    if (!openRouterRouting.has(model.id) && !openRouterRoutingLoading.has(model.id)) {
      void loadOpenRouterModelRouting(model.id);
    }
  }

  async function loadOpenRouterModelRouting(modelId: string): Promise<void> {
    if (!current || openRouterRoutingLoading.has(modelId)) return;
    const sessionId = current.record.id;
    const generation = settingsRequestGeneration;
    openRouterRoutingLoading = new Set(openRouterRoutingLoading).add(modelId);
    const errors = new Map(openRouterRoutingErrors);
    errors.delete(modelId);
    openRouterRoutingErrors = errors;
    try {
      const routing = await window.gradivus.getOpenRouterModelRouting(sessionId, modelId);
      if (isSettingsResponseCurrent(generation, sessionId)) {
        const next = new Map(openRouterRouting);
        next.set(modelId, routing);
        openRouterRouting = next;
      }
    } catch (error) {
      if (isSettingsResponseCurrent(generation, sessionId)) {
        const next = new Map(openRouterRoutingErrors);
        next.set(modelId, error instanceof Error ? error.message : String(error));
        openRouterRoutingErrors = next;
      }
    } finally {
      const next = new Set(openRouterRoutingLoading);
      next.delete(modelId);
      openRouterRoutingLoading = next;
    }
  }

  async function changeOpenRouterProvider(model: ModelOption, providerId: string, enabled: boolean): Promise<void> {
    if (!current) return;
    const sessionId = current.record.id;
    const generation = settingsRequestGeneration;
    const providerName = openRouterRouting.get(model.id)?.providers.find(provider => provider.id === providerId)?.name ?? providerId;
    setOpenRouterProviderBusy(model.id, providerId, true);
    const errors = new Map(openRouterRoutingErrors);
    errors.delete(model.id);
    openRouterRoutingErrors = errors;
    try {
      const routing = await window.gradivus.setOpenRouterProviderEnabled(sessionId, model.id, providerId, enabled);
      if (isSettingsResponseCurrent(generation, sessionId)) {
        const next = new Map(openRouterRouting);
        next.set(model.id, routing);
        openRouterRouting = next;
        settingsStatusMessage = `${providerName} ${enabled ? "enabled" : "excluded"} for ${model.name}.`;
      }
    } catch (error) {
      if (isSettingsResponseCurrent(generation, sessionId)) {
        const message = error instanceof Error ? error.message : String(error);
        const next = new Map(openRouterRoutingErrors);
        next.set(model.id, message);
        openRouterRoutingErrors = next;
        settingsStatusMessage = message;
      }
    } finally {
      setOpenRouterProviderBusy(model.id, providerId, false);
    }
  }

  function setOpenRouterProviderBusy(modelId: string, providerId: string, busy: boolean): void {
    const next = new Map(openRouterProviderBusy);
    const providers = new Set(next.get(modelId) ?? EMPTY_PROVIDER_IDS);
    if (busy) providers.add(providerId);
    else providers.delete(providerId);
    if (providers.size > 0) next.set(modelId, providers);
    else next.delete(modelId);
    openRouterProviderBusy = next;
  }

  function openSettingsFromTrigger(category: SettingsCategoryId, trigger: HTMLElement): void {
    onOpenSettings(category, trigger);
    settingsStatusMessage = "";
  }
  function openSettings(category: SettingsCategoryId, event: Event): void {
    const trigger = event.currentTarget;
    if (trigger instanceof HTMLElement) openSettingsFromTrigger(category, trigger);
  }

  function isSettingsResponseCurrent(generation: number | undefined, sessionId: string | undefined): boolean {
    const currentSessionId =
      current && current.state !== "stopped" && current.state !== "error" ? current.record.id : undefined;
    return settingsRoute.open && generation === settingsRequestGeneration && currentSessionId === sessionId;
  }
  function isAgentPromptResponseCurrent(generation: number, sessionId: string | undefined): boolean {
    return settingsRoute.open && generation === settingsRequestGeneration && current?.record.id === sessionId;
  }
  function isApplicationSettingsCategory(category: SettingsCategoryId): category is ApplicationSettingsCategoryId {
    return category === "app-appearance" || category === "app-behavior" || category === "terminal" || category === "browser" || category === "workspace";
  }
  async function refreshSettingsData(): Promise<void> {
    if (!settingsRoute.open || settingsRefreshing) return;
    settingsRefreshing = true;
    const refreshToken = ++settingsRefreshToken;
    const generation = settingsRequestGeneration;
    const promptSessionId = current?.record.id;
    agentPromptsLoading = true;
    agentPromptsError = "";
    const activeSessionId =
      current && current.state !== "stopped" && current.state !== "error" ? current.record.id : undefined;
    const tasks: Promise<unknown>[] = [
      window.gradivus.getAuthStatus().then(accounts => {
        if (isSettingsResponseCurrent(generation, activeSessionId)) applyAuthAccounts(accounts);
      }),
      window.gradivus.getOAuthAccounts().then(accounts => {
        if (isSettingsResponseCurrent(generation, activeSessionId)) oauthAccounts = accounts;
      }),
      window.gradivus.getAgentSettings(activeSessionId).then(settings => {
        if (isSettingsResponseCurrent(generation, activeSessionId)) agentSettings = settings;
      }),
      window.gradivus.getAgentPrompts(promptSessionId).then(prompts => {
        if (isAgentPromptResponseCurrent(generation, promptSessionId)) agentPrompts = prompts;
      }).catch(error => {
        if (isAgentPromptResponseCurrent(generation, promptSessionId)) {
          agentPromptsError = error instanceof Error ? error.message : String(error);
        }
        throw error;
      }),
    ];
    if (activeSessionId) tasks.push(loadModels(activeSessionId, { generation, sessionId: activeSessionId }));
    const results = await Promise.allSettled(tasks);
    if (refreshToken !== settingsRefreshToken) return;
    if (settingsRoute.open && generation === settingsRequestGeneration) {
      const failure = results.find(result => result.status === "rejected");
      if (failure?.status === "rejected") settingsStatusMessage = failure.reason instanceof Error ? failure.reason.message : String(failure.reason);
    }
      if (isAgentPromptResponseCurrent(generation, promptSessionId)) agentPromptsLoading = false;
    settingsRefreshing = false;
  }
  async function refreshOAuthAccounts(settingsGuard?: SettingsLoadGuard): Promise<void> {
    const generation = settingsGuard?.generation;
    const sessionId = settingsGuard?.sessionId;
    try {
      const accounts = await window.gradivus.getOAuthAccounts();
      if (!settingsGuard || isSettingsResponseCurrent(generation, sessionId)) oauthAccounts = accounts;
    } catch (error) {
      if (!settingsGuard || isSettingsResponseCurrent(generation, sessionId)) authStatusMessage = error instanceof Error ? error.message : String(error);
    }
  }
  async function setAccountLock(providerId: string, credentialId?: number): Promise<void> {
    authBusyAccount = providerId;
    const generation = settingsRequestGeneration;
    const sessionId =
      current && current.state !== "stopped" && current.state !== "error" ? current.record.id : undefined;
    try {
      const accounts = await window.gradivus.setOAuthAccountLock(providerId, credentialId);
      if (isSettingsResponseCurrent(generation, sessionId)) oauthAccounts = accounts;
    } catch (error) {
      if (isSettingsResponseCurrent(generation, sessionId)) authStatusMessage = error instanceof Error ? error.message : String(error);
    } finally {
      authBusyAccount = "";
    }
  }

  async function setAccountFailover(enabled: boolean): Promise<void> {
    authBusyAccount = "failover";
    const generation = settingsRequestGeneration;
    const sessionId =
      current && current.state !== "stopped" && current.state !== "error" ? current.record.id : undefined;
    try {
      const accounts = await window.gradivus.setOAuthAccountFailover(enabled);
      if (isSettingsResponseCurrent(generation, sessionId)) oauthAccounts = accounts;
    } catch (error) {
      if (isSettingsResponseCurrent(generation, sessionId)) authStatusMessage = error instanceof Error ? error.message : String(error);
    } finally {
      authBusyAccount = "";
    }
  }

  async function removeAccount(providerId: string, credentialId: number): Promise<void> {
    if (!window.confirm("Remove this provider account from OMP?")) return;
    authBusyAccount = `${providerId}:${credentialId}`;
    const generation = settingsRequestGeneration;
    const sessionId =
      current && current.state !== "stopped" && current.state !== "error" ? current.record.id : undefined;
    try {
      const accounts = await window.gradivus.removeOAuthAccount(providerId, credentialId);
      if (isSettingsResponseCurrent(generation, sessionId)) oauthAccounts = accounts;
    } catch (error) {
      if (isSettingsResponseCurrent(generation, sessionId)) authStatusMessage = error instanceof Error ? error.message : String(error);
    } finally {
      authBusyAccount = "";
    }
  }

  function reconcileAttachmentReferences(value: string): void {
    if (promptAttachments.length === 0) return;
    const referenced = attachmentsReferencedByDraft(value, promptAttachments);
    if (referenced.length === promptAttachments.length) return;
    const referencedIds = new Set(referenced.map(attachment => attachment.id));
    const removedIds = promptAttachments
      .filter(attachment => !referencedIds.has(attachment.id))
      .map(attachment => attachment.id);
    promptAttachments = referenced;
    attachmentStatus = `${removedIds.length} attachment${removedIds.length === 1 ? "" : "s"} removed with its prompt reference.`;
    const sessionId = current?.record.id;
    if (sessionId) {
      void window.gradivus.releasePromptAttachments(sessionId, removedIds).catch(error => {
        if (current?.record.id === sessionId) {
          attachmentStatus = error instanceof Error ? error.message : String(error);
        }
      });
    }
  }

  function handleComposerInput(event: Event): void {
    const value = (event.currentTarget as HTMLTextAreaElement).value;
    reconcileAttachmentReferences(value);
    if (byteLength(value) > MAX_INLINE_PROMPT_BYTES && !spillInFlight && current) {
      void spillPromptText(value);
      return;
    }
    commandMenuDismissed = false;
    selectedCommandIndex = 0;
    if (slashCommandQuery(value) !== null && availableCommands.length === 0 && current) void loadCommands(current.record.id);
  }

  function handleComposerKeydown(event: KeyboardEvent): void {
    if (event.isComposing) return;
    if (commandMenuVisible) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const direction = event.key === "ArrowDown" ? 1 : -1;
        selectedCommandIndex = commandMatches.length === 0
          ? 0
          : (selectedCommandIndex + direction + commandMatches.length) % commandMatches.length;
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        commandMenuDismissed = true;
        return;
      }
      if (event.key === "Tab") {
        event.preventDefault();
        const selected = commandMatches[selectedCommandIndex];
        if (selected) applyCommand(selected);
        return;
      }
      if (event.key === "Enter" && !event.shiftKey) {
        const sessionId = current?.record.id;
        const selectionToken = sessionSelectionToken;
        if (!ensureCanCompose(sessionId, selectionToken)) return;
        const admission: ComposeAdmission = { sessionId, selectionToken };
        event.preventDefault();
        const selected = commandMatches[selectedCommandIndex];
        if (selected && draft.trim() !== `/${selected.name}`) {
          applyCommand(selected);
          return;
        }
        commandMenuDismissed = true;
        void sendPrimary(undefined, admission);
        return;
      }
    }
    if (event.key === "Enter" && !event.shiftKey) {
      const sessionId = current?.record.id;
      const selectionToken = sessionSelectionToken;
      if (!ensureCanCompose(sessionId, selectionToken)) return;
      const admission: ComposeAdmission = { sessionId, selectionToken };
      event.preventDefault();
      void sendPrimary(undefined, admission);
    }
  }

  function applyCommand(command: SlashCommand): void {
    draft = commandInsertion(command);
    commandMenuDismissed = true;
    void tick().then(() => composerInput?.focus());
  }
  function openCommandPalette(): void {
    draft = "/";
    commandMenuDismissed = false;
    selectedCommandIndex = 0;
    void tick().then(() => composerInput?.focus());
  }
  function modelIdentifier(model: ModelOption): string {
    return `${model.provider}/${model.id}`;
  }

  function filterModelOptions(
    models: ModelOption[],
    query: string,
    provider: string,
    selectedModel: string | undefined,
  ): ModelOption[] {
    const needle = query.trim().toLowerCase();
    return models
      .filter(model => provider === "all" || model.provider === provider)
      .filter(model => !needle || `${model.name} ${model.provider} ${model.id}`.toLowerCase().includes(needle))
      .sort((left, right) =>
        Number(modelIdentifier(right) === selectedModel) - Number(modelIdentifier(left) === selectedModel) ||
        left.name.localeCompare(right.name) ||
        left.provider.localeCompare(right.provider),
      );
  }

  function filterAuthAccounts(accounts: AuthAccountView[], query: string): AuthAccountView[] {
    const needle = query.trim().toLowerCase();
    return needle
      ? accounts.filter(account => `${account.name} ${account.provider}`.toLowerCase().includes(needle))
      : accounts;
  }
  function buildSettingsSearchEntries(
    settings: readonly AgentSettingView[],
    prompts: readonly AgentPromptView[],
    providers: readonly AuthAccountView[],
    oauth: OAuthAccountsView,
  ): readonly SettingsSearchEntry[] {
    const entries: SettingsSearchEntry[] = [...RUNTIME_SEARCH_ENTRIES];
    for (const category of AGENT_SETTING_CATEGORIES) {
      for (const setting of settings) {
        if (setting.tab !== category.tab) continue;
        entries.push({
          id: `omp:${setting.path}`,
          category: category.category,
          group: setting.group ?? "General",
          label: setting.label,
          description: setting.description,
          keywords: [],
          path: setting.path,
          optionLabels: (setting.options ?? []).flatMap(option => [
            option.label,
            ...(option.description ? [option.description] : []),
          ]),
          apply: setting.apply,
        });
      }
    }
    entries.push({
      id: "agents.editor",
      category: "omp-agents",
      group: "Subagent definitions",
      label: "Subagent prompt editor",
      description: "Edit project and user prompt overrides used on the next subagent spawn.",
      keywords: ["agents system prompt project user reset"],
    });
    for (const agent of prompts) {
      entries.push({
        id: `agents:${agent.name}`,
        category: "omp-agents",
        group: "Subagent definitions",
        label: agent.name,
        description: agent.description,
        keywords: [agent.effectiveSource, "system prompt override"],
      });
    }
    entries.push({
      id: "accounts.search",
      category: "accounts",
      group: "Provider access",
      label: "Search providers",
      description: "Find a public OMP provider and its sign-in actions.",
      keywords: ["authentication sign in sign out"],
    });
    entries.push(
      {
        id: "accounts.providers",
        category: "accounts",
        group: "Provider access",
        label: "Provider sign-in",
        description: "Sign in to or out of providers reported by the local runtime.",
        keywords: ["authentication connect disconnect"],
      },
      {
        id: "accounts.failover",
        category: "accounts",
        group: "OAuth accounts",
        label: "Allow account failover",
        description: "Use another OAuth account only when failover is enabled.",
        keywords: ["credential routing"],
      },
      {
        id: "accounts.lock",
        category: "accounts",
        group: "OAuth accounts",
        label: "Lock OAuth account",
        description: "Keep a provider routed through one local account.",
        keywords: ["credential routing clear lock"],
      },
      {
        id: "accounts.remove",
        category: "accounts",
        group: "OAuth accounts",
        label: "Remove OAuth account",
        description: "Remove a locally stored OAuth account from a provider.",
        keywords: ["credential sign out delete"],
      },
    );
    for (const provider of providers) {
      entries.push({
        id: `accounts.provider:${provider.provider}`,
        category: "accounts",
        group: "Provider access",
        label: `${provider.name} provider access`,
        description: "Open a provider sign-in flow or sign out locally.",
        keywords: [provider.provider, provider.name, "authentication sign in sign out"],
      });
    }
    for (const provider of oauth.providers) {
      entries.push({
        id: `accounts.oauth:${provider.id}`,
        category: "accounts",
        group: "OAuth accounts",
        label: `${provider.name} OAuth accounts`,
        description: "Configure failover, account locking, and local account removal.",
        keywords: [provider.id, provider.name, "credential routing failover lock remove"],
      });
    }
    entries.push({
      id: "accounts.security",
      category: "accounts",
      group: "Security",
      label: "Local credential security",
      description: "Credentials remain managed by the local OMP runtime.",
      keywords: ["redacted private authentication"],
    });
    entries.push(...APPLICATION_SEARCH_ENTRIES);
    return entries.map((entry, sourceOrder) => ({ ...entry, sourceOrder }));
  }

  function isSettingVisible(visibleSettingIds: ReadonlySet<string>, id: string): boolean {
    return visibleSettingIds.has(id);
  }

  function hasVisibleSetting(visibleSettingIds: ReadonlySet<string>, ids: readonly string[]): boolean {
    return ids.some(id => visibleSettingIds.has(id));
  }

  function visibleAgentSettingGroups(
    visibleSettingIds: ReadonlySet<string>,
    tab: AgentSettingTab,
  ): Array<{ name: string; settings: AgentSettingView[] }> {
    return groupAgentSettings(
      agentSettings.filter(setting => visibleSettingIds.has(`omp:${setting.path}`)),
      tab,
    );
  }

  function settingsCategoryTitle(tab: AgentSettingTab): string {
    return AGENT_SETTING_CATEGORIES.find(category => category.tab === tab)?.label ?? "OMP defaults";
  }


  function groupAgentSettings(
    settings: AgentSettingView[],
    tab: AgentSettingTab,
  ): Array<{ name: string; settings: AgentSettingView[] }> {
    const groups = new Map<string, AgentSettingView[]>();
    for (const setting of settings) {
      if (setting.tab !== tab) continue;
      const name = setting.group ?? "General";
      const values = groups.get(name);
      if (values) values.push(setting);
      else groups.set(name, [setting]);
    }
    return Array.from(groups, ([name, values]) => ({ name, settings: values }));
  }

  function formatContextWindow(tokens: number | undefined): string | undefined {
    if (!tokens) return undefined;
    if (tokens >= 1_000_000) return `${Number((tokens / 1_000_000).toFixed(1))}M context`;
    return `${Math.round(tokens / 1_000)}K context`;
  }

  async function resumeSettingsSession(): Promise<void> {
    await resumeSession();
    if (current && current.state !== "stopped" && current.state !== "error") {
      await loadModels(current.record.id).catch(showError);
    }
  }


  function resetSubagentSelection(): void {
    subagentRequestToken += 1;
    selectedSubagent = "";
    subagentTranscript = "";
    subagentByte = 0;
    subagentLoading = false;
  }

  async function inspectSubagent(agent: SubagentView): Promise<void> {
    if (!current) return;
    const sessionId = current.record.id;
    const agentId = agent.id;
    if (selectedSubagent !== agentId) {
      selectedSubagent = agentId;
      subagentTranscript = "";
      subagentByte = 0;
    }
    const requestToken = ++subagentRequestToken;
    const fromByte = subagentByte;
    subagentLoading = true;
    try {
      const result = await window.gradivus.getSubagentMessages(sessionId, agentId, fromByte);
      if (requestToken !== subagentRequestToken || current?.record.id !== sessionId || selectedSubagent !== agentId) return;
      const value = result as { nextByte?: number; reset?: boolean; messages?: unknown[] };
      if (value.reset) {
        subagentByte = 0;
        subagentTranscript = "";
      }
      if (Array.isArray(value.messages)) {
        const chunk = value.messages.map(message => formatMessage(message)).join("\n\n");
        if (chunk) subagentTranscript = subagentTranscript ? `${subagentTranscript}\n\n${chunk}` : chunk;
      }
      if (typeof value.nextByte === "number") subagentByte = value.nextByte;
    } catch (error) {
      if (requestToken === subagentRequestToken && current?.record.id === sessionId && selectedSubagent === agentId) showError(error);
    } finally {
      if (requestToken === subagentRequestToken && current?.record.id === sessionId && selectedSubagent === agentId) subagentLoading = false;
    }
  }
  function resetAgentHubState(sessionId?: string): void {
    agentHubRequestToken += 1;
    agentHubMessages = [];
    agentHubMessageByte = 0;
    agentHubMessagesLoading = false;
    agentHubMessageError = "";
    agentHubDraft = "";
    agentHubActionBusy = "";
    if (sessionId) {
      const selected = agentHubSelectedBySession.get(sessionId);
      agentHubSelectedAgentId = selected ?? "";
    } else {
      agentHubSelectedAgentId = "";
    }
  }

  function clearAgentHubUnread(sessionId: string, agentId?: string): void {
    const unread = agentHubUnreadBySession.get(sessionId);
    if (!unread) return;
    const nextUnread = new Map(unread);
    if (agentId) nextUnread.delete(agentId);
    else nextUnread.clear();
    const next = new Map(agentHubUnreadBySession);
    if (nextUnread.size > 0) next.set(sessionId, nextUnread);
    else next.delete(sessionId);
    agentHubUnreadBySession = next;
  }

  function applyAgentHubSnapshot(sessionId: string, snapshot: AgentHubSnapshot): void {
    if (current?.record.id !== sessionId) return;
    const previous = agentHubSnapshot;
    const unread = new Map(agentHubUnreadBySession.get(sessionId) ?? []);
    for (const agent of snapshot.agents) {
      const old = previous.agents.find(candidate => candidate.id === agent.id);
      if (old && agent.lastActivity > old.lastActivity && (agent.id !== agentHubSelectedAgentId || inspectorTab !== "agents")) {
        unread.set(agent.id, agent.lastActivity);
      }
    }
    const nextUnread = new Map(agentHubUnreadBySession);
    if (unread.size > 0) nextUnread.set(sessionId, unread);
    else nextUnread.delete(sessionId);
    agentHubUnreadBySession = nextUnread;
    agentHubSnapshot = snapshot;
    current = { ...current, agentHub: snapshot };
    const selected = agentHubSelectedBySession.get(sessionId);
    if (!selected || !snapshot.agents.some(agent => agent.id === selected)) {
      const nextSelected = snapshot.agents[0]?.id ?? "";
      agentHubSelectedAgentId = nextSelected;
      const selectedBySession = new Map(agentHubSelectedBySession);
      if (nextSelected) selectedBySession.set(sessionId, nextSelected);
      else selectedBySession.delete(sessionId);
      agentHubSelectedBySession = selectedBySession;
      resetAgentHubState(sessionId);
      if (nextSelected) void loadAgentHubMessages(true);
    }
  }

  async function refreshAgentHub(sessionId = current?.record.id): Promise<void> {
    if (!sessionId) return;
    try {
      const snapshot = await window.gradivus.getAgentHub(sessionId);
      if (current?.record.id === sessionId) applyAgentHubSnapshot(sessionId, snapshot);
    } catch (error) {
      if (current?.record.id === sessionId) agentHubMessageError = error instanceof Error ? error.message : String(error);
    }
  }

  async function loadAgentHubMessages(reset = false): Promise<void> {
    const sessionId = current?.record.id;
    const agentId = agentHubSelectedAgentId;
    if (!sessionId || !agentId) return;
    const requestToken = ++agentHubRequestToken;
    const fromByte = reset ? 0 : agentHubMessageByte;
    agentHubMessagesLoading = true;
    agentHubMessageError = "";
    await tick();
    try {
      const page: AgentHubMessagePage = await window.gradivus.getAgentHubMessages(sessionId, agentId, fromByte);
      if (requestToken !== agentHubRequestToken || current?.record.id !== sessionId || agentHubSelectedAgentId !== agentId) return;
      const entries = page.messages.length > 0 ? page.messages : page.entries;
      if (reset || page.reset) {
        agentHubMessages = [...entries];
        agentHubMessageByte = page.nextByte;
      } else {
        if (entries.length > 0) agentHubMessages = [...agentHubMessages, ...entries];
        agentHubMessageByte = Math.max(agentHubMessageByte, page.nextByte);
      }
    } catch (error) {
      if (requestToken === agentHubRequestToken && current?.record.id === sessionId) {
        agentHubMessageError = error instanceof Error ? error.message : String(error);
      }
    } finally {
      if (requestToken === agentHubRequestToken) agentHubMessagesLoading = false;
    }
  }

  async function selectAgentHubAgent(agentId: string): Promise<void> {
    if (!current || !agentHubSnapshot.agents.some(agent => agent.id === agentId)) return;
    const sessionId = current.record.id;
    agentHubSelectedAgentId = agentId;
    const selectedBySession = new Map(agentHubSelectedBySession);
    selectedBySession.set(sessionId, agentId);
    agentHubSelectedBySession = selectedBySession;
    clearAgentHubUnread(sessionId, agentId);
    agentHubReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    agentHubWindowOpen = true;
    resetAgentHubState(sessionId);
    agentHubSelectedAgentId = agentId;
    await loadAgentHubMessages(true);
  }

  async function sendAgentHubMessage(message: string): Promise<void> {
    const sessionId = current?.record.id;
    const agentId = agentHubSelectedAgentId;
    const text = message.trim();
    if (!sessionId || !agentId || !text || agentHubActionBusy) return;
    agentHubActionBusy = "message";
    agentHubMessageError = "";
    try {
      await window.gradivus.agentHubMessage(sessionId, agentId, text);
      agentHubDraft = "";
      await refreshAgentHub(sessionId);
      await loadAgentHubMessages();
    } catch (error) {
      agentHubMessageError = error instanceof Error ? error.message : String(error);
    } finally {
      agentHubActionBusy = "";
    }
  }

  async function killAgentHubAgent(agentId: string): Promise<void> {
    const sessionId = current?.record.id;
    if (!sessionId || agentHubActionBusy) return;
    agentHubActionBusy = "kill";
    try {
      await window.gradivus.agentHubKill(sessionId, agentId);
      await refreshAgentHub(sessionId);
    } catch (error) {
      agentHubMessageError = error instanceof Error ? error.message : String(error);
    } finally {
      agentHubActionBusy = "";
    }
  }

  async function reviveAgentHubAgent(agentId: string): Promise<void> {
    const sessionId = current?.record.id;
    if (!sessionId || agentHubActionBusy) return;
    agentHubActionBusy = "revive";
    try {
      await window.gradivus.agentHubRevive(sessionId, agentId);
      await refreshAgentHub(sessionId);
    } catch (error) {
      agentHubMessageError = error instanceof Error ? error.message : String(error);
    } finally {
      agentHubActionBusy = "";
    }
  }

  async function clearAgentHubAgent(agentId: string): Promise<void> {
    const sessionId = current?.record.id;
    if (!sessionId || agentHubActionBusy) return;
    agentHubActionBusy = "clear";
    agentHubMessageError = "";
    try {
      await window.gradivus.agentHubClear(sessionId, agentId);
      await refreshAgentHub(sessionId);
    } catch (error) {
      agentHubMessageError = error instanceof Error ? error.message : String(error);
    } finally {
      agentHubActionBusy = "";
    }
  }

  function updateTodoEditBuffer(sessionId: string, nextBuffer: TodoEditBuffer | undefined): void {
    const next = new Map(todoEditBuffers);
    if (nextBuffer) next.set(sessionId, nextBuffer);
    else next.delete(sessionId);
    todoEditBuffers = next;
  }

  function saveTodoEdits(
    sessionId: string,
    phases: TodoPhase[],
    expectedRevision: number,
    action: string,
  ): Promise<TodoState> {
    const result = Promise.withResolvers<TodoState>();
    const previousAcknowledged = current?.record.id === sessionId ? structuredClone(current.todoState) : undefined;
    const queued = (todoWriteQueues.get(sessionId) ?? Promise.resolve())
      .catch(() => undefined)
      .then(async () => {
        try {
          const updated = await window.gradivus.setTodos(sessionId, phases, expectedRevision, action);
          if (previousAcknowledged) {
            const nextUndo = new Map(todoUndoStates);
            nextUndo.set(sessionId, previousAcknowledged);
            todoUndoStates = nextUndo;
          }
          if (current?.record.id === sessionId) current = { ...current, todoState: updated };
          result.resolve(updated);
        } catch (error) {
          result.reject(error);
        }
      });
    todoWriteQueues.set(sessionId, queued);
    void queued.finally(() => {
      if (todoWriteQueues.get(sessionId) === queued) todoWriteQueues.delete(sessionId);
    });
    return result.promise;
  }

  async function undoTodoEdits(sessionId: string): Promise<TodoState> {
    const previous = todoUndoStates.get(sessionId);
    if (!previous || current?.record.id !== sessionId) throw new Error("No todo edit is available to undo.");
    const updated = await saveTodoEdits(
      sessionId,
      previous.phases,
      current.todoState.revision,
      "Undid the previous desktop todo edit",
    );
    const nextUndo = new Map(todoUndoStates);
    nextUndo.delete(sessionId);
    todoUndoStates = nextUndo;
    return updated;
  }

  async function reloadTodoState(sessionId: string): Promise<TodoState> {
    const snapshot = await window.gradivus.openSession(sessionId);
    if (current?.record.id === sessionId) current = { ...current, todoState: snapshot.todoState };
    return snapshot.todoState;
  }
  function openParityDialog(kind: ParityDialog): void {
    parityDialog = kind;
    parityInstructions = "";
    parityStatus = "";
    void tick().then(() => parityDefaultButton?.focus({ preventScroll: true }));
  }

  function closeParityDialog(): void {
    if (parityBusy === "compact" || parityBusy === "handoff" || parityBusy === "restart") return;
    parityDialog = undefined;
    parityInstructions = "";
  }

  async function refreshAfterParity(sessionId: string): Promise<SessionSnapshot> {
    const snapshot = await window.gradivus.openSession(sessionId);
    if (current?.record.id === sessionId) {
      current = snapshot;
      syncSnapshotPlanReview(snapshot);
      timelineSessionSource = sessionId;
    }
    return snapshot;
  }

  async function runContextMutation(kind: "compact" | "handoff"): Promise<void> {
    if (!current || parityBusy) return;
    const sessionId = current.record.id;
    parityBusy = kind;
    parityStatus = "";
    try {
      const result = kind === "compact"
        ? await window.gradivus.compact(sessionId, parityInstructions)
        : await window.gradivus.handoff(sessionId, parityInstructions);
      await refreshAfterParity(sessionId);
      parityDialog = undefined;
      parityInstructions = "";
      parityStatus = kind === "handoff" && !result.changed
        ? "Nothing to hand off."
        : `${kind === "compact" ? "Context compacted" : "Hand off complete"}: ${result.beforeTokens.toLocaleString()} → ${result.afterTokens.toLocaleString()} tokens.`;
    } catch (error) {
      parityStatus = error instanceof Error ? error.message : String(error);
    } finally {
      parityBusy = undefined;
    }
  }

  async function retryLastTurn(): Promise<void> {
    if (!current || parityBusy) return;
    parityBusy = "retry";
    parityStatus = "";
    try {
      const result = await window.gradivus.retry(current.record.id);
      parityStatus = result.started ? "Retry started." : "Nothing to retry.";
    } catch (error) {
      parityStatus = error instanceof Error ? error.message : String(error);
    } finally {
      parityBusy = undefined;
    }
  }

  async function cancelRetry(): Promise<void> {
    if (!current || parityBusy) return;
    parityBusy = "abort-retry";
    try {
      await window.gradivus.abortRetry(current.record.id);
      parityStatus = "Cancel retry requested.";
    } catch (error) {
      parityStatus = error instanceof Error ? error.message : String(error);
    } finally {
      parityBusy = undefined;
    }
  }

  async function loadSessionStats(): Promise<void> {
    if (!current || parityBusy) return;
    parityBusy = "stats";
    parityStatus = "";
    try {
      sessionStats = await window.gradivus.getSessionStats(current.record.id);
    } catch (error) {
      parityStatus = error instanceof Error ? error.message : String(error);
    } finally {
      parityBusy = undefined;
    }
  }

  async function exportSessionHtml(): Promise<void> {
    if (!current || parityBusy) return;
    parityBusy = "export";
    parityStatus = "";
    try {
      const result = await window.gradivus.exportHtml(current.record.id);
      if (!result.cancelled && result.path) parityStatus = `Exported HTML to ${result.path}`;
    } catch (error) {
      parityStatus = error instanceof Error ? error.message : String(error);
    } finally {
      parityBusy = undefined;
    }
  }

  async function restartOmp(): Promise<void> {
    if (!current || parityBusy) return;
    const sessionId = current.record.id;
    parityBusy = "restart";
    parityStatus = "";
    try {
      current = await window.gradivus.restart(sessionId);
      timelineSessionSource = sessionId;
      parityDialog = undefined;
      parityStatus = "OMP restarted with the same session.";
    } catch (error) {
      parityStatus = error instanceof Error ? error.message : String(error);
    } finally {
      parityBusy = undefined;
    }
  }


  function openInspector(tab: InspectorTab): void {
    inspectorTab = tab;
    inspectorOpen = true;
    if (current) {
      const next = new Map(inspectorTabBySession);
      next.set(current.record.id, tab);
      inspectorTabBySession = next;
      if (tab === "agents") {
        clearAgentHubUnread(current.record.id);
        if (agentHubSelectedAgentId) void loadAgentHubMessages();
      }
    }
  }

  function openImageInFiles(path: string): void {
    fileInspectorTarget = path;
    openInspector("files");
  }

  async function copyMarkdownText(value: string): Promise<void> {
    await window.gradivus.writeClipboardText(value);
  }
  function toggleInspector(tab: InspectorTab): void {
    if (inspectorOpen && inspectorTab === tab) {
      closeInspector();
      return;
    }
    openInspector(tab);
  }

  function closeInspector(): void {
    inspectorOpen = false;
    fileInspectorTarget = "";
  }
  function syncAgentHubWindowGeometry(): void {
    if (!agentHubDialog || !transcriptPane) return;
    const bounds = transcriptPane.getBoundingClientRect();
    agentHubDialog.style.setProperty("--agent-hub-pane-center-x", `${bounds.left + bounds.width / 2}px`);
    agentHubDialog.style.setProperty("--agent-hub-pane-center-y", `${bounds.top + bounds.height / 2}px`);
    agentHubDialog.style.setProperty("--agent-hub-pane-width", `${bounds.width}px`);
    agentHubDialog.style.setProperty("--agent-hub-pane-height", `${bounds.height}px`);
  }
  function handleAgentHubOutsidePointerDown(event: PointerEvent): void {
    if (!agentHubWindowOpen || !agentHubDialog) return;
    const target = event.target;
    if (target instanceof Node && agentHubDialog.contains(target)) return;
    closeAgentHubWindow(false);
  }
  function handleAgentHubFocusIn(event: FocusEvent): void {
    if (!agentHubWindowOpen || !agentHubDialog) return;
    const target = event.target;
    if (target instanceof Node && agentHubDialog.contains(target)) return;
    agentHubDialog.querySelector<HTMLElement>('[aria-label="Close Agent Hub session"]')?.focus();
  }
  function closeAgentHubWindow(restoreFocus = true): void {
    const returnFocus = restoreFocus ? agentHubReturnFocus : undefined;
    agentHubReturnFocus = undefined;
    agentHubDialog?.close();
    agentHubWindowOpen = false;
    void tick().then(() => returnFocus?.focus());
  }
  function focusTimelineItem(itemId: string): void {
    void tick().then(() => {
      const target = document.querySelector<HTMLElement>(`[data-timeline-id="${CSS.escape(itemId)}"]`);
      const scroller = timelineScroller;
      if (!target || !scroller) return;
      clearTimelineProgrammaticScroll();
      timelineProgrammaticScroll = true;
      scroller.addEventListener("scrollend", clearTimelineProgrammaticScroll, { once: true });
      timelineProgrammaticScrollTimer = window.setTimeout(clearTimelineProgrammaticScroll, 1_200);
      target.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  }

  async function openSelectedFile(path: string): Promise<void> {
    if (!current) return;
    try {
      await window.gradivus.openWorkspaceFile(current.record.id, path);
    } catch (error) {
      showError(error);
    }
  }
  async function respondExtension(response: Record<string, unknown>): Promise<void> {
    const extension = pendingExtension;
    if (!current || !extension || respondedExtensionIds.has(extension.id)) return;
    respondedExtensionIds.add(extension.id);
    try {
      await window.gradivus.extensionResponse(current.record.id, { id: extension.id, ...response });
      pendingExtension = undefined;
    } catch (error) {
      respondedExtensionIds.delete(extension.id);
      showError(error);
    }
  }
  async function handleAuthEvent(event: AuthEvent): Promise<void> {
    if (event.type === "progress" || event.type === "auth-url") authStatusMessage = event.message;
    if (event.type === "prompt") {
      authPrompt = event;
      authPromptValue = "";
      authStatusMessage = event.message;
      return;
    }
    if (event.type === "complete") {
      authPrompt = undefined;
      authPromptValue = "";
      authStatusMessage = event.message;
      await refreshOAuthAccounts();
      applyAuthAccounts(await window.gradivus.getAuthStatus());
    }
    if (event.type === "error") {
      authPrompt = undefined;
      authBusyProvider = "";
      authStatusMessage = event.message;
      if (event.provider === AUTH_DISCOVERY_PROVIDER) authDiscoveryError = event.message;
    }
  }

  async function loginProvider(account: AuthAccountView): Promise<void> {
    if (!account.available || authBusyProvider) return;
    authBusyProvider = account.provider;
    authStatusMessage = `Starting ${account.name} sign-in…`;
    try {
      applyAuthAccounts(await window.gradivus.loginProvider(account.provider));
    } catch (error) {
      authStatusMessage = error instanceof Error ? error.message : String(error);
    } finally {
      authBusyProvider = "";
    }
  }

  function applyAuthAccounts(accounts: AuthAccountView[]): void {
    authAccounts = accounts;
    // A successful snapshot proves discovery works again, so clear any stale failure state.
    if (accounts.length > 0) authDiscoveryError = "";
  }
  async function logoutProvider(account: AuthAccountView): Promise<void> {
    if (authBusyProvider) return;
    authBusyProvider = account.provider;
    try {
      applyAuthAccounts(await window.gradivus.logoutProvider(account.provider));
    } catch (error) {
      authStatusMessage = error instanceof Error ? error.message : String(error);
    } finally {
      authBusyProvider = "";
    }
  }

  async function submitAuthPrompt(): Promise<void> {
    const value = authPromptValue;
    authPromptValue = "";
    authPrompt = undefined;
    try { await window.gradivus.respondAuthPrompt(value); }
    catch (error) { authStatusMessage = error instanceof Error ? error.message : String(error); }
  }

  async function cancelAuthPrompt(): Promise<void> {
    authPrompt = undefined;
    authPromptValue = "";
    try { await window.gradivus.respondAuthPrompt(""); } catch { /* login flow surfaces cancellation */ }
  }

  async function loadReasoning(item: TimelineItem): Promise<void> {
    if (!current || item.kind !== "thinking") return;
    openReasoning = new Set(openReasoning).add(item.id);
    if (item.textLoaded !== false || reasoningLoading.has(item.id)) return;
    reasoningLoading = new Set(reasoningLoading).add(item.id);
    try {
      const loaded = await window.gradivus.loadTimelineItem(current.record.id, item.id);
      current = { ...current, timeline: current.timeline.map(candidate => candidate.id === loaded.id ? loaded : candidate) };
    } catch (error) {
      showError(error);
    } finally {
      const next = new Set(reasoningLoading);
      next.delete(item.id);
      reasoningLoading = next;
    }
  }
  function timelineToolDetailKey(sessionId: string, itemId: string): string {
    return `${sessionId}:${itemId}`;
  }

  async function loadTimelineToolDetail(sessionId: string, itemId: string): Promise<void> {
    const key = timelineToolDetailKey(sessionId, itemId);
    if (timelineToolDetails.has(key) || timelineToolDetailLoading.has(key)) return;
    timelineToolDetailLoading = new Set(timelineToolDetailLoading).add(key);
    const errors = new Map(timelineToolDetailErrors);
    errors.delete(key);
    timelineToolDetailErrors = errors;
    try {
      const activity = await window.gradivus.loadTimelineToolDetail(sessionId, itemId);
      timelineToolDetails = new Map(timelineToolDetails).set(key, activity);
    } catch (error) {
      timelineToolDetailErrors = new Map(timelineToolDetailErrors).set(
        key,
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      const loading = new Set(timelineToolDetailLoading);
      loading.delete(key);
      timelineToolDetailLoading = loading;
    }
  }


  async function handleEvent(event: GradivusEvent): Promise<void> {
    if (event.type === "plan_review") {
      setSessionPlanReview(event.sessionId, event.planReview);
      if (event.planReview) void maybePresentPlanReview(event.sessionId, event.planReview);
      return;
    }
    if (event.type === "session_reset" && event.snapshot) {
      const snapshot = event.snapshot;
      syncSnapshotPlanReview(snapshot);
      if (current?.record.id === event.sessionId) {
        current = snapshot;
        timelineSessionSource = event.sessionId;
        availableCommands = snapshot.commands ?? [];
        updateSessionStatus(
          event.sessionId,
          snapshot.state === "running" ? "running" : snapshot.state === "error" ? "error" : "idle",
        );
      }
      if (bootstrap) {
        bootstrap = {
          ...bootstrap,
          registry: {
            ...bootstrap.registry,
            sessions: bootstrap.registry.sessions.map(session =>
              session.id === snapshot.record.id ? snapshot.record : session,
            ),
          },
        };
      }
      return;
    }
    if (event.type === "warning") {
      showNotice(event.message ?? "Recovery warning", "warning", "Recovery warning");
      return;
    }

    if (event.type === "prompt_result") {
      const pending = pendingTurns.get(event.sessionId);
      if (!pending || (pending.requestId && event.requestId && pending.requestId !== event.requestId)) {
        if (!pending) earlyPromptResults = new Map(earlyPromptResults).set(event.sessionId, event);
        return;
      }
      if (!pending.requestId) {
        earlyPromptResults = new Map(earlyPromptResults).set(event.sessionId, event);
        return;
      }
      await releaseAdmittedAttachmentBatch(event.sessionId);
      await reconcilePromptResult(event);
      return;
    }

    if (event.state) {
      if (event.state !== "running" && event.state !== "starting") {
        await releaseAdmittedAttachmentBatch(event.sessionId);
      }
      const status = event.state === "running" ? "running" : event.state === "error" ? "error" : "idle";
      updateSessionStatus(event.sessionId, status);
      const pending = pendingTurns.get(event.sessionId);
      if (pending && event.state === "running" && pending.reconciliation === "awaiting-ack") {
        pendingTurns = new Map(pendingTurns).set(event.sessionId, { ...pending, reconciliation: "running" });
      }
      if (event.state === "error") {
        const message = event.runtime?.error ?? event.message ?? "OMP runtime stopped unexpectedly";
        if (pending) rollbackPendingTurn(event.sessionId, message);
        else if (event.sessionId === activeId) showError(message);
      }
      if (event.state === "stopped") {
        if (explicitStopSessions.has(event.sessionId)) {
          const next = new Set(explicitStopSessions);
          next.delete(event.sessionId);
          explicitStopSessions = next;
          clearPendingTurn(event.sessionId, true);
          if (event.sessionId === activeId) {
            errorMessage = "";
            notice = undefined;
          }
        } else {
          clearPendingTurn(event.sessionId, true);
        }
      }
    }

    const isActiveSession = Boolean(current && event.sessionId === current.record.id);
    if (!isActiveSession || !current) return;
    if (event.type === "todo_update" && event.todoState) {
      current = { ...current, todoState: event.todoState };
      return;
    }
    if (event.type === "browser_inventory" && event.browserInventory) {
      current = { ...current, browserInventory: event.browserInventory };
    }
    if (event.type === "agent_hub_update") {
      if (event.agentHub) applyAgentHubSnapshot(event.sessionId, event.agentHub);
      else void refreshAgentHub(event.sessionId);
      if (agentHubSelectedAgentId) void loadAgentHubMessages();
    }
    if (event.type === "subagents" && event.subagents) {
      current = { ...current, subagents: event.subagents };
      void refreshAgentHub(event.sessionId);
    }
    const timelineFollowing = followIntent(event.sessionId);
    const timelineElement = event.type === "timeline" ? timelineScroller : undefined;
    const previousTimelineScrollTop = timelineElement?.scrollTop;

    if (
      event.state ||
      event.runtime ||
      event.message ||
      event.isStreaming !== undefined ||
      event.isCompacting !== undefined ||
      "retryState" in event
    ) {
      current = {
        ...current,
        ...(event.state ? { state: event.state } : {}),
        ...(event.runtime ? { runtime: event.runtime } : {}),
        ...(event.isStreaming !== undefined ? { isStreaming: event.isStreaming } : {}),
        ...(event.isCompacting !== undefined ? { isCompacting: event.isCompacting } : {}),
        ...("retryState" in event ? { retryState: event.retryState } : {}),
        ...(event.runtime?.error ? { warning: event.runtime.error } : {}),
        ...(event.message ? { warning: event.message } : {}),
      };
    }
    if (event.type === "session" && event.record) {
      const record = event.record;
      current = { ...current, record, ...(event.state ? { state: event.state } : {}) };
      if (bootstrap) {
        const existingIndex = bootstrap.registry.sessions.findIndex(s => s.id === record.id);
        const updatedSessions = existingIndex >= 0
          ? bootstrap.registry.sessions.map(session => session.id === record.id ? record : session)
          : [record, ...bootstrap.registry.sessions];
        bootstrap = {
          ...bootstrap,
          registry: {
            ...bootstrap.registry,
            sessions: updatedSessions,
          },
        };
      }
    }
    if (event.type === "commands" && event.commands) {
      availableCommands = event.commands;
      current = { ...current, commands: event.commands };
    }
    if (event.type === "config" && event.config) current = { ...current, ...event.config };
    if (event.type === "timeline") {
      if (event.item) {
        const baseTimeline = current.timeline ?? [];
        const pendingTurn = pendingTurns.get(event.sessionId);
        const queuedPrompt = findQueuedPromptForEvent(event.sessionId, event.item);
        const isCanceledPromptUser = event.item.kind === "user"
          && !event.item.id.startsWith("opt-")
          && !pendingTurn
          && !queuedPrompt
          && consumeCanceledPrompt(event.sessionId, event.item.text);
        if (isCanceledPromptUser) return;
        const isCanonicalPromptUser = event.item.kind === "user"
          && !event.item.id.startsWith("opt-")
          && Boolean(pendingTurn && !pendingTurn.canonicalUserId);
        const optimisticIndex = event.item.id.startsWith("opt-")
          ? baseTimeline.findIndex(candidate => candidate.id === event.item?.id)
          : queuedPrompt
            ? baseTimeline.findIndex(candidate => candidate.id === queuedPrompt.optimisticId)
            : isCanonicalPromptUser
              ? baseTimeline.findIndex(candidate => candidate.id === pendingTurn?.optimisticUserId)
              : -1;
        const visibleItem: TimelineItem = queuedPrompt
          ? { ...event.item, text: queuedPrompt.displayText }
          : isCanonicalPromptUser && pendingTurn
            ? { ...event.item, text: pendingTurn.draft }
            : event.item;
        const existed = optimisticIndex >= 0 || baseTimeline.some(candidate => candidate.id === visibleItem.id);
        const timeline = optimisticIndex >= 0
          ? baseTimeline.map((candidate, index) => index === optimisticIndex ? visibleItem : candidate)
          : appendTimeline(baseTimeline, visibleItem);
        const timelineTotal = (current.timelineTotal ?? current.timeline.length) + (existed ? 0 : 1);
        current = { ...current, timeline, timelineStart: Math.max(0, timelineTotal - timeline.length), timelineTotal };
        if (queuedPrompt) {
          queuedPrompts = new Map(queuedPrompts).set(queuedPrompt.optimisticId, {
            ...queuedPrompt,
            status: "steered",
            canonicalUserId: event.item.id,
            canonicalItem: visibleItem,
          });
        }
        if (isCanonicalPromptUser && pendingTurn) {
          pendingTurns = new Map(pendingTurns).set(event.sessionId, { ...pendingTurn, canonicalUserId: event.item.id });
        }
        if (!timelineFollowing) markUnseen(event.sessionId, event.item.id);
      }
      if (timelineFollowing) {
        await scrollTimelineToEnd(false, event.sessionId);
      } else if (timelineElement && timelineElement === timelineScroller && previousTimelineScrollTop !== undefined) {
        await tick();
        timelineElement.scrollTop = previousTimelineScrollTop;
        isScrolledUp = true;
      }
    }
    if (event.type !== "extension" || !event.extension) return;
    const extension = event.extension;
    if (extension.method === "cancel") {
      if (!pendingExtension || pendingExtension.id === extension.targetId) pendingExtension = undefined;
      return;
    }
    if (extension.method === "set_editor_text") { draft = extension.text ?? ""; return; }
    if (extension.method === "notify") { showNotice(extension.message ?? "Extension notification", extension.notifyType ?? "info", extension.title ?? "Extension notification"); return; }
    if (extension.method === "setStatus") { extensionStatus = extension.statusText ?? ""; return; }
    if (extension.method === "setWidget") { extensionWidget = (extension.widgetLines ?? []).join("\n"); return; }
    if (extension.method === "setTitle") { extensionTitle = extension.title ?? ""; return; }
    if (respondedExtensionIds.has(extension.id)) return;
    pendingExtension = extension;
    if (extension.method === "open_url" && extension.url) {
      try { await window.gradivus.openExternal(extension.url); await respondExtension({ cancelled: true }); } catch (error) { showError(error); }
    }
  }
  async function handleTogglePlanMode(): Promise<void> {
    if (!current) return;
    try {
      const updated = await window.gradivus.togglePlanMode(current.record.id);
      current = { ...current, planMode: updated };
    } catch (error) {
      showError(error);
    }
  }

  function openAbout(trigger: HTMLButtonElement): void {
    aboutReturnFocus = trigger;
    aboutOpen = true;
  }
  function closeAbout(): void {
    const returnFocus = aboutReturnFocus;
    aboutReturnFocus = undefined;
    aboutOpen = false;
    void tick().then(() => {
      if (returnFocus?.isConnected) returnFocus.focus();
    });
  }
  function toggleThemeFromRail(): void {
    if (!appSettings || appSettingsBusy.has("theme")) return;
    const nextTheme = theme === "dark" ? "light" : "dark";
    void onUpdateAppSetting("theme", { theme: nextTheme }, "Theme");
  }

  function appendTimeline(items: TimelineItem[], item: TimelineItem): TimelineItem[] {
    const existing = items.findIndex(candidate => candidate.id === item.id);
    if (existing < 0) return [...items, item];
    return items.map((candidate, index) => index === existing ? { ...candidate, ...item } : candidate);
  }

  let optimisticMessageSequence = 0;
  function appendOptimisticUserMessage(sessionId: string, text: string): string {
    optimisticMessageSequence += 1;
    const id = `optimistic-user-${Date.now()}-${optimisticMessageSequence}`;
    if (current?.record.id !== sessionId) return id;
    const timeline = [...current.timeline, { id, kind: "user" as const, text, timestamp: new Date().toISOString() }];
    const timelineTotal = (current.timelineTotal ?? current.timeline.length) + 1;
    current = { ...current, timeline, timelineStart: Math.max(0, timelineTotal - timeline.length), timelineTotal };
    setFollowIntent(sessionId, true);
    void scrollTimelineToEnd();
    return id;
  }

  function removeOptimisticUserMessage(sessionId: string, id: string): void {
    if (current?.record.id !== sessionId || !current.timeline.some(item => item.id === id)) return;
    const timeline = current.timeline.filter(item => item.id !== id);
    const timelineTotal = Math.max(0, (current.timelineTotal ?? current.timeline.length) - 1);
    current = { ...current, timeline, timelineStart: Math.max(0, timelineTotal - timeline.length), timelineTotal };
  }

  function showError(error: unknown): void { errorMessage = error instanceof Error ? error.message : String(error); }
  function showNotice(message: string, tone: NoticeTone = "info", title = "Notice"): void {
    notice = { message, tone, title };
  }
  function noticeRole(tone: NoticeTone): "status" | "alert" {
    return tone === "warning" || tone === "error" ? "alert" : "status";
  }
  function formatMessage(value: unknown): string { return typeof value === "string" ? value : JSON.stringify(value, null, 2) ?? "[message]"; }
  function handleTranscriptClick(event: Event): void {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const anchor = target.closest("a");
    if (!anchor) return;
    event.preventDefault();
    const href = anchor.getAttribute("href");
    if (href && !href.startsWith("#")) void window.gradivus.openExternal(href).catch(showError);
  }

  function handleTranscriptKeydown(event: KeyboardEvent): void {
    if (settingsRoute.open) return;
    if (event.key === "Escape" && selectedDiffPath) {
      closeFileDiff();
      return;
    }
    if (event.key === "Enter" || event.key === " ") handleTranscriptClick(event);
  }
</script>
<svelte:window
  onclick={handleTranscriptClick}
  onkeydown={handleTranscriptKeydown}
  onpointerdown={handleAgentHubOutsidePointerDown}
  onfocusin={handleAgentHubFocusIn}
  onresize={syncAgentHubWindowGeometry}
/>

<div class="app-shell">
  <div class="settings-workspace-source" inert={settingsRoute.open || planReviewVisible} aria-hidden={settingsRoute.open || planReviewVisible}>
  <div class="workspace-grid" class:inspector-open={inspectorOpen}>
    <SessionRail
      groups={workspaceGroups}
      currentCwd={current?.record.cwd}
      loading={loading}
      activeId={activeId}
      liveStatus={sessionLiveStatus}
      displayName={(session) => sessionDisplayName(session)}
      onCreateWorkspace={() => void createSession()}
      onNewChatInWorkspace={(cwd) => void createNewChatInWorkspace(cwd)}
      onSelectSession={selectSessionFromRail}
      onDeleteSession={(id) => void deleteSessionFromRail(id)}
      {theme}
      themeDisabled={!appSettings || appSettingsBusy.has("theme")}
      onOpenSettings={(trigger) => openSettingsFromTrigger("app-appearance", trigger)}
      onOpenAbout={openAbout}
      onToggleTheme={toggleThemeFromRail}
    />
    <main bind:this={transcriptPane} class="transcript-pane" aria-live="polite">
      <header class="transcript-header">
        <div class="transcript-identity">
          {#if current}
            <div class="transcript-title">
              <div class="title-line">
                {#if renaming}
                  <input class="rename-input" bind:value={renameValue} aria-label="Session name" onkeydown={(event) => event.key === "Enter" && void saveRename()} />
                  <button class="inline-save" onclick={() => void saveRename()}>Save</button>
                {:else}
                  <h2>{sessionDisplayName(current.record)}</h2>
                  {#if current.planMode?.enabled}
                    <button
                      type="button"
                      class="transcript-plan-mode-badge"
                      title={activePlanReview ? "Review the pending plan" : "Request plan review"}
                      aria-label="Review plan"
                      onclick={(event) => void openActivePlanReview(event.currentTarget)}
                    >
                      <span class="badge-dot"></span> PLAN MODE
                    </button>
                  {/if}
                  <button class="rename-button" title="Rename session" aria-label="Rename session" onclick={() => { renameValue = current?.record.title || sessionDisplayName(current?.record); renaming = true; }}><Pen2 size={13} aria-hidden="true" /></button>
                {/if}
              </div>
              <span class="path-label">{current.record.cwd}</span>
            </div>
          {/if}
        </div>
        <div class="transcript-actions">
          {#if current}
            <button
              type="button"
              class="icon-button terminal-toggle-btn"
              class:is-active={terminalOpen}
              title={terminalOpen ? "Hide terminal" : "Show terminal"}
              aria-label={terminalOpen ? "Hide terminal" : "Show terminal"}
              aria-controls="chat-terminal-drawer"
              aria-expanded={terminalOpen}
              onclick={() => terminalOpen = !terminalOpen}
            >
              <CodeSquare size={17} aria-hidden="true" />
            </button>
          {/if}
        </div>
      </header>
      {#if !current}
        <StateCard variant="welcome"><span class="eyebrow">Workspace</span><h2>Make the next useful thing.</h2><p>Choose a local repository or folder to start a conversation with OMP. Tool calls, diffs, commands, reasoning, and edits stay paired in one reviewable timeline.</p><button class="primary-button" onclick={() => void createSession()} disabled={loading}>Choose a workspace <span class="button-arrow"><ArrowRight size={14} aria-hidden="true" /></span></button><div class="prompt-suggestions"><span>Start with</span><button onclick={() => draft = "Inspect this repository and identify the next implementation step."}>“Inspect this repository…”</button></div>
        </StateCard>
      {:else}
        <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
        <div class="timeline-scroll" role="region" aria-label="Conversation transcript" tabindex="0" bind:this={timelineScroller} onscroll={handleTimelineScroll}>
          <div class="timeline-content" bind:this={timelineContent}>
          {#if current.timeline.length === 0 && current.state === "ready"}<StateCard variant="empty"><h3>What outcome should we pursue?</h3><p>Ask for research, a summary, an implementation plan, or a review of the current tree.</p><div class="suggestion-grid"><button onclick={() => draft = "Find the important documents in this workspace and explain them."}>Find important documents<span class="button-arrow"><ArrowRight size={14} aria-hidden="true" /></span></button><button onclick={() => draft = "Review the current repository for risks and open issues."}>Review repository risks<span class="button-arrow"><ArrowRight size={14} aria-hidden="true" /></span></button></div></StateCard>{/if}
          {#if hiddenTimelineCount > 0}<button class="secondary-button older-entries" onclick={() => void revealOlder()} disabled={loadingOlder}>Load 100 older entries <span>({hiddenTimelineCount} remaining)</span></button>{/if}
          {#each visibleTimeline as item (item.id)}
            {@const queuedPrompt = queuedPrompts.get(item.id)}
            {@const itemSessionId = current.record.id}
            {@const toolDetailKey = timelineToolDetailKey(itemSessionId, item.id)}
            {#if messageEdit?.sessionId === current?.record.id && messageEdit.timelineItemId === item.id}
              <article class="timeline-item item-user timeline-editing-item" data-timeline-id={item.id}>
                <div class="timeline-gutter"><span>YOU</span></div>
                <div class="timeline-body">
                  <form class="message-edit-form" aria-label="Edit sent message" aria-busy={messageEdit.saving} onsubmit={handleMessageEditSubmit}>
                    <textarea
                      bind:this={messageEditTextarea}
                      class="message-edit-input"
                      rows="4"
                      aria-label="Edit message text"
                      value={messageEdit.value}
                      disabled={messageEdit.saving}
                      oninput={(event) => updateMessageEditValue(event.currentTarget.value)}
                      onkeydown={handleMessageEditKeydown}
                      oncompositionstart={() => (messageEditComposing = true)}
                      oncompositionend={() => (messageEditComposing = false)}
                    ></textarea>
                    <div class="message-edit-actions">
                      <button type="button" class="secondary-button compact" disabled={messageEdit.saving} onclick={cancelMessageEdit}>Cancel</button>
                      <button type="submit" class="primary-button" disabled={messageEditSubmitDisabled}>Save and send</button>
                    </div>
                  </form>
                </div>
              </article>
            {:else}
              <TimelineEntry
                item={item}
                kind={current?.record.kind ?? "work"}
                reasoningLoading={reasoningLoading}
                openReasoning={openReasoning}
                onReasoning={loadReasoning}
                onCopyText={copyMarkdownText}
                showToolDetails={appSettings?.ui.showToolDetails ?? true}
                queued={Boolean(queuedPrompt?.route === "follow-up" && (queuedPrompt.status === "queued" || queuedPrompt.status === "steering"))}
                queuedSteering={queuedPrompt?.status === "steering"}
                queuedError={queuedPrompt?.error}
                loadedToolActivity={timelineToolDetails.get(toolDetailKey)}
                toolDetailLoading={timelineToolDetailLoading.has(toolDetailKey)}
                toolDetailError={timelineToolDetailErrors.get(toolDetailKey) ?? ""}
                onLoadToolDetail={() => void loadTimelineToolDetail(itemSessionId, item.id)}
                onSteer={() => void steerQueuedPrompt(item.id)}
                canEdit={canEditMessages && !messageEdit}
                onEdit={startMessageEdit}
              />
              {#if item.isError && visibleTimeline.at(-1)?.id === item.id}
                <button type="button" class="inline-retry-button" disabled={Boolean(parityBusy) || isTurnActive} onclick={() => void retryLastTurn()}>
                  Retry last turn
                </button>
              {/if}
            {/if}
            {@const fileSummary = turnFileSummaries.get(item.id)}
            {#if fileSummary}
              <TurnFileSummary
                summary={fileSummary}
                onreview={(path) => void openFileDiff(path)}
                onopen={(path) => void openSelectedFile(path)}
                onimage={openImageInFiles}
              />
            {/if}
          {/each}
          {#if current.state === "error"}<StateCard variant="error"><strong>Runtime stopped unexpectedly</strong><span>{current.warning ?? "Resume to reconnect and recover the saved transcript."}</span><button class="secondary-button" onclick={() => void resumeSession()}>Reconnect</button></StateCard>{/if}
          </div>
        </div>
      {/if}

      {#if current}
        <section class="composer-wrap" role="group" aria-label="Prompt composer" class:dragging={dragDepth > 0} ondragenter={handleDragEnter} ondragover={handleDragOver} ondragleave={handleDragLeave} ondrop={handleDrop} ondragend={handleDragEnd}>
          {#if isScrolledUp}
            <button
              type="button"
              class="jump-to-latest-pill"
              aria-label={`Jump to latest messages${unseenCount > 0 ? ` (${unseenCount} unseen)` : ""}`}
              onclick={scrollToLatest}
            >
              <span class="jump-arrow" aria-hidden="true"><ArrowDown size={14} /></span>
              <span class="jump-label">Jump to latest</span>
              {#if unseenCount > 0}
                <span class="jump-badge">{unseenCount}</span>
              {/if}
            </button>
          {/if}

          {#if isTurnActive}
            {@const activity = activeTurnActivity(current)}
            <div class="active-turn-status" role="status" aria-live="polite">
              <div class="turn-indicator">
                <span class="turn-icon" aria-hidden="true">
                  <span class="turn-status-dot"></span>
                </span>
                <span class="turn-status-text">
                  {#if parityBusy === "handoff"}
                    <span>Handing off…</span>
                  {:else if current.isCompacting || parityBusy === "compact"}
                    <span>Compacting…</span>
                  {:else if current.retryState}
                    <span>Retrying (attempt {current.retryState.attempt} of {current.retryState.maxAttempts})</span>
                  {:else if activity.type === "tool"}
                    <span class="tool-name">{activity.label}</span>
                    {#if activity.detail}
                      <span class="tool-args" title={activity.detail}>{activity.detail}</span>
                    {/if}
                  {:else}
                    <span>{activity.label}</span>
                    {#if activity.detail}
                      <span class="tool-args">{activity.detail}</span>
                    {/if}
                  {/if}
                </span>
              </div>
              <div class="turn-metrics">
                <span class="turn-timer" title="Elapsed turn time">
                  <span class="timer-glyph" aria-hidden="true"><ClockCircle size={14} /></span>
                  <span class="timer-value">{formatElapsed(elapsedSeconds)}</span>
                </span>
                {#if current.tokensPerSecond && current.tokensPerSecond > 0}
                  <span class="turn-throughput" title="Generation throughput">
                    <span class="throughput-glyph" aria-hidden="true"><Bolt size={14} /></span>
                    <span class="throughput-value">{Math.round(current.tokensPerSecond)} tok/s</span>
                  </span>
                {/if}
                <button
                  type="button"
                  class="turn-stop-btn"
                  title={current.retryState ? "Cancel retry" : "Stop generation"}
                  aria-label={current.retryState ? "Cancel retry" : "Stop generation"}
                  onclick={() => current?.retryState ? void cancelRetry() : void abortTurn()}
                >
                  <span class="stop-icon" aria-hidden="true"><Stop size={12} /></span>
                  <span class="stop-label">{current.retryState ? "Cancel retry" : "Stop"}</span>
                </button>
              </div>
            </div>
          {/if}
          {#if parityStatus}<p class="parity-status" role="status">{parityStatus}</p>{/if}
          {#if promptFailure}
            <StateCard variant="error" alertRole class="prompt-recovery-card">
              <strong>Prompt could not start</strong>
              <span>{promptFailure}</span>
              <div class="dialog-actions">
                <button class="secondary-button" onclick={(event) => openSettings("accounts", event)}>Open provider accounts</button>
                <button class="primary-button" disabled={!canCompose || !hasComposerContent || isComposerBusy} onclick={() => void sendPrimary()}>Retry</button>
              </div>
            </StateCard>
          {/if}
          {#if extensionWidget}<pre class="extension-widget" role="status">{extensionWidget}</pre>{/if}
          <TodoDock
            sessionId={current.record.id}
            todoState={current.todoState}
            buffer={todoEditBuffer}
            undoState={todoUndoState}
            onBufferChange={(nextBuffer) => updateTodoEditBuffer(current!.record.id, nextBuffer)}
            onSave={(phases, expectedRevision, action) =>
              saveTodoEdits(current!.record.id, phases, expectedRevision, action)}
            onReload={() => reloadTodoState(current!.record.id)}
            onUndo={() => undoTodoEdits(current!.record.id)}
          />
          {#if commandMenuVisible}
            <CommandMenu
              commands={commandMatches}
              error={commandError}
              loading={commandsLoading}
              selectedIndex={selectedCommandIndex}
              onSelect={applyCommand}
              onHighlight={(index) => selectedCommandIndex = index}
            />
          {/if}

          <!-- Model & Provider Selection Dropdowns above chatbox -->
          <Composer
            providerOptions={providerDropdownOptions}
            providerSelectedKey={activeProvider}
            providerDisabled={settingsBusy.has("model") || !canCompose || modelProviders.length === 0}
            modelOptions={composerModelDropdownOptions}
            modelSelectedKey={`${activeProvider}/${activeModelId}`}
            modelDisabled={settingsBusy.has("model") || !canCompose || modelsForActiveProvider.length === 0}
            onProviderSelect={handleProviderDropdownSelect}
            onModelSelect={handleModelDropdownSelect}
            dragging={dragDepth > 0}
            canCompose={canCompose}
            attachDisabled={!canCompose || isComposerBusy}
            attachments={promptAttachments}
            attachmentStatus={attachmentStatus}
            displayNameFor={attachmentDisplayName}
            onStageFiles={(files, insertionIndex) => void stageFiles(files, insertionIndex)}
            onRemoveAttachment={(attachment) => void removeAttachment(attachment)}
            bind:attachmentInputEl={attachmentInput}
            bind:inputEl={composerInput}
            bind:draft={draft}
            commandMenuOpen={commandMenuVisible}
            commandOptionCount={commandMatches.length}
            commandSelectedIndex={selectedCommandIndex}
            planMode={current.planMode}
            planRefinementAwaiting={activePlanReview?.status === "awaiting_refinement"}
            onTogglePlanMode={() => void handleTogglePlanMode()}
            thinkingLevel={current.thinkingLevel}
            thinkingBusy={settingsBusy.has("thinking")}
            onThinkingSelect={handleThinkingDropdownSelect}
            onInput={handleComposerInput}
            onKeydown={handleComposerKeydown}
            onPaste={handleComposerPaste}
            turnActive={isTurnActive}
            sendDisabled={!canCompose || !hasComposerContent || isComposerBusy}
            queuedMessageCount={current.queuedMessageCount ?? 0}
            contextUsedTokens={usedTokens}
            contextLimit={contextLimit ?? undefined}
            contextTokensPerSecond={current.tokensPerSecond ?? undefined}
            contextModelName={selectedModelOption?.name || current.model || "Provider default"}
            inspectorOpen={inspectorOpen}
            inspectorTab={inspectorTab}
            agentUnreadCount={agentHubUnreadCount}
            fileActivityCount={fileActivityCount}
            onToggleInspector={toggleInspector}
            compactDisabled={Boolean(current.isStreaming || current.isCompacting || (current.queuedMessageCount ?? 0) > 0 || parityBusy)}
            handoffDisabled={Boolean(current.isStreaming || parityBusy)}
            retryDisabled={Boolean(isTurnActive || parityBusy)}
            commandShortcuts={commandShortcuts}
            commandsAvailable={availableCommands.length > 0}
            onCommand={applyCommand}
            onAllCommands={openCommandPalette}
            restartDisabled={Boolean(parityBusy)}
            onCompact={() => openParityDialog("compact")}
            onHandoff={() => openParityDialog("handoff")}
            onRetry={() => void retryLastTurn()}
            onStats={() => void loadSessionStats()}
            onExport={() => void exportSessionHtml()}
            onRestart={() => openParityDialog("restart")}
            onSend={() => void sendPrimary()}
            onQueueFollowUp={() => void queueFollowUp()}
          />
        </section>
        <div class="chat-terminal-panel" class:is-open={terminalOpen}>
          <ChatTerminalDrawer
            {workspaceId}
            tabs={terminalTabs}
            open={terminalOpen}
            confirmClose={appSettings?.confirmCloseTab ?? true}
            theme={theme}
            terminalSettings={appSettings?.terminal}
          />
        </div>
      {/if}
    </main>
    {#if current && inspectorOpen}
      <RunInspector
        tab={inspectorTab}
        agentUnreadCount={agentHubUnreadCount}
        fileActivityCount={fileActivityCount}
        onTab={openInspector}
        onClose={closeInspector}
      >
        {#if inspectorTab === "agents"}
          <AgentHubPanel
            agents={agentHubAgents}
            selectedAgentId={agentHubSelectedAgentId}
            rosterOnly={true}
            bind:draft={agentHubDraft}
            messagesLoading={agentHubMessagesLoading}
            messageError={agentHubMessageError}
            actionBusy={agentHubActionBusy}
            messages={agentHubMessages}
            onSelect={(agentId) => void selectAgentHubAgent(agentId)}
            onLoadMessages={() => loadAgentHubMessages()}
            onSend={(message) => void sendAgentHubMessage(message)}
            onKill={(agentId) => void killAgentHubAgent(agentId)}
            onClear={(agentId) => void clearAgentHubAgent(agentId)}
            onRevive={(agentId) => void reviveAgentHubAgent(agentId)}
          />
        {:else}
          <FileActivityPanel
            files={outputFiles}
            selectedPath={fileInspectorTarget}
            onOpenFile={(path) => void openSelectedFile(path)}
            onOpenDiff={(path) => void openFileDiff(path)}
            loadImagePreview={(path, maxDimension) =>
              window.gradivus.loadWorkspaceImage(activeId, path, maxDimension)}
          />
        {/if}
      </RunInspector>
    {/if}
  </div>
  {#if current && agentHubWindowOpen}
    <div class="modal-backdrop agent-hub-window-backdrop">
      <dialog
        bind:this={agentHubDialog}
        class="agent-hub-window"
        tabindex="-1"
        aria-labelledby="agent-hub-window-title"
        onkeydown={(event) => {
          event.stopPropagation();
          if (event.key === "Escape") {
            event.preventDefault();
            closeAgentHubWindow();
          }
        }}
        oncancel={(event) => { event.preventDefault(); closeAgentHubWindow(); }}
      >
        <header class="agent-hub-window-header">
          <div>
            <span class="eyebrow">Agent Hub session</span>
            <h2 id="agent-hub-window-title" title={agentHubSelectedAgent?.displayName ?? "Agent details"}>{agentHubSelectedAgent?.displayName ?? "Agent details"}</h2>
          </div>
          <IconButton class="inspector-close" icon={CloseCircle} size={15} label="Close Agent Hub session" onclick={closeAgentHubWindow} />
        </header>
        <div class="agent-hub-window-content">
          <AgentHubPanel
            agents={agentHubAgents}
            selectedAgentId={agentHubSelectedAgentId}
            detailOnly={true}
            titleId="agent-hub-window-panel-title"
            bind:draft={agentHubDraft}
            messageInputId="agent-hub-window-message"
            messages={agentHubMessages}
            messagesLoading={agentHubMessagesLoading}
            messageError={agentHubMessageError}
            actionBusy={agentHubActionBusy}
            onSelect={(agentId) => void selectAgentHubAgent(agentId)}
            onLoadMessages={() => loadAgentHubMessages()}
            onSend={(message) => void sendAgentHubMessage(message)}
            onKill={(agentId) => void killAgentHubAgent(agentId)}
            onRevive={(agentId) => void reviveAgentHubAgent(agentId)}
            onClear={(agentId) => void clearAgentHubAgent(agentId)}
          />
        </div>
      </dialog>
    </div>
  {/if}

  {#if selectedDiffPath}
    <ModalShell backdrop backdropDismissLabel="Close Git diff" dialogClass="file-diff-dialog" role="dialog" ariaLabel={`Git diff for ${selectedDiffPath}`} onclickbackdrop={closeFileDiff}>
      <FileDiffInspector
        path={selectedDiffPath}
        diff={selectedDiff}
        loading={diffLoading}
        error={diffError}
        onClose={closeFileDiff}
        onOpenFile={() => void openSelectedFile(selectedDiffPath)}
      />
    </ModalShell>
  {/if}
  </div>
  {#if planReviewVisible && activePlanReview && current?.record.id === planReviewSessionId}
    <PlanReviewModal
      review={activePlanReview}
      disabledReason={planReviewDisabledReason()}
      returnFocus={planReviewOpener}
      onclose={closePlanReview}
      onupdate={updateVisiblePlanReview}
      onresolve={resolveVisiblePlanReview}
      onreload={reloadVisiblePlanReview}
      oncopy={(content) => window.gradivus.writeClipboardText(content)}
      onaccepted={acceptPlanReview}
    />
  {/if}
  {#if settingsRoute.open}
    <SettingsShell
      route={settingsRoute}
      entries={settingsSearchEntries}
      refreshing={settingsRefreshing}
      onQueryChange={(query) => onSettingsRouteChange({ query })}
      onCategoryChange={requestSettingsCategoryChange}
      onRefresh={() => void refreshSettingsData()}
      onClose={requestCloseSettings}
    >
      {#snippet content(visibleSettingIds)}
        {#if settingsStatusMessage && !isApplicationSettingsCategory(settingsRoute.activeCategory)}
          <p class="settings-global-status" role="status">{settingsStatusMessage}</p>
        {/if}

        {#if isApplicationSettingsCategory(settingsRoute.activeCategory)}
          {#if appSettings}
            <ApplicationSettingsPanel
              settings={appSettings}
              {visibleSettingIds}
              busyKeys={appSettingsBusy}
              status={appSettingsStatus}
              activeCategory={settingsRoute.activeCategory as ApplicationSettingsCategoryId}
              onUpdate={onUpdateAppSetting}
              onReset={onResetAppSettings}
            />
          {:else}
            <div class="settings-skeleton" role="status" aria-label="Loading application settings"><span></span><span></span><span></span><span></span></div>
          {/if}
        {:else if settingsRoute.activeCategory === "runtime"}
          <section class="settings-section settings-runtime-section" aria-label="Active session settings">
            <div class="settings-scope-row">
              <strong>Active session</strong>
              {#if current}<span class="state-pill state-{current.state}"><span></span>{current.state}</span>{/if}
            </div>
            {#if !current}
              <div class="settings-empty"><strong>No active session</strong><p>Choose a workspace before configuring its model and reasoning behavior.</p></div>
            {:else if current.state === "stopped" || current.state === "error"}
              <div class="settings-empty"><strong>{sessionDisplayName(current.record)}</strong><p>Resume this session before changing runtime settings.</p><button class="secondary-button" disabled={loading} onclick={() => void resumeSettingsSession()}>{loading ? "Resuming…" : "Resume session"}</button></div>
            {:else}
              <p class="settings-context">{sessionDisplayName(current.record)}<span>{current.record.cwd}</span></p>
              {#if isSettingVisible(visibleSettingIds, "runtime.model")}
                <div class="model-picker">
                  <div class="model-picker-head">
                    <div>
                      <span>Current model</span>
                      <strong>{selectedModelOption?.name ?? current.model ?? "Provider default"}</strong>
                      <small>{selectedModelOption ? `${selectedModelOption.provider} / ${selectedModelOption.id}` : current.model ?? "Inherited from OMP"}</small>
                    </div>
                    {#if selectedModelOption}<ModelCapabilityIcons input={selectedModelOption.input} reasoning={selectedModelOption.reasoning} />{/if}
                  </div>
                  <div class="model-picker-controls">
                    <label>
                      <span class="sr-only">Search models</span>
                      <input type="search" aria-label="Search models" placeholder="Search by model, provider, or ID" bind:value={modelQuery} />
                    </label>
                    <label>
                      <span class="sr-only">Filter models by provider</span>
                      <CustomDropdown
                        options={modelFilterDropdownOptions}
                        selectedKey={modelProviderFilter}
                        ariaLabel="Filter models by provider"
                        onSelect={handleModelProviderFilterSelect}
                        onOpenChange={() => undefined}
                      />
                    </label>
                  </div>
                  {#if modelsLoading}
                    <div class="settings-empty compact"><p>Loading available models…</p></div>
                  {:else if modelError}
                    <div class="settings-empty compact"><p>{modelError}</p><button class="secondary-button" onclick={() => current && void loadModels(current.record.id)}>Retry model catalog</button></div>
                  {:else if visibleModels.length === 0}
                    <div class="settings-empty compact"><p>No models match these filters.</p></div>
                  {:else}
                    <div class="model-results" aria-label="Available models">
                      {#each visibleModels as model (`${model.provider}:${model.id}`)}
                        {@const contextLabel = formatContextWindow(model.contextWindow)}
                        {@const selected = modelIdentifier(model) === current.model}
                        {#if model.provider === "openrouter"}
                          <OpenRouterModelAccordion
                            {model}
                            {contextLabel}
                            {selected}
                            open={expandedOpenRouterModel === model.id}
                            loading={openRouterRoutingLoading.has(model.id)}
                            routing={openRouterRouting.get(model.id)}
                            error={openRouterRoutingErrors.get(model.id) ?? ""}
                            busyProviders={openRouterProviderBusy.get(model.id) ?? EMPTY_PROVIDER_IDS}
                            modelChangeDisabled={settingsBusy.has("model")}
                            onToggle={() => toggleOpenRouterModel(model)}
                            onSelect={() => void changeModel(model)}
                            onProviderChange={(providerId, enabled) => void changeOpenRouterProvider(model, providerId, enabled)}
                          />
                        {:else}
                          <button
                            type="button"
                            class="model-option"
                            class:selected
                            aria-pressed={selected}
                            aria-label={`Use ${model.name} from ${model.provider}`}
                            disabled={settingsBusy.has("model")}
                            onclick={() => void changeModel(model)}
                          >
                            <span class="model-option-copy"><strong>{model.name}</strong><small>{model.provider} / {model.id}</small></span>
                            <span class="model-option-meta">
                              <ModelCapabilityIcons input={model.input} reasoning={model.reasoning} />
                              {#if contextLabel}<span class="model-context-badge">{contextLabel}</span>{/if}
                            </span>
                          </button>
                        {/if}
                      {/each}
                    </div>
                    <p class="model-result-note">Showing {visibleModels.length} of {filteredModels.length} matching models{filteredModels.length > visibleModels.length ? " — refine your search to see more" : ""}.</p>
                  {/if}
                </div>
              {/if}
              {#if hasVisibleSetting(visibleSettingIds, ["runtime.thinking", "runtime.fast"])}
                <div class="settings-form-grid runtime-options">
                  {#if isSettingVisible(visibleSettingIds, "runtime.thinking")}
                    <LabeledSelect
                      tone="field"
                      label="Thinking level"
                      description="Reasoning depth for the active session."
                      options={SETTINGS_THINKING_OPTIONS}
                      selectedKey={current.thinkingLevel ?? "inherit"}
                      ariaLabel="Settings thinking level"
                      disabled={settingsBusy.has("thinking")}
                      onSelect={handleThinkingDropdownSelect}
                      onOpenChange={() => undefined}
                    />
                  {/if}
                  {#if isSettingVisible(visibleSettingIds, "runtime.fast")}
                    <ToggleField
                      label="Fast mode"
                      description="Use accelerated serving when the selected model supports it."
                      checked={current.fastMode === true}
                      disabled={settingsBusy.has("fast")}
                      onchange={(checked) => void changeSetting("fast", checked)}
                    />
                  {/if}
                </div>
              {/if}
            {/if}
          </section>

          {#if hasVisibleSetting(visibleSettingIds, ["runtime.steering", "runtime.follow-up", "runtime.interrupt", "runtime.compaction", "runtime.retry"])}
            <section class="settings-section" aria-labelledby="turn-title">
              <div class="settings-section-heading"><h3 id="turn-title">Turn behavior</h3></div>
              <p class="settings-copy">Queue, interruption, compaction, and retry controls for the active runtime.</p>
              {#if current && current.state !== "stopped" && current.state !== "error"}
                <div class="settings-form-grid">
                  {#if isSettingVisible(visibleSettingIds, "runtime.steering")}
                    <LabeledSelect tone="field" label="Steering delivery" description="How messages steer an active turn." options={QUEUE_MODE_OPTIONS} selectedKey={current.steeringMode ?? "one-at-a-time"} ariaLabel="Steering delivery" disabled={settingsBusy.has("steering")} onSelect={(option) => handleQueueDropdownSelect("steering", option)} onOpenChange={() => undefined} />
                  {/if}
                  {#if isSettingVisible(visibleSettingIds, "runtime.follow-up")}
                    <LabeledSelect tone="field" label="Follow-up delivery" description="How queued messages enter subsequent turns." options={QUEUE_MODE_OPTIONS} selectedKey={current.followUpMode ?? "one-at-a-time"} ariaLabel="Follow-up delivery" disabled={settingsBusy.has("follow-up")} onSelect={(option) => handleQueueDropdownSelect("follow-up", option)} onOpenChange={() => undefined} />
                  {/if}
                  {#if isSettingVisible(visibleSettingIds, "runtime.interrupt")}
                    <LabeledSelect tone="field" label="Interrupt behavior" description="Whether new input interrupts immediately or waits." options={INTERRUPT_MODE_OPTIONS} selectedKey={current.interruptMode ?? "immediate"} ariaLabel="Interrupt behavior" disabled={settingsBusy.has("interrupt")} onSelect={handleInterruptDropdownSelect} onOpenChange={() => undefined} />
                  {/if}
                  {#if isSettingVisible(visibleSettingIds, "runtime.compaction")}
                    <ToggleField label="Automatic compaction" description="Compact context before it reaches the model limit." checked={current.autoCompactionEnabled !== false} disabled={settingsBusy.has("compaction")} onchange={(checked) => void changeAutoCompaction(checked)} />
                  {/if}
                  {#if isSettingVisible(visibleSettingIds, "runtime.retry")}
                    <ToggleField label="Automatic retry" description="Retry recoverable provider failures without a manual resend." checked={current.autoRetryEnabled !== false} disabled={settingsBusy.has("retry")} onchange={(checked) => void changeAutoRetry(checked)} />
                  {/if}
                </div>
              {:else}
                <div class="settings-empty compact"><p>Turn behavior becomes available when the active session is running.</p></div>
              {/if}
            </section>
          {/if}
        {:else if settingsRoute.activeCategory === "omp-agents"}
          <section class="settings-section agent-prompt-settings-section" aria-label="Subagent prompt settings">
            <SubagentPromptEditor
              agents={agentPrompts}
              loading={agentPromptsLoading}
              loadError={agentPromptsError}
              onSave={saveAgentPrompt}
              onReset={resetAgentPrompt}
              onDirtyChange={(dirty) => (agentPromptEditorDirty = dirty)}
            />
          </section>
        {:else if activeAgentSettingTab}
          {@const agentSettingGroups = visibleAgentSettingGroups(visibleSettingIds, activeAgentSettingTab)}
          {@const reportedAgentSettings = agentSettings.filter(setting => setting.tab === activeAgentSettingTab)}
          <section class="settings-section agent-settings-section" aria-label={`${settingsCategoryTitle(activeAgentSettingTab)} OMP defaults`}>
            <div class="settings-scope-row">
              <strong>OMP default</strong>
              <span class="count-badge">{reportedAgentSettings.length}</span>
            </div>
            <p class="settings-copy">Credential-free defaults shared with OMP. Changes marked “Next session” require a new or reconnected runtime.</p>
            {#if reportedAgentSettings.length === 0}
              <div class="settings-empty compact">
                <p>{settingsRefreshing ? `Loading ${settingsCategoryTitle(activeAgentSettingTab).toLowerCase()} defaults…` : `This runtime does not report configurable ${settingsCategoryTitle(activeAgentSettingTab).toLowerCase()} defaults.`}</p>
              </div>
            {:else if agentSettingGroups.length === 0}
              <div class="settings-empty compact"><p>No settings in this category match the search.</p></div>
            {:else}
              <div class="agent-settings-panel">
                {#each agentSettingGroups as group (group.name)}
                  <section class="agent-settings-group" aria-labelledby={`agent-setting-${activeAgentSettingTab}-${group.name.replaceAll(" ", "-").toLowerCase()}`}>
                    <h3 id={`agent-setting-${activeAgentSettingTab}-${group.name.replaceAll(" ", "-").toLowerCase()}`}>{group.name}</h3>
                    <div class="settings-form-grid">
                      {#each group.settings as setting (setting.path)}
                        {#if setting.control === "toggle"}
                          <ToggleField
                            label={setting.label}
                            description={setting.description}
                            badge={setting.apply === "next-session" ? "Next session" : undefined}
                            checked={setting.value === true}
                            disabled={agentSettingsBusy.has(setting.path)}
                            onchange={(checked) => void changeAgentSetting(setting, checked)}
                          />
                        {:else if setting.control === "multiselect"}
                          <label class="settings-multiselect">
                            <span>{setting.label}</span>
                            <span class="settings-description">{setting.description}</span>
                            <select
                              multiple
                              aria-label={setting.label}
                              disabled={agentSettingsBusy.has(setting.path)}
                              onchange={(event) => {
                                const selected = Array.from(
                                  (event.currentTarget as HTMLSelectElement).selectedOptions,
                                  option => option.value,
                                );
                                void changeAgentSetting(setting, selected);
                              }}
                            >
                              {#each setting.options ?? [] as option (String(option.value))}
                                <option
                                  value={String(option.value)}
                                  selected={Array.isArray(setting.value) && setting.value.includes(String(option.value))}
                                >
                                  {option.label}
                                </option>
                              {/each}
                            </select>
                          </label>
                        {:else}
                          <LabeledSelect
                            tone="field"
                            label={setting.label}
                            description={setting.description}
                            badge={setting.apply === "next-session" ? "Next session" : undefined}
                            options={(setting.options ?? []).map(agentSettingOptionToDropdownOption)}
                            selectedKey={agentSettingValueKey(setting.value)}
                            ariaLabel={setting.label}
                            disabled={agentSettingsBusy.has(setting.path)}
                            onSelect={(option) => changeAgentSettingFromDropdown(setting, option)}
                            onOpenChange={() => undefined}
                          />
                        {/if}
                      {/each}
                    </div>
                  </section>
                {/each}
              </div>
            {/if}
          </section>
        {:else if settingsRoute.activeCategory === "accounts"}
          {@const showAllProviderAccounts = isSettingVisible(visibleSettingIds, "accounts.providers")}
          {@const showAllOAuthProviders = hasVisibleSetting(visibleSettingIds, ["accounts.failover", "accounts.lock", "accounts.remove"])}
          {@const visibleProviderAccounts = filteredAuthAccounts.filter(account => showAllProviderAccounts || isSettingVisible(visibleSettingIds, `accounts.provider:${account.provider}`))}
          {@const visibleOAuthProviders = oauthAccounts.providers.filter(provider => showAllOAuthProviders || isSettingVisible(visibleSettingIds, `accounts.oauth:${provider.id}`))}
          {#if isSettingVisible(visibleSettingIds, "accounts.search") || showAllProviderAccounts || visibleProviderAccounts.length > 0}
            <section class="settings-section" aria-label="Provider access">
              <div class="settings-scope-row">
                <h3>Provider access</h3>
                <span class:connected={signedInAccountCount > 0} class="provider-state">{signedInAccountCount === 1 ? "1 connected" : `${signedInAccountCount} connected`}</span>
              </div>
              <p class="settings-copy">Every OAuth provider advertised by the local OMP runtime. Authentication opens the provider’s official browser flow.</p>
              {#if isSettingVisible(visibleSettingIds, "accounts.search")}
                <label class="provider-search"><span class="sr-only">Search providers</span><input type="search" aria-label="Search providers" placeholder="Search providers" bind:value={authQuery} /></label>
              {/if}
              {#if authDiscoveryError}
                <div class="settings-empty compact" role="alert"><p>{authDiscoveryError}</p></div>
              {:else if visibleProviderAccounts.length === 0}
                <div class="settings-empty compact"><p>{authAccounts.length === 0 ? "No OAuth providers were reported by OMP." : "No providers match this search."}</p></div>
              {:else}
                <div class="provider-list">
                  {#each visibleProviderAccounts as account (account.provider)}
                    <article class="provider-row">
                      <div class="provider-copy">
                        <span class="provider-name"><strong>{account.name}</strong><span class="mono">{account.provider}</span></span>
                        <small>{account.signedIn ? account.email ?? account.orgName ?? "Authenticated locally" : account.available ? "Ready to connect" : "Not available in this runtime"}</small>
                      </div>
                      <div class="provider-actions">
                        <span class:connected={account.signedIn} class:unavailable={!account.available} class="provider-state">{account.signedIn ? "Connected" : account.available ? "Available" : "Unavailable"}</span>
                        {#if account.signedIn}
                          <button type="button" class="secondary-button" aria-label={`Sign out of ${account.name}`} disabled={Boolean(authBusyProvider)} onclick={() => void logoutProvider(account)}>{authBusyProvider === account.provider ? "Signing out…" : "Sign out"}</button>
                        {:else if account.available}
                          <button type="button" class="primary-button" aria-label={`Sign in to ${account.name}`} disabled={Boolean(authBusyProvider)} onclick={() => void loginProvider(account)}>{authBusyProvider === account.provider ? "Waiting for sign-in…" : "Sign in"} <span class="button-arrow"><ArrowRight size={14} aria-hidden="true" /></span></button>
                        {/if}
                      </div>
                    </article>
                  {/each}
                </div>
              {/if}
            </section>
          {/if}
          {#if showAllOAuthProviders || visibleOAuthProviders.length > 0}
            <section class="settings-section oauth-account-details" aria-label="OAuth account details">
              <div class="settings-section-heading">
                <h3>OAuth accounts</h3>
                {#if isSettingVisible(visibleSettingIds, "accounts.failover") && oauthAccounts.providers.length > 0}
                  <ToggleField
                    label="Allow failover"
                    description="Only use another account when enabled."
                    ariaLabel="Allow OAuth account failover"
                    checked={oauthAccounts.providers.some(provider => provider.failover)}
                    disabled={authBusyAccount === "failover"}
                    onchange={(checked) => void setAccountFailover(checked)}
                  />
                {/if}
              </div>
              {#if visibleOAuthProviders.length === 0}
                <div class="settings-empty compact"><p>No OAuth account details were reported by OMP.</p></div>
              {/if}
              {#each visibleOAuthProviders as provider (provider.id)}
                {@const providerSearchMatch = isSettingVisible(visibleSettingIds, `accounts.oauth:${provider.id}`)}
                <article class="provider-row oauth-provider-row">
                  <div class="provider-copy">
                    <span class="provider-name"><strong>{provider.name}</strong><span class="mono">{provider.id}</span></span>
                    <small>{provider.available ? (provider.failover ? "Failover enabled" : "Failover disabled") : "Unavailable in this runtime"}</small>
                  </div>
                  <div class="oauth-credentials">
                    {#each provider.accounts as account (account.credentialId)}
                      <div class="oauth-credential" class:locked={account.locked} class:active={account.active}>
                        <span>
                          <strong>{account.email ?? account.orgName ?? account.accountId ?? `Credential ${account.credentialId}`}</strong>
                          <small>{account.orgName ?? account.orgId ?? (account.active ? "Active account" : "Available account")}{#if account.locked} · Locked{/if}</small>
                        </span>
                        <span class="provider-actions">
                          {#if account.lockable && (providerSearchMatch || isSettingVisible(visibleSettingIds, "accounts.lock"))}
                            <button type="button" class="secondary-button" disabled={authBusyAccount === provider.id} onclick={() => void setAccountLock(provider.id, account.locked ? undefined : account.credentialId)}>{account.locked ? "Clear lock" : "Lock"}</button>
                          {/if}
                          {#if providerSearchMatch || isSettingVisible(visibleSettingIds, "accounts.remove")}
                            <button type="button" class="secondary-button" disabled={authBusyAccount === `${provider.id}:${account.credentialId}`} onclick={() => void removeAccount(provider.id, account.credentialId)}>Remove</button>
                          {/if}
                        </span>
                      </div>
                    {/each}
                  </div>
                </article>
              {/each}
            </section>
          {/if}
          {#if isSettingVisible(visibleSettingIds, "accounts.security")}
            <section class="settings-section security-note" aria-labelledby="security-title"><h3 id="security-title">Local and redacted</h3><p>Access and refresh tokens are used only by the local runtime. Gradivus exposes provider status and account identity, not credential material.</p></section>
          {/if}
          {#if authStatusMessage}<p class="settings-status" role="status">{authStatusMessage}</p>{/if}
        {/if}
      {/snippet}
    </SettingsShell>
  {/if}
  {#if parityDialog}
    <ModalShell
      backdrop
      dialogClass="parity-dialog"
      labelledbyId="parity-dialog-title"
      onclose={closeParityDialog}
      cancelable={true}
    >
      <span class="eyebrow">OMP session</span>
      <h2 id="parity-dialog-title">
        {parityDialog === "compact" ? "Compact context" : parityDialog === "handoff" ? "Hand off context" : "Restart OMP"}
      </h2>
      {#if parityDialog === "restart"}
        <p>
          Restart keeps this session and transcript, but
          {#if current?.isStreaming} interrupts the active turn{/if}
          {#if current?.isStreaming && (current?.queuedMessageCount ?? 0) > 0} and{/if}
          {#if (current?.queuedMessageCount ?? 0) > 0} discards {current?.queuedMessageCount} queued message{current?.queuedMessageCount === 1 ? "" : "s"}{/if}.
          The runtime resumes from the same session file.
        </p>
      {:else}
        <p>
          {parityDialog === "compact"
            ? "Reduce context usage while preserving the important work."
            : "Save a handoff summary and start a fresh continuation."}
        </p>
        <label>
          <span>Optional focus instructions</span>
          <textarea rows="4" bind:value={parityInstructions} placeholder="What should the summary prioritize?"></textarea>
        </label>
      {/if}
      {#if parityStatus}<p class="parity-dialog-status" role="alert">{parityStatus}</p>{/if}
      <div class="dialog-actions">
        <button bind:this={parityDefaultButton} type="button" class="secondary-button" disabled={Boolean(parityBusy)} onclick={closeParityDialog}>Cancel</button>
        {#if parityDialog === "restart"}
          <button type="button" class="danger-button" disabled={Boolean(parityBusy)} onclick={() => void restartOmp()}>
            {parityBusy === "restart" ? "Restarting…" : "Restart OMP"}
          </button>
        {:else}
          <button type="button" class="primary-button" disabled={Boolean(parityBusy)} onclick={() => void runContextMutation(parityDialog === "compact" ? "compact" : "handoff")}>
            {parityBusy === parityDialog ? (parityDialog === "compact" ? "Compacting…" : "Handing off…") : parityDialog === "compact" ? "Compact" : "Hand off"}
          </button>
        {/if}
      </div>
    </ModalShell>
  {/if}
  {#if sessionStats}
    <SessionStatsModal stats={sessionStats} onclose={() => sessionStats = undefined} />
  {/if}
  {#if pendingSettingsNavigation}
    <ModalShell backdrop dialogClass="agent-prompt-confirm" labelledbyId="settings-prompt-dirty-title" onclose={keepPromptDraft}>
      <h2 id="settings-prompt-dirty-title">Discard unsaved subagent prompt?</h2>
      <p>Your prompt draft is not saved. Keep editing to preserve its exact contents.</p>
      <div class="dialog-actions">
        <button bind:this={promptDirtyDefaultAction} type="button" class="primary-button" onclick={keepPromptDraft}>Keep editing</button>
        <button type="button" class="secondary-button" onclick={discardPromptDraftAndNavigate}>Discard changes</button>
      </div>
    </ModalShell>
  {/if}

  {#if aboutOpen}<ModalShell backdrop dialogClass="extension-dialog about-dialog" labelledbyId="about-title" onclose={closeAbout}><span class="eyebrow">Gradivus Labs</span><h2 id="about-title">Gradivus</h2><p>Local Work and Code sessions powered by the Oh My Pi RPC runtime.</p><dl class="about-list"><dt>Version</dt><dd>0.1.0</dd><dt>Backend</dt><dd>Oh My Pi · MIT License</dd><dt>Icons</dt><dd>Solar Icons by 480 Design · CC BY 4.0</dd><dt>Fonts</dt><dd>Sora and Nunito Sans · SIL Open Font License 1.1</dd></dl><p class="muted-copy">Full third-party notices are included in THIRD_PARTY_LICENSES.txt beside the packaged application.</p><div class="dialog-actions"><button class="primary-button" onclick={closeAbout}>Close</button></div></ModalShell>{/if}
  {#if authPrompt}<ModalShell backdrop dialogClass="extension-dialog auth-prompt" labelledbyId="auth-prompt-title"><span class="eyebrow">Private sign-in step</span><h2 id="auth-prompt-title">Authentication input</h2><p>{authPrompt.message}</p><input class="extension-editor" type="password" aria-label="Authentication input" autocomplete="one-time-code" placeholder={authPrompt.placeholder} bind:value={authPromptValue} onkeydown={(event) => event.key === "Enter" && void submitAuthPrompt()} /><div class="dialog-actions"><button class="secondary-button" onclick={() => void cancelAuthPrompt()}>Cancel</button><button class="primary-button" onclick={() => void submitAuthPrompt()}>Submit</button></div></ModalShell>{/if}
  {#if notice}<Toast variant={`notice-toast tone-${notice.tone}`} role={noticeRole(notice.tone)} title={notice.title} message={notice.message} dismissLabel="Dismiss notification" ondismiss={() => (notice = undefined)} />{/if}
  {#if errorMessage}<Toast variant="error-toast" role="alert" title="Action failed" message={errorMessage} dismissLabel="Dismiss error" ondismiss={() => (errorMessage = "")} />{/if}
  {#if pendingExtension && pendingExtension.method !== "notify" && pendingExtension.method !== "set_editor_text" && pendingExtension.method !== "open_url"}<ModalShell backdrop dialogClass="extension-dialog" labelledbyId="extension-title"><span class="eyebrow">OMP extension</span><h2 id="extension-title">{pendingExtension.title ?? "Input required"}</h2>{#if pendingExtension.message}<p>{pendingExtension.message}</p>{/if}{#if pendingExtension.method === "select"}<div class="extension-options">{#each pendingExtension.options ?? [] as option}<button class="secondary-button" onclick={() => void respondExtension({ value: option })}>{option}</button>{/each}</div>{:else if pendingExtension.method === "confirm"}<div class="dialog-actions"><button class="secondary-button" onclick={() => void respondExtension({ confirmed: false })}>Cancel</button><button class="primary-button" onclick={() => void respondExtension({ confirmed: true })}>Confirm</button></div>{:else}{#if pendingExtension.method === "input" && pendingExtension.sensitive}<input class="extension-editor" type="password" aria-label="Sensitive input" autocomplete="current-password" placeholder={pendingExtension.placeholder} value={pendingExtension.prefill ?? ""} oninput={(event) => pendingExtension = pendingExtension ? { ...pendingExtension, prefill: (event.currentTarget as HTMLInputElement).value } : undefined} />{:else}<textarea class="extension-editor" aria-label={pendingExtension.method === "editor" ? "Editor input" : "Input"} placeholder={pendingExtension.placeholder} value={pendingExtension.prefill ?? ""} oninput={(event) => pendingExtension = pendingExtension ? { ...pendingExtension, prefill: (event.currentTarget as HTMLTextAreaElement).value } : undefined}></textarea>{/if}<div class="dialog-actions"><button class="secondary-button" onclick={() => void respondExtension({ cancelled: true })}>Cancel</button><button class="primary-button" onclick={() => void respondExtension({ value: pendingExtension?.prefill ?? "" })}>Submit</button></div>{/if}</ModalShell>{/if}
</div>
