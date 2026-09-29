<script lang="ts">
  import { onMount, tick, type Snippet } from "svelte";
  import ArrowDown from "@solar-icons/svelte/linear/arrow-down";
  import ArrowRight from "@solar-icons/svelte/linear/arrow-right";
  import Bolt from "@solar-icons/svelte/linear/bolt";
  import ClockCircle from "@solar-icons/svelte/linear/clock-circle";
  import CloseCircle from "@solar-icons/svelte/linear/close-circle";
  import Folder from "@solar-icons/svelte/linear/folder";
  import UsersGroupRounded from "@solar-icons/svelte/linear/users-group-rounded";
  import Pen2 from "@solar-icons/svelte/linear/pen-2";
  import Stop from "@solar-icons/svelte/linear/stop";
  import type { ChatApi } from "./chat-api";
  import {
    MAX_INLINE_PROMPT_BYTES,
    MAX_PROMPT_ATTACHMENT_BATCH_BYTES,
    MAX_PROMPT_ATTACHMENT_BYTES,
    MAX_PROMPT_ATTACHMENT_COUNT,
    type HostedAppearanceSettings,
    type HostedChatEvent,
    type HostedBootstrapSnapshot,
    type HostedAgentHubAgent as AgentHubAgent,
    type HostedAgentHubMessagePage as AgentHubMessagePage,
    type HostedAgentHubSnapshot as AgentHubSnapshot,
    type HostedAgentPrompt as AgentPromptView,
    type HostedAgentPromptScope as AgentPromptScope,
    type HostedAgentSetting as AgentSettingView,
    type HostedAgentSettingJsonValue,
    type HostedAgentSettingTab as AgentSettingTab,
    type HostedAgentSettingValue as AgentSettingValue,
    type HostedFileView,
    type HostedWorkspaceFilePreview,
    type HostedInterruptMode as InterruptMode,
    type HostedModelOption as ModelOption,
    type HostedOpenRouterModelRouting as OpenRouterModelRouting,
    type HostedPlanReview as PlanReviewView,
    type HostedPlanReviewResolution as PlanReviewResolutionResult,
    type HostedPromptAttachmentView as PromptAttachmentView,
    type HostedQueueMode as QueueMode,
    type HostedSessionKind as SessionKind,
    type HostedSessionRecord as SessionRecordV1,
    type HostedSessionSnapshot as SessionSnapshot,
    type HostedSessionStats as SessionStatsView,
    type HostedSlashCommand as SlashCommand,
    type HostedSubagentView as SubagentView,
    type HostedThinkingLevel as ThinkingLevel,
    type HostedTimelineItem as TimelineItem,
    type HostedTimelineToolActivity as TimelineToolActivity,
    type HostedTodoPhase as TodoPhase,
    type HostedTodoState as TodoState,
  } from "./contracts";
  import {
    agentSettingOptionToDropdownOption,
    agentSettingValueKey,
    type DropdownOption,
    type SettingsCategoryId,
    type SettingsRoute,
  } from "./control-types";
  import {
    attachmentsReferencedByDraft,
    buildPromptComposition,
    insertAttachmentReferences,
    removeAttachmentReference,
    resolveAttachmentInsertionIndex,
  } from "./attachment-composition";
  import { promptAttachmentDisplayText } from "./attachment-display";
  import { commandInsertion, searchSlashCommands, slashCommandQuery } from "./command-search";
  import { changedFiles, projectTimeline } from "./projection";
  import { type SettingsSearchEntry } from "./settings-search";
  import { type TodoEditBuffer } from "./todo-editing";
  import { projectTurnFileSummaries } from "./turn-file-summary";
  import {
    AgentHubPanel,
    AttachmentChip,
    CommandMenu,
    Composer,
    CustomDropdown,
    FileActivityPanel,
    FileDiffInspector,
    IconButton,
    LabeledSelect,
    ModalShell,
    ModelCapabilityIcons,
    OpenRouterModelAccordion,
    PlanReviewModal,
    RunInspector,
    SessionRail,
    SessionStatsModal,
    SettingsShell,
    StateCard,
    SubagentPromptEditor,
    TimelineEntry,
    Toast,
    TodoDock,
    ToggleField,
    TurnFileSummaryView as TurnFileSummary,
  } from "./ui";

  type FileDiffView = Extract<HostedFileView, { kind: "diff" }>;
  type ResolvedTheme = "dark" | "light";
  type PromptResultEvent = Extract<HostedChatEvent, { type: "prompt_result" }>;
  export let api: ChatApi;
  export let appearance: HostedAppearanceSettings = {
    theme: "system",
    density: "comfortable",
    reduceMotion: false,
    showToolDetails: true,
  };
  export let theme: ResolvedTheme = "dark";
  export let onAppearanceChange: (next: HostedAppearanceSettings) => void = () => undefined;
  export let onActiveSessionChange: (sessionId: string) => void = () => undefined;
  export let settingsContent: Snippet<[SettingsCategoryId, ReadonlySet<string>]> | undefined = undefined;
  export let onSettingsOpenChange: (open: boolean, category: SettingsCategoryId) => void = () => undefined;
  export let settingsRequest: { category: SettingsCategoryId; requestId: number } | undefined = undefined;
  let settingsRoute: SettingsRoute = { open: false, activeCategory: "runtime", query: "" };
  const onOpenSettings = (category: SettingsCategoryId, _trigger?: HTMLElement): void => {
    settingsRoute = { open: true, activeCategory: category, query: "" };
    onSettingsOpenChange(true, category);
  };
  const onSettingsRouteChange = (
    updates: Partial<Pick<SettingsRoute, "activeCategory" | "query">>,
  ): void => {
    settingsRoute = { ...settingsRoute, ...updates };
  };
  const onCloseSettings = (): void => {
    settingsRoute = { ...settingsRoute, open: false };
    onSettingsOpenChange(false, settingsRoute.activeCategory);
  };
  let observedSettingsRequestId = 0;
  $: if (settingsRequest && settingsRequest.requestId !== observedSettingsRequestId) {
    observedSettingsRequestId = settingsRequest.requestId;
    onOpenSettings(settingsRequest.category);
  }
  const QUICK_COMMAND_NAMES = ["mcp", "tree", "export", "share"] as const;
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
  const APPEARANCE_THEME_OPTIONS: readonly DropdownOption[] = [
    { key: "system", value: "system", label: "System" },
    { key: "dark", value: "dark", label: "Dark" },
    { key: "light", value: "light", label: "Light" },
  ];
  const APPEARANCE_DENSITY_OPTIONS: readonly DropdownOption[] = [
    { key: "comfortable", value: "comfortable", label: "Comfortable" },
    { key: "compact", value: "compact", label: "Compact" },
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
    { tab: "memory", category: "omp-memory", label: "Memory" },
    { tab: "files", category: "omp-files", label: "Files" },
    { tab: "shell", category: "omp-shell", label: "Shell" },
    { tab: "tools", category: "omp-tools", label: "Tools" },
    { tab: "tasks", category: "omp-tasks", label: "Tasks" },
    { tab: "providers", category: "omp-providers", label: "Providers" },
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
    { id: "theme", category: "app-appearance", group: "Appearance", label: "Theme", description: "Color palette for this chat.", keywords: ["dark light system"] },
    { id: "density", category: "app-appearance", group: "Appearance", label: "Interface density", description: "Choose the amount of spacing around controls and content.", keywords: ["comfortable compact spacing"] },
    { id: "reduceMotion", category: "app-appearance", group: "Appearance", label: "Reduce motion", description: "Limit interface animation in addition to the operating system preference.", keywords: ["animation accessibility"] },
    { id: "showToolDetails", category: "app-appearance", group: "Appearance", label: "Show tool details", description: "Show safe tool previews and argument badges in the transcript.", keywords: ["transcript previews arguments"] },
  ];

  interface BootstrapSnapshot {
    registry: {
      sessions: SessionRecordV1[];
      activeByKind: Record<SessionKind, string | null>;
    };
    warning?: string;
  }

  function normalizeBootstrap(snapshot: HostedBootstrapSnapshot): BootstrapSnapshot {
    const active = snapshot.sessions.find(session => session.id === snapshot.activeSessionId);
    return {
      registry: {
        sessions: snapshot.sessions,
        activeByKind: {
          work: active?.kind === "work" ? active.id : null,
          code: active?.kind === "code" ? active.id : null,
        },
      },
      warning: snapshot.warning,
    };
  }
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
  let earlyPromptResults = new Map<string, PromptResultEvent>();
  let explicitStopSessions = new Set<string>();
  let canceledPromptTextsBySession = new Map<string, string[]>();
  let turnStartTime: number | null = null;
  let elapsedSeconds = 0;
  let isScrolledUp = false;
  let unseenCount = 0;
  let unseenIdsBySession = new Map<string, Set<string>>();
  let turnInterval: number | undefined;
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
  let fileDiffReturnFocus: HTMLElement | null = null;
  let deleteTarget: { id: string; name: string } | undefined;
  let deleteReturnFocus: HTMLElement | null = null;
  let deleteBusy = false;
  let deleteError = "";
  let diffRequestToken = 0;
  let selectedProviderOverride = "";

  type InspectorTab = "agents" | "files";
  let inspectorOpen = false;
  let compactLayout = false;
  let chatDrawerOpen = false;
  let chatsButton: HTMLButtonElement | undefined;
  let inspectorReturnFocus: HTMLElement | null = null;
  let inspectorTab: InspectorTab = "agents";
  let fileInspectorTarget = "";
  let agentHubWindowOpen = false;
  let blockingSurfaceOpen = false;
  let agentHubDialog: HTMLDialogElement | undefined;
  let agentHubReturnFocus: HTMLElement | undefined;
  let appShellElement: HTMLDivElement | undefined;
  let transcriptPane: HTMLElement | undefined;
  let agentHubPaneResizeObserver: ResizeObserver | undefined;
  let inspectorTabBySession = new Map<string, InspectorTab>();
  $: blockingSurfaceOpen = Boolean(
    settingsRoute.open ||
    planReviewVisible ||
    deleteTarget ||
    chatDrawerOpen ||
    (compactLayout && inspectorOpen) ||
    selectedDiffPath ||
    agentHubWindowOpen,
  );
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
        review = await api.requestPlanReview(sessionId);
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
    const updated = await api.updatePlanReview(
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
    const updated = await api.requestPlanReview(current.record.id);
    setSessionPlanReview(current.record.id, updated);
    return updated;
  }

  async function resolveVisiblePlanReview(decision: Parameters<typeof api.resolvePlanReview>[3]): Promise<PlanReviewResolutionResult> {
    if (!current || !activePlanReview) throw new Error("No active plan review");
    return api.resolvePlanReview(
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
      const key = session.workspace.id;
      const list = map.get(key) ?? [];
      list.push(session);
      map.set(key, list);
    }
    const groups: WorkspaceGroup[] = [];
    for (const [workspaceId, groupSessions] of map.entries()) {
      groups.push({
        cwd: workspaceId,
        folderName: groupSessions[0]?.workspace.name ?? "Workspace",
        sessions: groupSessions,
        isRunning: groupSessions.some(session => sessionLiveStatus.get(session.id)?.status === "running"),
      });
    }
    return groups;
  })();
  async function createNewChatInWorkspace(workspaceId: string): Promise<void> {
    loading = true;
    try {
      const created = await api.createInWorkspace(workspaceId, kind);
      await selectSession(created.record.id);
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

  function sessionDisplayName(
    record?: { title?: string | null; workspace?: { name: string } },
    fallbackKind: SessionKind = kind,
  ): string {
    if (!record) return fallbackKind === "work" ? "Untitled workspace" : "Untitled code workspace";
    if (record.title && record.title.trim().length > 0) return record.title.trim();
    return record.workspace?.name || (fallbackKind === "work" ? "Untitled workspace" : "Untitled code workspace");
  }
  type SessionViewModel = SessionSnapshot;

  function formatElapsed(seconds: number): string {
    const s = Math.max(0, Math.floor(seconds));
    const mins = Math.floor(s / 60);
    const secs = s % 60;
    return `${mins}:${secs.toString().padStart(2, "0")}s`;
  }

  function formatToolActivity(
    activity: TimelineToolActivity | undefined,
    fallbackDetail?: string,
  ): string | undefined {
    if (activity?.operation === "read" || activity?.operation === "write") return activity.path;
    if (activity?.operation === "edit") return activity.paths.slice(0, 2).join(", ");
    if (activity?.operation === "hub") return activity.target ?? activity.operationName;
    if (activity?.operation === "eval") return activity.title ?? activity.languages.join(", ");
    return fallbackDetail?.trim() || undefined;
  }

  function activeTurnActivity(current: SessionViewModel): { type: "thinking" | "tool" | "generating"; label: string; detail?: string } {
    const items = current.timeline ?? [];
    for (let i = items.length - 1; i >= 0; i--) {
      const item = items[i];
      if (item.status === "running" && item.kind === "tool") {
        const label = item.toolName || item.text || "Tool";
        const detail = formatToolActivity(item.toolActivity, item.detail);
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
        turnInterval = window.setInterval(() => {
          if (turnStartTime !== null) {
            elapsedSeconds = Math.max(0, Math.floor((Date.now() - turnStartTime) / 1000));
          }
        }, 500);
      }
    } else {
      if (turnStartTime !== null) turnStartTime = null;
      if (elapsedSeconds !== 0) elapsedSeconds = 0;
      if (turnInterval) {
        window.clearInterval(turnInterval);
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
  $: activeAgentSettingTab = AGENT_SETTING_CATEGORIES.find(
    item => item.category === settingsRoute.activeCategory,
  )?.tab;
  $: settingsSearchEntries = buildSettingsSearchEntries(agentSettings, agentPrompts);
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
    unsubscribe = api.onEvent(handleEvent);
    const unsubscribeReconnect = api.onReconnect?.((snapshot) => {
      bootstrap = normalizeBootstrap(snapshot);
      const survivingIds = new Set(snapshot.sessions.map(session => session.id));
      sessionLiveStatus = new Map([...sessionLiveStatus].filter(([id]) => survivingIds.has(id)));
      if (survivingIds.has(activeId)) return;
      const nextId = snapshot.activeSessionId && survivingIds.has(snapshot.activeSessionId)
        ? snapshot.activeSessionId
        : snapshot.sessions[0]?.id;
      if (nextId) {
        void selectSession(nextId);
      } else {
        if (current) draftBySession.set(current.record.id, draft);
        discardVisibleAttachments();
        current = undefined;
        sessionSelectionToken += 1;
        activeId = "";
        timelineSessionSource = undefined;
        availableCommands = [];
        availableModels = [];
        draft = "";
        inspectorOpen = false;
        closePlanReview();
        resetAgentHubState("");
      }
    });
    agentHubPaneResizeObserver = new ResizeObserver(syncAgentHubWindowGeometry);
    if (transcriptPane) agentHubPaneResizeObserver.observe(transcriptPane);
    const compactQuery = window.matchMedia("(max-width: 759px)");
    const syncCompactLayout = (): void => {
      compactLayout = compactQuery.matches;
      if (!compactLayout) chatDrawerOpen = false;
    };
    syncCompactLayout();
    compactQuery.addEventListener("change", syncCompactLayout);
    void (async () => {
      try {
        bootstrap = normalizeBootstrap(await api.bootstrap());
        const initial = bootstrap.registry.activeByKind.work ?? bootstrap.registry.activeByKind.code ?? bootstrap.registry.sessions[0]?.id;
        if (initial) await selectSession(initial);
      } catch (error) { showError(error); }
    })();
    return () => {
      discardVisibleAttachments();
      unsubscribe?.();
      unsubscribeReconnect?.();
      compactQuery.removeEventListener("change", syncCompactLayout);
      clearTimelineProgrammaticScroll();
      timelineResizeObserver?.disconnect();
      agentHubPaneResizeObserver?.disconnect();
      if (turnInterval) window.clearInterval(turnInterval);
    };
  });

  function selectSessionFromRail(id: string): void {
    const live = sessionLiveStatus.get(id);
    if (live?.hasUnseenComplete) {
      updateSessionStatus(id, live.status);
    }
    chatDrawerOpen = false;
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
      const snapshot = await api.openSession(id);
      if (requestToken !== sessionSelectionToken || activeId !== id) return;
      current = snapshot;
      syncSnapshotPlanReview(snapshot);
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
    fileDiffReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const requestToken = ++diffRequestToken;
    selectedDiffPath = path;
    selectedDiff = undefined;
    diffLoading = true;
    diffError = "";
    await tick();
    composerInput?.focus();
    try {
      const result = await api.loadFileDiff(sessionId, path);
      if (requestToken !== diffRequestToken || current?.record.id !== sessionId) return;
      if (result.kind !== "diff") throw new Error("Desktop returned an invalid file diff.");
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
    const returnFocus = fileDiffReturnFocus;
    fileDiffReturnFocus = null;
    resetFileDiff();
    void tick().then(() => {
      if (returnFocus?.isConnected) returnFocus.focus();
      else composerInput?.focus();
    });
  }

  async function revealOlder(): Promise<void> {
    if (!current || loadingOlder || hiddenTimelineCount <= 0) return;
    loadingOlder = true;
    const sessionId = current.record.id;
    const wasFollowing = followIntent(sessionId);
    try {
      const page = await api.loadTimelinePage(sessionId, hiddenTimelineCount, 100);
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
      const result = await api.chooseWorkspaceAndCreate(kind);
      const snapshot = result.snapshot;
      if (!snapshot) {
        if (result.action.state === "cancelled") showNotice("No workspace selected.", "info", "Desktop");
        return;
      }
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
      current = await api.resume(id);
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
      current = await api.stop(id);
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
    attachmentBusy = true;
    attachmentStatus = `Staging ${selected.length} attachment${selected.length === 1 ? "" : "s"}…`;
    try {
      if (!ensureCanCompose(admission.sessionId, admission.selectionToken)) return;
      const staged = await api.stagePromptAttachments(sessionId, selected);
      if (
        !ensureCanCompose(admission.sessionId, admission.selectionToken) ||
        current?.record.id !== sessionId ||
        attachmentGeneration !== generation
      ) {
        await api.releasePromptAttachments(sessionId, staged.map(view => view.id));
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
      await api.releasePromptAttachments(sessionId, [view.id]);
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
        const staged = await api.stagePromptText(sessionId, part.text);
        stagedPrompts.push(staged);
        orderedViews.push(staged);
      }
      if (
        !ensureCanCompose(admission.sessionId, admission.selectionToken) ||
        current?.record.id !== sessionId ||
        attachmentGeneration !== generation
      ) {
        await api.releasePromptAttachments(sessionId, stagedPrompts.map(attachment => attachment.id));
        return false;
      }
      const retainedIds = new Set(sourceAttachments.map(attachment => attachment.id));
      const removedIds = promptAttachments
        .filter(attachment => !retainedIds.has(attachment.id))
        .map(attachment => attachment.id);
      if (removedIds.length > 0) await api.releasePromptAttachments(sessionId, removedIds);
      promptAttachments = orderedViews;
      draft = orderedViews.map(attachment => attachment.reference).join(" ");
      attachmentStatus = "Oversized prompt sections are ready as contextual attachments.";
      return true;
    } catch (error) {
      if (stagedPrompts.length > 0) {
        await api
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
      await api.releasePromptAttachments(sessionId, batch.ids);
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
      const result = await api.editMessage(sessionId, editor.timelineItemId, editedText);
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
        const result = await api.resolvePlanReview(
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
      const requestId = await api.prompt(sessionId, composition);
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
      if (route === "steer") await api.steer(sessionId, composition);
      else await api.queueFollowUp(sessionId, composition);
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
      await api.steerQueued(queued.sessionId, buildPromptComposition(queued.text, queued.batch.views));
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
      await api.abort(sessionId);
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

  async function reconcilePromptResult(event: PromptResultEvent): Promise<void> {
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
    const selected = current;
    if (selected && selected.record.id === sessionId) {
      restoreDraftAfterFailure(turn.draft);
      current = { ...selected, state: "ready" };
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
      const snapshot = await api.openSession(sessionId);
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
      const updated = await api.rename(id, trimmed);
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
  function requestDeleteSession(id: string): void {
    const record = bootstrap?.registry.sessions.find(session => session.id === id);
    deleteReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    chatDrawerOpen = false;
    inspectorOpen = false;
    deleteError = "";
    deleteTarget = { id, name: record ? sessionDisplayName(record) : "this chat" };
  }

  function cancelDeleteSession(): void {
    if (deleteBusy) return;
    deleteTarget = undefined;
    deleteError = "";
  }

  async function deleteSessionFromRail(id: string): Promise<void> {
    const record = bootstrap?.registry.sessions.find(session => session.id === id);
    const name = deleteTarget?.id === id ? deleteTarget.name : record ? sessionDisplayName(record) : "this chat";
    deleteBusy = true;
    deleteError = "";
    try {
      const snapshot = normalizeBootstrap(await api.deleteSession(id, { sessionId: id, title: name }));
      bootstrap = snapshot;
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
      deleteTarget = undefined;
    } catch (error) {
      deleteError = error instanceof Error ? error.message : String(error);
    } finally {
      deleteBusy = false;
    }
  }
  async function changeSetting(type: "thinking" | "fast", value: ThinkingLevel | boolean): Promise<void> {
    if (!current) return;
    const sessionId = current.record.id;
    if (type === "thinking" && typeof value === "string") {
      const level = value;
      await saveSessionSetting("thinking", () => api.setThinking(sessionId, value), { thinkingLevel: value }, "Thinking level updated.");
    }
    if (type === "fast" && typeof value === "boolean") {
      const enabled = value;
      await saveSessionSetting("fast", () => api.setFastMode(sessionId, value), { fastMode: value }, value ? "Fast mode enabled." : "Fast mode disabled.");
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
      () => api.setModel(sessionId, model.provider, model.id),
      { model: `${model.provider}/${model.id}` },
      `Model changed to ${model.name}.`,
    );
  }

  async function changeQueueSetting(kind: "steering" | "follow-up", mode: QueueMode): Promise<void> {
    if (!current) return;
    const sessionId = current.record.id;
    await saveSessionSetting(
      kind,
      () => api.setQueueMode(sessionId, kind, mode),
      kind === "steering" ? { steeringMode: mode } : { followUpMode: mode },
      `${kind === "steering" ? "Steering" : "Follow-up"} delivery updated.`,
    );
  }

  async function changeInterruptSetting(mode: InterruptMode): Promise<void> {
    if (!current) return;
    const sessionId = current.record.id;
    await saveSessionSetting(
      "interrupt",
      () => api.setInterruptMode(sessionId, mode),
      { interruptMode: mode },
      "Interrupt behavior updated.",
    );
  }

  async function changeAutoCompaction(enabled: boolean): Promise<void> {
    if (!current) return;
    const sessionId = current.record.id;
    await saveSessionSetting(
      "compaction",
      () => api.setAutoCompaction(sessionId, enabled),
      { autoCompactionEnabled: enabled },
      enabled ? "Automatic compaction enabled." : "Automatic compaction disabled.",
    );
  }

  async function changeAutoRetry(enabled: boolean): Promise<void> {
    if (!current) return;
    const sessionId = current.record.id;
    await saveSessionSetting(
      "retry",
      () => api.setAutoRetry(sessionId, enabled),
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
      const updated = await api.setAgentSetting(sessionId, setting.path, value);
      if (isSettingsResponseCurrent(generation, sessionId)) {
        agentSettings = agentSettings.map(candidate => candidate.path === updated.path ? updated : candidate);
        settingsStatusMessage = `${updated.label} saved.`;
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
  function agentSettingDescription(setting: AgentSettingView): string {
    return setting.warning ? `${setting.description} Warning: ${setting.warning}` : setting.description;
  }

  function isAgentSettingJsonRecord(value: unknown): value is Record<string, HostedAgentSettingJsonValue> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

  function changeAgentSettingFromJson(setting: AgentSettingView, text: string): void {
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      settingsStatusMessage = `${setting.label} must contain valid JSON.`;
      return;
    }
    if (!isAgentSettingJsonRecord(value)) {
      settingsStatusMessage = `${setting.label} must be a JSON object.`;
      return;
    }
    void changeAgentSetting(setting, value);
  }

  async function saveAgentPrompt(
    name: string,
    scope: AgentPromptScope,
    systemPrompt: string,
    expectedRevision: string | null,
  ): Promise<AgentPromptView> {
    const sessionId = current?.record.id;
    const updated = await api.saveAgentPrompt(sessionId, name, scope, systemPrompt, expectedRevision);
    agentPrompts = agentPrompts.map(agent => agent.name === updated.name ? updated : agent);
    return updated;
  }

  async function resetAgentPrompt(
    name: string,
    scope: AgentPromptScope,
    expectedRevision: string,
  ): Promise<AgentPromptView> {
    const sessionId = current?.record.id;
    const updated = await api.resetAgentPrompt(sessionId, name, scope, expectedRevision);
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
      const commands = await api.getAvailableCommands(sessionId);
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
      const models = await api.getAvailableModels(sessionId);
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
      const routing = await api.getOpenRouterModelRouting(sessionId, modelId);
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
      const routing = await api.setOpenRouterProviderEnabled(sessionId, model.id, providerId, enabled);
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
  function isApplicationSettingsCategory(category: SettingsCategoryId): boolean {
    return category === "app-appearance";
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
      api.getAgentSettings(activeSessionId).then(settings => {
        if (isSettingsResponseCurrent(generation, activeSessionId)) agentSettings = settings;
      }),
      api.getAgentPrompts(promptSessionId).then(prompts => {
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
      void api.releasePromptAttachments(sessionId, removedIds).catch(error => {
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

  function buildSettingsSearchEntries(
    settings: readonly AgentSettingView[],
    prompts: readonly AgentPromptView[],
  ): readonly SettingsSearchEntry[] {
    const entries: SettingsSearchEntry[] = [...RUNTIME_SEARCH_ENTRIES, ...APPLICATION_SEARCH_ENTRIES];
    for (const category of AGENT_SETTING_CATEGORIES) {
      for (const setting of settings) {
        if (setting.tab !== category.tab) continue;
        entries.push({
          id: `omp:${setting.path}`,
          category: category.category,
          group: setting.group ?? "General",
          label: setting.label,
          description: setting.description,
          keywords: setting.warning ? [setting.warning] : [],
          path: setting.path,
          optionLabels: (setting.options ?? []).flatMap(option => [
            option.label,
            ...(option.description ? [option.description] : []),
          ]),
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
      const result = await api.getSubagentMessages(sessionId, agentId, fromByte);
      if (requestToken !== subagentRequestToken || current?.record.id !== sessionId || selectedSubagent !== agentId) return;
      if (result.reset) {
        subagentByte = 0;
        subagentTranscript = "";
      }
      if (result.entries.length > 0) {
        const chunk = result.entries.map(message => formatMessage(message)).join("\n\n");
        if (chunk) subagentTranscript = subagentTranscript ? `${subagentTranscript}\n\n${chunk}` : chunk;
      }
      subagentByte = result.nextByte;
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
      const snapshot = await api.getAgentHub(sessionId);
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
      const page: AgentHubMessagePage = await api.getAgentHubMessages(sessionId, agentId, fromByte);
      if (requestToken !== agentHubRequestToken || current?.record.id !== sessionId || agentHubSelectedAgentId !== agentId) return;
      const entries = page.entries;
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
      await api.agentHubMessage(sessionId, agentId, text);
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
      await api.agentHubKill(sessionId, agentId);
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
      await api.agentHubRevive(sessionId, agentId);
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
      await api.agentHubClear(sessionId, agentId);
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
          const updated = await api.setTodos(sessionId, phases, expectedRevision, action);
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
    const snapshot = await api.openSession(sessionId);
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
    const snapshot = await api.openSession(sessionId);
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
        ? await api.compact(sessionId, parityInstructions)
        : await api.handoff(sessionId, parityInstructions);
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
      const result = await api.retry(current.record.id);
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
      await api.abortRetry(current.record.id);
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
      sessionStats = await api.getSessionStats(current.record.id);
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
      const result = await api.exportHtml(current.record.id);
      parityStatus = result.cancelled ? "Export cancelled." : "Export saved in Gradivus Desktop.";
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
      current = await api.restart(sessionId);
      timelineSessionSource = sessionId;
      parityDialog = undefined;
      parityStatus = "OMP restarted with the same session.";
    } catch (error) {
      parityStatus = error instanceof Error ? error.message : String(error);
    } finally {
      parityBusy = undefined;
    }
  }


  function openChatDrawer(trigger: HTMLButtonElement): void {
    inspectorOpen = false;
    chatsButton = trigger;
    chatDrawerOpen = true;
  }

  function closeChatDrawer(): void {
    chatDrawerOpen = false;
  }

  function openInspector(tab: InspectorTab): void {
    chatDrawerOpen = false;
    if (compactLayout && document.activeElement instanceof HTMLElement) {
      inspectorReturnFocus = document.activeElement;
    }
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

  function openFileInInspector(path: string): void {
    fileInspectorTarget = path;
    openInspector("files");
  }

  async function copyMarkdownText(value: string): Promise<void> {
    await navigator.clipboard.writeText(value);
  }
  function toggleInspector(tab: InspectorTab): void {
    if (inspectorOpen && inspectorTab === tab) {
      closeInspector();
      return;
    }
    openInspector(tab);
  }

  function closeInspector(): void {
    const returnFocus = inspectorReturnFocus;
    inspectorReturnFocus = null;
    inspectorOpen = false;
    fileInspectorTarget = "";
    void tick().then(() => {
      if (returnFocus?.isConnected) returnFocus.focus();
    });
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
      await api.openWorkspaceFile(current.record.id, path);
    } catch (error) {
      showError(error);
    }
  }
  async function loadWorkspaceFilePreview(path: string, maxDimension: number): Promise<HostedWorkspaceFilePreview> {
    if (!current) throw new Error("No active chat");
    return api.loadWorkspaceFilePreview(current.record.id, path, maxDimension);
  }

  async function loadReasoning(item: TimelineItem): Promise<void> {
    if (!current || item.kind !== "thinking") return;
    openReasoning = new Set(openReasoning).add(item.id);
    if (item.textLoaded !== false || reasoningLoading.has(item.id)) return;
    reasoningLoading = new Set(reasoningLoading).add(item.id);
    try {
      const loaded = await api.loadTimelineItem(current.record.id, item.id);
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
      const activity = await api.loadTimelineToolDetail(sessionId, itemId);
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


  async function handleEvent(event: HostedChatEvent): Promise<void> {
    if (event.type === "desktop_action") {
      showNotice(
        event.action.state === "cancelled"
          ? "Desktop action cancelled."
          : event.action.state === "failed"
            ? event.action.message ?? "Gradivus Desktop could not finish the action."
            : "Continue in Gradivus Desktop.",
        event.action.state === "failed" ? "error" : "info",
        "Desktop",
      );
      return;
    }
    if (event.type === "extension_attention") {
      showNotice(
        "This step must be completed in Gradivus Desktop.",
        "warning",
        "Desktop attention required",
      );
      return;
    }
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
        if (snapshot.agentHub) applyAgentHubSnapshot(event.sessionId, snapshot.agentHub);
        else void refreshAgentHub(event.sessionId);
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

    if (event.type === "session" && event.state) {
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
        const message = event.runtime?.error ?? "OMP runtime stopped unexpectedly";
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

    if (!current || event.sessionId !== current.record.id) return;
    const selectedSession = current;
    if (event.type === "todo_update" && event.todoState) {
      current = { ...current, todoState: event.todoState };
      return;
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

    if (event.type === "session") {
      current = {
        ...current,
        ...(event.state ? { state: event.state } : {}),
        ...(event.runtime ? { runtime: event.runtime } : {}),
        ...(event.isStreaming !== undefined ? { isStreaming: event.isStreaming } : {}),
        ...(event.isCompacting !== undefined ? { isCompacting: event.isCompacting } : {}),
        ...("retryState" in event ? { retryState: event.retryState } : {}),
        ...(event.runtime?.error ? { warning: event.runtime.error } : {}),
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
        const baseTimeline = selectedSession.timeline ?? [];
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
        const timelineTotal = (selectedSession.timelineTotal ?? selectedSession.timeline.length) + (existed ? 0 : 1);
        current = { ...selectedSession, timeline, timelineStart: Math.max(0, timelineTotal - timeline.length), timelineTotal };
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
  }
  async function handleTogglePlanMode(): Promise<void> {
    if (!current) return;
    try {
      const updated = await api.togglePlanMode(current.record.id);
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
  function updateAppearance(updates: Partial<HostedAppearanceSettings>): void {
    appearance = { ...appearance, ...updates };
    onAppearanceChange(appearance);
  }
  function toggleThemeFromRail(): void {
    updateAppearance({ theme: theme === "dark" ? "light" : "dark" });
  }
  function selectAppearanceTheme(option: DropdownOption): void {
    if (option.value === "system" || option.value === "dark" || option.value === "light") {
      updateAppearance({ theme: option.value });
    }
  }
  function selectAppearanceDensity(option: DropdownOption): void {
    if (option.value === "comfortable" || option.value === "compact") {
      updateAppearance({ density: option.value });
    }
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
    if (href && !href.startsWith("#")) window.open(href, "_blank", "noopener,noreferrer");
  }

  function handleTranscriptKeydown(event: KeyboardEvent): void {
    if (settingsRoute.open) return;
    if (event.key === "Escape" && selectedDiffPath) {
      closeFileDiff();
      return;
    }
    if (event.key === "Enter" || event.key === " ") handleTranscriptClick(event);
  }
  function measureComposer(node: HTMLElement): { destroy(): void } {
    const sync = (): void => {
      appShellElement?.style.setProperty("--composer-height", `${Math.ceil(node.getBoundingClientRect().height)}px`);
    };
    const observer = new ResizeObserver(sync);
    observer.observe(node);
    sync();
    return {
      destroy(): void {
        observer.disconnect();
        appShellElement?.style.removeProperty("--composer-height");
      },
    };
  }

</script>
<svelte:window
  onclick={handleTranscriptClick}
  onkeydown={handleTranscriptKeydown}
  onpointerdown={handleAgentHubOutsidePointerDown}
  onfocusin={handleAgentHubFocusIn}
  onresize={syncAgentHubWindowGeometry}
/>

{#snippet inspectorSurface()}
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
        onSelect={(agentId: string) => void selectAgentHubAgent(agentId)}
        onLoadMessages={() => loadAgentHubMessages()}
        onSend={(message: string) => void sendAgentHubMessage(message)}
        onKill={(agentId: string) => void killAgentHubAgent(agentId)}
        onClear={(agentId: string) => void clearAgentHubAgent(agentId)}
        onRevive={(agentId: string) => void reviveAgentHubAgent(agentId)}
      />
    {:else}
      <FileActivityPanel
        files={outputFiles}
        selectedPath={fileInspectorTarget}
        onOpenFile={(path: string) => void openSelectedFile(path)}
        onOpenDiff={(path: string) => void openFileDiff(path)}
        loadPreview={loadWorkspaceFilePreview}
      />
    {/if}
  </RunInspector>
{/snippet}

<div bind:this={appShellElement} class="app-shell">
  <div class="settings-workspace-source" class:is-settings-hidden={settingsRoute.open} inert={blockingSurfaceOpen} aria-hidden={blockingSurfaceOpen}>
  <div class="workspace-grid" class:inspector-open={inspectorOpen}>
    {#if !compactLayout}
    <SessionRail
      groups={workspaceGroups}
      currentCwd={current?.record.workspace.id}
      loading={loading}
      activeId={activeId}
      liveStatus={sessionLiveStatus}
      displayName={(session?: { title?: string | null }) => sessionDisplayName(session)}
      onCreateWorkspace={() => void createSession()}
      onNewChatInWorkspace={(workspaceId: string) => void createNewChatInWorkspace(workspaceId)}
      onSelectSession={selectSessionFromRail}
      onDeleteSession={requestDeleteSession}
      {theme}
      themeDisabled={false}
      onOpenSettings={(trigger: HTMLButtonElement) => openSettingsFromTrigger("app-appearance", trigger)}
      onOpenAbout={openAbout}
      onToggleTheme={toggleThemeFromRail}
    />
    {/if}
    <main bind:this={transcriptPane} class="transcript-pane" aria-live="polite">
      <header class="transcript-header">
        <button
          bind:this={chatsButton}
          type="button"
          class="mobile-chats-button"
          aria-expanded={chatDrawerOpen}
          aria-controls="mobile-chat-drawer"
          onclick={(event) => openChatDrawer(event.currentTarget)}
        >
          Chats
        </button>
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
              <span class="path-label">{current.record.workspace.name}</span>
            </div>
          {/if}
        </div>
        {#if current}
          <nav class="transcript-inspector-links" aria-label="Run details">
            <button
              type="button"
              class:is-active={inspectorOpen && inspectorTab === "agents"}
              aria-pressed={inspectorOpen && inspectorTab === "agents"}
              aria-label={`${inspectorOpen && inspectorTab === "agents" ? "Close" : "Open"} Agent Hub${agentHubUnreadCount > 0 ? `, ${agentHubUnreadCount} unread` : ""}`}
              onclick={() => toggleInspector("agents")}
            ><UsersGroupRounded size={17} aria-hidden="true" /><span class="inspector-link-label">Agents</span>{#if agentHubUnreadCount > 0}<span class="inspector-link-count">{agentHubUnreadCount}</span>{/if}</button>
            <button
              type="button"
              class:is-active={inspectorOpen && inspectorTab === "files"}
              aria-pressed={inspectorOpen && inspectorTab === "files"}
              aria-label={`${inspectorOpen && inspectorTab === "files" ? "Close" : "Open"} Files${fileActivityCount > 0 ? `, ${fileActivityCount} files` : ""}`}
              onclick={() => toggleInspector("files")}
            ><Folder size={17} aria-hidden="true" /><span class="inspector-link-label">Files</span>{#if fileActivityCount > 0}<span class="inspector-link-count">{fileActivityCount}</span>{/if}</button>
          </nav>
        {/if}
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
                showToolDetails={appearance.showToolDetails}
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
                onreview={(path: string) => void openFileDiff(path)}
                onopen={(path: string) => void openSelectedFile(path)}
                onpreview={openFileInInspector}
              />
            {/if}
          {/each}
          {#if current.state === "error"}<StateCard variant="error"><strong>Runtime stopped unexpectedly</strong><span>{current.warning ?? "Resume to reconnect and recover the saved transcript."}</span><button class="secondary-button" onclick={() => void resumeSession()}>Reconnect</button></StateCard>{/if}
          </div>
        </div>
      {/if}

      {#if current}
        <section use:measureComposer class="composer-wrap" role="group" aria-label="Prompt composer" class:dragging={dragDepth > 0} ondragenter={handleDragEnter} ondragover={handleDragOver} ondragleave={handleDragLeave} ondrop={handleDrop} ondragend={handleDragEnd}>
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
          <TodoDock
            sessionId={current.record.id}
            todoState={current.todoState}
            buffer={todoEditBuffer}
            undoState={todoUndoState}
        onBufferChange={(nextBuffer: TodoEditBuffer | undefined) => updateTodoEditBuffer(current!.record.id, nextBuffer)}
        onSave={(phases: TodoPhase[], expectedRevision: number, action: string) =>
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
            onHighlight={(index: number) => selectedCommandIndex = index}
            />
          {/if}

          <!-- Model & Provider Selection Dropdowns above chatbox -->
          <Composer
            providerOptions={providerDropdownOptions}
            providerSelectedKey={activeProvider}
            providerDisabled={settingsBusy.has("model") || !canCompose || modelProviders.length === 0}
            modelOptions={composerModelDropdownOptions}
            modelSelectedKey={activeModelId ? `${activeProvider}/${activeModelId}` : ""}
            modelDisabled={settingsBusy.has("model") || !canCompose || modelsForActiveProvider.length === 0}
            onProviderSelect={handleProviderDropdownSelect}
            onModelSelect={handleModelDropdownSelect}
            dragging={dragDepth > 0}
            canCompose={canCompose}
            attachDisabled={!canCompose || isComposerBusy}
            attachments={promptAttachments}
            attachmentStatus={attachmentStatus}
            displayNameFor={attachmentDisplayName}
      onStageFiles={(files: FileList, insertionIndex: number) => void stageFiles(files, insertionIndex)}
      onRemoveAttachment={(attachment: PromptAttachmentView) => void removeAttachment(attachment)}
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
      {/if}
    </main>
    {#if current && inspectorOpen && !compactLayout}
      {@render inspectorSurface()}
    {/if}
  </div>

  </div>
  {#if chatDrawerOpen && compactLayout}
    <ModalShell
      backdrop
      backdropClass="mobile-chat-drawer-backdrop"
      dialogClass="mobile-chat-drawer"
      ariaLabel="Chats"
      trapFocus
      cancelable
      initialFocusId="mobile-chat-drawer-close"
      returnFocus={chatsButton}
      onclickbackdrop={closeChatDrawer}
      backdropDismissLabel="Back to chat"
      onclose={closeChatDrawer}
    >
      <header class="mobile-sheet-header">
        <strong>Chats</strong>
        <button id="mobile-chat-drawer-close" type="button" class="secondary-button" onclick={closeChatDrawer}>Back to chat</button>
      </header>
      <SessionRail
        railId="session-rail-drawer"
        groups={workspaceGroups}
        currentCwd={current?.record.workspace.id}
        loading={loading}
        activeId={activeId}
        liveStatus={sessionLiveStatus}
        displayName={(session?: { title?: string | null }) => sessionDisplayName(session)}
        onCreateWorkspace={() => {
          closeChatDrawer();
          void createSession();
        }}
        onNewChatInWorkspace={(workspaceId: string) => {
          closeChatDrawer();
          void createNewChatInWorkspace(workspaceId);
        }}
        onSelectSession={selectSessionFromRail}
        onDeleteSession={requestDeleteSession}
        {theme}
        themeDisabled={false}
        onOpenSettings={(trigger: HTMLButtonElement) => {
          closeChatDrawer();
          openSettingsFromTrigger("app-appearance", trigger);
        }}
        onOpenAbout={(trigger: HTMLButtonElement) => {
          closeChatDrawer();
          openAbout(trigger);
        }}
        onToggleTheme={toggleThemeFromRail}
      />
    </ModalShell>
  {/if}
  {#if current && inspectorOpen && compactLayout}
    <ModalShell
      backdrop
      backdropClass="mobile-inspector-backdrop"
      dialogClass="mobile-inspector-sheet"
      ariaLabel={inspectorTab === "agents" ? "Agent Hub inspector" : "Files inspector"}
      trapFocus
      cancelable
      initialFocusId="mobile-inspector-back"
      returnFocus={inspectorReturnFocus}
      onclickbackdrop={closeInspector}
      backdropDismissLabel="Back to chat"
      onclose={closeInspector}
    >
      <header class="mobile-sheet-header">
        <strong>{inspectorTab === "agents" ? "Agent Hub" : "Files"}</strong>
        <button id="mobile-inspector-back" type="button" class="secondary-button" onclick={closeInspector}>Back to chat</button>
      </header>
      {@render inspectorSurface()}
    </ModalShell>
  {/if}
  {#if deleteTarget}
    <ModalShell
      backdrop
      dialogClass="session-stats-dialog delete-chat-dialog"
      labelledbyId="delete-chat-title"
      trapFocus
      cancelable={!deleteBusy}
      initialFocusId="keep-chat-button"
      returnFocus={deleteReturnFocus}
      onclose={cancelDeleteSession}
    >
      <h2 id="delete-chat-title">Delete “{deleteTarget.name}” from Gradivus?</h2>
      <p>The Gradivus chat entry will be removed. The OMP transcript file remains on this computer.</p>
      {#if deleteError}<p class="parity-dialog-status" role="alert">{deleteError}</p>{/if}
      <div class="dialog-actions">
        <button id="keep-chat-button" type="button" class="secondary-button" disabled={deleteBusy} onclick={cancelDeleteSession}>Keep chat</button>
        <button type="button" class="danger-button" disabled={deleteBusy} onclick={() => void deleteSessionFromRail(deleteTarget!.id)}>{deleteBusy ? "Deleting…" : deleteError ? "Retry delete" : "Delete chat"}</button>
      </div>
    </ModalShell>
  {/if}
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
              onSelect={(agentId: string) => void selectAgentHubAgent(agentId)}
            onLoadMessages={() => loadAgentHubMessages()}
              onSend={(message: string) => void sendAgentHubMessage(message)}
              onKill={(agentId: string) => void killAgentHubAgent(agentId)}
              onRevive={(agentId: string) => void reviveAgentHubAgent(agentId)}
              onClear={(agentId: string) => void clearAgentHubAgent(agentId)}
          />
        </div>
      </dialog>
    </div>
  {/if}
  {#if selectedDiffPath}
    <ModalShell backdrop backdropDismissLabel="Close Git diff" dialogClass="file-diff-dialog" role="dialog" ariaLabel={`Git diff for ${selectedDiffPath}`} trapFocus cancelable returnFocus={fileDiffReturnFocus} onclickbackdrop={closeFileDiff} onclose={closeFileDiff}>
      <FileDiffInspector
        path={selectedDiffPath}
        diff={selectedDiff}
        loading={diffLoading}
        error={diffError}
        closeLabel="Back to chat"
        onClose={closeFileDiff}
        onOpenFile={() => void openSelectedFile(selectedDiffPath)}
      />
    </ModalShell>
  {/if}
  {#if planReviewVisible && activePlanReview && current?.record.id === planReviewSessionId}
    <PlanReviewModal
      review={activePlanReview}
      disabledReason={planReviewDisabledReason()}
      returnFocus={planReviewOpener}
      onclose={closePlanReview}
      onupdate={updateVisiblePlanReview}
      onresolve={resolveVisiblePlanReview}
      onreload={reloadVisiblePlanReview}
      oncopy={(content: string) => navigator.clipboard.writeText(content)}
      onaccepted={acceptPlanReview}
    />
  {/if}
  {#if settingsRoute.open}
    <SettingsShell
      route={settingsRoute}
      entries={settingsSearchEntries}
      refreshing={settingsRefreshing}
      onQueryChange={(query: string) => onSettingsRouteChange({ query })}
      onCategoryChange={requestSettingsCategoryChange}
      onRefresh={() => void refreshSettingsData()}
      onClose={requestCloseSettings}
    >
      {#snippet content(visibleSettingIds: ReadonlySet<string>)}
        {#if settingsStatusMessage && !isApplicationSettingsCategory(settingsRoute.activeCategory)}
          <p class="settings-global-status" role="status">{settingsStatusMessage}</p>
        {/if}

        {#if isApplicationSettingsCategory(settingsRoute.activeCategory)}
          <section class="settings-section" aria-label="Appearance settings">
            <div class="settings-section-heading"><h3>Appearance</h3></div>
            <p class="settings-copy">These preferences apply only to this browser.</p>
            <div class="settings-form-grid">
              {#if isSettingVisible(visibleSettingIds, "theme")}
                <LabeledSelect tone="field" label="Theme" description="Color palette for this chat." options={APPEARANCE_THEME_OPTIONS} selectedKey={appearance.theme} ariaLabel="Theme" onSelect={selectAppearanceTheme} onOpenChange={() => undefined} />
              {/if}
              {#if isSettingVisible(visibleSettingIds, "density")}
                <LabeledSelect tone="field" label="Interface density" description="Spacing around controls and transcript content." options={APPEARANCE_DENSITY_OPTIONS} selectedKey={appearance.density} ariaLabel="Interface density" onSelect={selectAppearanceDensity} onOpenChange={() => undefined} />
              {/if}
              {#if isSettingVisible(visibleSettingIds, "reduceMotion")}
                <ToggleField label="Reduce motion" description="Limit interface animation." checked={appearance.reduceMotion} onchange={(checked: boolean) => updateAppearance({ reduceMotion: checked })} />
              {/if}
              {#if isSettingVisible(visibleSettingIds, "showToolDetails")}
                <ToggleField label="Show tool details" description="Show safe tool previews and argument badges." checked={appearance.showToolDetails} onchange={(checked: boolean) => updateAppearance({ showToolDetails: checked })} />
              {/if}
            </div>
          </section>
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
              <p class="settings-context">{sessionDisplayName(current.record)}<span>{current.record.workspace.name}</span></p>
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
                            onProviderChange={(providerId: string, enabled: boolean) => void changeOpenRouterProvider(model, providerId, enabled)}
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
                      onchange={(checked: boolean) => void changeSetting("fast", checked)}
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
              <LabeledSelect tone="field" label="Steering delivery" description="How messages steer an active turn." options={QUEUE_MODE_OPTIONS} selectedKey={current.steeringMode ?? "one-at-a-time"} ariaLabel="Steering delivery" disabled={settingsBusy.has("steering")} onSelect={(option: DropdownOption) => handleQueueDropdownSelect("steering", option)} onOpenChange={() => undefined} />
                  {/if}
                  {#if isSettingVisible(visibleSettingIds, "runtime.follow-up")}
              <LabeledSelect tone="field" label="Follow-up delivery" description="How queued messages enter subsequent turns." options={QUEUE_MODE_OPTIONS} selectedKey={current.followUpMode ?? "one-at-a-time"} ariaLabel="Follow-up delivery" disabled={settingsBusy.has("follow-up")} onSelect={(option: DropdownOption) => handleQueueDropdownSelect("follow-up", option)} onOpenChange={() => undefined} />
                  {/if}
                  {#if isSettingVisible(visibleSettingIds, "runtime.interrupt")}
                    <LabeledSelect tone="field" label="Interrupt behavior" description="Whether new input interrupts immediately or waits." options={INTERRUPT_MODE_OPTIONS} selectedKey={current.interruptMode ?? "immediate"} ariaLabel="Interrupt behavior" disabled={settingsBusy.has("interrupt")} onSelect={handleInterruptDropdownSelect} onOpenChange={() => undefined} />
                  {/if}
                  {#if isSettingVisible(visibleSettingIds, "runtime.compaction")}
              <ToggleField label="Automatic compaction" description="Compact context before it reaches the model limit." checked={current.autoCompactionEnabled !== false} disabled={settingsBusy.has("compaction")} onchange={(checked: boolean) => void changeAutoCompaction(checked)} />
                  {/if}
                  {#if isSettingVisible(visibleSettingIds, "runtime.retry")}
              <ToggleField label="Automatic retry" description="Retry recoverable provider failures without a manual resend." checked={current.autoRetryEnabled !== false} disabled={settingsBusy.has("retry")} onchange={(checked: boolean) => void changeAutoRetry(checked)} />
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
          onDirtyChange={(dirty: boolean) => (agentPromptEditorDirty = dirty)}
            />
          </section>
        {:else if settingsRoute.activeCategory === "accounts"}
          {#if settingsContent}
            {@render settingsContent(settingsRoute.activeCategory, visibleSettingIds)}
          {:else}
            <section class="settings-section" aria-label="Accounts">
              <div class="settings-section-heading"><h3>Accounts</h3></div>
              <div class="settings-empty compact">
                <p>Provider accounts and local app connections are managed in Gradivus Desktop.</p>
              </div>
            </section>
          {/if}
        {:else if activeAgentSettingTab}
          {@const agentSettingGroups = visibleAgentSettingGroups(visibleSettingIds, activeAgentSettingTab)}
          {@const reportedAgentSettings = agentSettings.filter(setting => setting.tab === activeAgentSettingTab)}
          <section class="settings-section agent-settings-section" aria-label={`${settingsCategoryTitle(activeAgentSettingTab)} OMP defaults`}>
            <div class="settings-scope-row">
              <strong>OMP default</strong>
              <span class="count-badge">{reportedAgentSettings.length}</span>
            </div>
            <p class="settings-copy">Credential-free defaults shared with OMP.</p>
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
                            description={agentSettingDescription(setting)}
                            checked={setting.value === true}
                            disabled={agentSettingsBusy.has(setting.path)}
                            onchange={(checked: boolean) => void changeAgentSetting(setting, checked)}
                          />
                        {:else if setting.control === "multiselect"}
                          <label class="settings-multiselect">
                            <span>{setting.label}</span>
                            <span class="settings-description">{agentSettingDescription(setting)}</span>
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
                        {:else if setting.control === "text"}
                          <label class="settings-field">
                            <span>{setting.label}</span>
                            <small>{agentSettingDescription(setting)}</small>
                            <input
                              type="text"
                              aria-label={setting.label}
                              value={typeof setting.value === "string" ? setting.value : ""}
                              disabled={agentSettingsBusy.has(setting.path)}
                              onchange={(event) => void changeAgentSetting(setting, event.currentTarget.value)}
                            />
                          </label>
                        {:else if setting.control === "json" || setting.control === "provider-limits"}
                          <label class="settings-field settings-json-field">
                            <span>{setting.label}</span>
                            <small>{agentSettingDescription(setting)}</small>
                            <textarea
                              rows={4}
                              aria-label={setting.label}
                              disabled={agentSettingsBusy.has(setting.path)}
                              onchange={(event) => changeAgentSettingFromJson(setting, event.currentTarget.value)}
                            >{JSON.stringify(setting.value, null, 2) ?? ""}</textarea>
                          </label>
                        {:else}
                          <LabeledSelect
                            tone="field"
                            label={setting.label}
                            description={agentSettingDescription(setting)}
                            options={(setting.options ?? []).map(agentSettingOptionToDropdownOption)}
                            selectedKey={agentSettingValueKey(setting.value)}
                            ariaLabel={setting.label}
                            disabled={agentSettingsBusy.has(setting.path)}
                            onSelect={(option: DropdownOption) => changeAgentSettingFromDropdown(setting, option)}
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

  {#if aboutOpen}<ModalShell backdrop dialogClass="session-stats-dialog about-dialog" labelledbyId="about-title" onclose={closeAbout}><span class="eyebrow">Gradivus Chat</span><h2 id="about-title">Gradivus</h2><p>Coding chats are executed by Gradivus Desktop on this computer.</p><dl class="about-list"><dt>Version</dt><dd>0.1.0</dd><dt>Icons</dt><dd>Solar Icons by 480 Design · CC BY 4.0</dd><dt>Font</dt><dd>Departure Mono</dd></dl><div class="dialog-actions"><button class="primary-button" onclick={closeAbout}>Close</button></div></ModalShell>{/if}
  {#if notice}<Toast variant={`notice-toast tone-${notice.tone}`} role={noticeRole(notice.tone)} title={notice.title} message={notice.message} dismissLabel="Dismiss notification" ondismiss={() => (notice = undefined)} />{/if}
  {#if errorMessage}<Toast variant="error-toast" role="alert" title="Action failed" message={errorMessage} dismissLabel="Dismiss error" ondismiss={() => (errorMessage = "")} />{/if}
</div>
