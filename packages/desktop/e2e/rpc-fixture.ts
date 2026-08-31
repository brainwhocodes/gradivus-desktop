import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  OMP_GRPC_MAX_MESSAGE_BYTES,
  OMP_GRPC_PROTOCOL_VERSION,
  listenOmpGrpc,
  writeOmpGrpcBootstrapFile,
} from "@oh-my-pi/pi-grpc";

const FIXTURE_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

type AttachmentKind = "file" | "prompt" | "image";
type AttachmentRoute = "prompt" | "steer" | "steer_queued" | "follow_up";

type ParsedEnvelope = {
  kind: AttachmentKind;
  name?: string;
  path?: string;
};

type CaptureReference = {
  kind: "file" | "prompt";
  path: string;
  absolute: boolean;
  exists: boolean;
  bytes: number;
  sha256: string;
};

type CaptureImage = {
  mimeType: string;
  bytes: number;
  sha256: string;
  base64Valid: boolean;
};

type AttachmentAnalysis = {
  route: AttachmentRoute;
  message: string;
  baseText: string;
  envelopes: ParsedEnvelope[];
  references: CaptureReference[];
  images: CaptureImage[];
  report: string;
};

const attachmentCaptureFile = process.env.GRADIVUS_ATTACHMENT_CAPTURE_FILE;
let attachmentCaptureSequence = 0;
let rejectNextPrompt = process.env.GRADIVUS_REJECT_NEXT_PROMPT === "immediate"
  || process.env.GRADIVUS_REJECT_NEXT_PROMPT === "delayed"
    ? process.env.GRADIVUS_REJECT_NEXT_PROMPT
    : undefined;
let rejectNextSteer = process.env.GRADIVUS_REJECT_NEXT_STEER === "1";
let rejectNextFollowUp = process.env.GRADIVUS_REJECT_NEXT_FOLLOW_UP === "1";
let rejectNextSteerQueued = process.env.GRADIVUS_REJECT_NEXT_STEER_QUEUED === "1";

function decodeMention(value: string): string {
  if (value.startsWith('"')) {
    try {
      return JSON.parse(value);
    } catch {
      return value.slice(1, -1);
    }
  }
  return value.slice(1, -1).replace(/\\'/g, "'");
}

function parseEnvelopeBlock(block: string): ParsedEnvelope | undefined {
  const fullPrompt = block.match(/^Full prompt:\s+(@(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'))\. Read this file as the complete user request before responding\.$/);
  if (fullPrompt) return { kind: "prompt", path: decodeMention(fullPrompt[1].slice(1)) };
  const promptText = block.match(/^Prompt text:\s+(@(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'))\. Read the referenced UTF-8 text at this exact position in the request\.$/);
  if (promptText) return { kind: "prompt", path: decodeMention(promptText[1].slice(1)) };
  const file = block.match(/^File\s+("(?:[^"\\]|\\.)*"):\s+(@(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'))\. Read this attachment as needed\.$/);
  if (file) {
    let name = file[1];
    try { name = JSON.parse(file[1]); } catch {}
    return { kind: "file", name, path: decodeMention(file[2].slice(1)) };
  }
  const image = block.match(/^Image\s+("(?:[^"\\]|\\.)*") is attached to this message\.$/);
  if (image) {
    let name = image[1];
    try { name = JSON.parse(image[1]); } catch {}
    return { kind: "image", name };
  }
  return undefined;
}

const ATTACHMENT_REFERENCE_LINE = /\[(?:Document|Image) A\d+: "(?:[^"\\]|\\.)*"\]\n/g;
const ATTACHMENT_ENVELOPE =
  /Prompt text:\s+@(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')\. Read the referenced UTF-8 text at this exact position in the request\.|File\s+"(?:[^"\\]|\\.)*":\s+@(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')\. Read this attachment as needed\.|Image\s+"(?:[^"\\]|\\.)*" is attached to this message\./g;

function parseAttachmentMessage(message: string): { baseText: string; envelopes: ParsedEnvelope[] } {
  const normalized = message.replace(ATTACHMENT_REFERENCE_LINE, "");
  const envelopes: ParsedEnvelope[] = [];
  const baseParts: string[] = [];
  let cursor = 0;
  for (const match of normalized.matchAll(ATTACHMENT_ENVELOPE)) {
    const index = match.index ?? cursor;
    baseParts.push(normalized.slice(cursor, index));
    const envelope = parseEnvelopeBlock(match[0]);
    if (envelope) envelopes.push(envelope);
    cursor = index + match[0].length;
  }
  baseParts.push(normalized.slice(cursor));
  return { baseText: baseParts.join("").trim(), envelopes };
}

function hashBytes(bytes: Uint8Array): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function referenceMetadata(kind: "file" | "prompt", receivedPath: string): CaptureReference {
  const absolute = path.isAbsolute(receivedPath);
  const reference: CaptureReference = {
    kind,
    path: receivedPath,
    absolute,
    exists: false,
    bytes: 0,
    sha256: "",
  };
  try {
    const bytes = fs.readFileSync(receivedPath);
    reference.exists = true;
    reference.bytes = bytes.byteLength;
    reference.sha256 = hashBytes(bytes);
  } catch {}
  return reference;
}

function imageMetadata(image: unknown): CaptureImage | undefined {
  if (!image || typeof image !== "object") return undefined;
  const value = image as { type?: unknown; data?: unknown; mimeType?: unknown };
  if (value.type !== "image" || typeof value.data !== "string") return undefined;
  const data = value.data;
  const base64Valid = data.length > 0
    && data.length % 4 === 0
    && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)
    && Buffer.from(data, "base64").toString("base64") === data;
  const bytes = base64Valid ? Buffer.from(data, "base64") : Buffer.alloc(0);
  return {
    mimeType: typeof value.mimeType === "string" ? value.mimeType : "",
    bytes: bytes.byteLength,
    sha256: hashBytes(bytes),
    base64Valid,
  };
}

function analyzeAttachmentCommand(command: { message?: unknown; images?: unknown[] }, route: AttachmentRoute): AttachmentAnalysis {
  const message = typeof command.message === "string" ? command.message : "";
  const parsed = parseAttachmentMessage(message);
  const references = parsed.envelopes
    .filter((envelope): envelope is ParsedEnvelope & { kind: "file" | "prompt"; path: string } =>
      (envelope.kind === "file" || envelope.kind === "prompt") && typeof envelope.path === "string")
    .map(envelope => referenceMetadata(envelope.kind, envelope.path));
  const images = Array.isArray(command.images)
    ? command.images.map(imageMetadata).filter((image): image is CaptureImage => Boolean(image))
    : [];
  const readable = references.every(reference => reference.exists) && images.every(image => image.base64Valid);
  const fileCount = parsed.envelopes.filter(envelope => envelope.kind === "file").length;
  const promptCount = parsed.envelopes.filter(envelope => envelope.kind === "prompt").length;
  const report = fileCount + promptCount + images.length > 0
    ? `Attachment report: route=${route}; files=${fileCount}; prompts=${promptCount}; images=${images.length}; readable=${readable}`
    : "";
  return { route, message, baseText: parsed.baseText, envelopes: parsed.envelopes, references, images, report };
}

function captureCommand(command: { id?: unknown; message?: unknown; images?: unknown[] }, route: AttachmentRoute): AttachmentAnalysis {
  const analysis = analyzeAttachmentCommand(command, route);
  attachmentAnalyses.set(command, analysis);
  if (attachmentCaptureFile) {
    const record = {
      sequence: ++attachmentCaptureSequence,
      route,
      requestId: typeof command.id === "string" ? command.id : String(command.id ?? ""),
      messageBytes: Buffer.byteLength(analysis.message, "utf8"),
      baseTextBytes: Buffer.byteLength(analysis.baseText, "utf8"),
      envelopes: analysis.envelopes.map(({ kind, name }) => name === undefined ? { kind } : { kind, name }),
      references: analysis.references,
      images: analysis.images,
    };
    fs.appendFileSync(attachmentCaptureFile, `${JSON.stringify(record)}\n`, { encoding: "utf8", flag: "a" });
  }
  return analysis;
}
const attachmentAnalyses = new WeakMap<object, AttachmentAnalysis>();

const performanceFixture = process.env.GRADIVUS_PERF_FIXTURE === "1";
const timelineFixture = process.env.GRADIVUS_TIMELINE_FIXTURE === "1";
const settingsResponseDelay = Math.max(0, Number(process.env.GRADIVUS_SETTINGS_RESPONSE_DELAY ?? "0") || 0);
const extensionDelayMs = Math.max(0, Number(process.env.GRADIVUS_EXTENSION_DELAY_MS ?? "0") || 0);
const agentHubMessageDelayMs = Math.max(0, Number(process.env.GRADIVUS_AGENT_HUB_MESSAGE_DELAY_MS ?? "0") || 0);
let settingsRequestCount = 0;
const specialMessagesFixture = process.env.GRADIVUS_SPECIAL_MESSAGES === "1";
const specialMessages = specialMessagesFixture
  ? [
      {
        id: "special-welcome",
        role: "assistant",
        content: [{ type: "text", text: "Semantic transcript fixture ready." }],
      },
      {
        id: "special-system-envelope",
        role: "custom",
        customType: "system-notice",
        display: true,
        attribution: "fixture-runtime",
        content: `<system-notice title="System update">The semantic transcript fixture is active.
This system body is deliberately long enough to exercise lazy expansion.
It remains safe and readable at narrow widths.</system-notice>`,
      },
      {
        id: "special-synthetic-reminder",
        role: "user",
        synthetic: true,
        content: `<system-reminder label="Fixture reminder">Synthetic context is collapsed by default.
Expand this reminder to inspect the bounded body.
The transcript still contains the full text exactly once.</system-reminder>`,
      },
      {
        id: "special-irc-incoming",
        role: "custom",
        customType: "irc:incoming",
        display: true,
        content: "<irc>MODEL_IRC_REPLY_INSTRUCTION_SENTINEL</irc>",
        details: {
          id: "fixture-irc-history-incoming",
          from: "Mira",
          message: "Please review the latest integration notes.",
        },
      },
      {
        id: "special-irc-autoreply",
        role: "custom",
        customType: "irc:autoreply",
        display: true,
        content: "<irc>MODEL_IRC_AUTOREPLY_INSTRUCTION_SENTINEL</irc>",
        details: {
          id: "fixture-irc-history-autoreply",
          to: "Mira",
          body: "The integration notes are ready for review.",
          replyTo: "fixture-irc-history-incoming",
        },
      },
      {
        id: "special-irc-relay",
        role: "custom",
        customType: "irc:relay",
        display: true,
        content: "<irc>MODEL_IRC_RELAY_INSTRUCTION_SENTINEL</irc>",
        details: {
          id: "fixture-irc-history-relay",
          from: "Mira",
          to: "Noah",
          body: "Noah, the review is queued.",
        },
      },
      {
        id: "special-advisor",
        role: "custom",
        customType: "advisor",
        display: true,
        content: "Advisor notes",
        details: {
          notes: [
            { advisor: "Fixture Advisor", severity: "blocker", note: "The deployment token must be rotated before release." },
            { advisor: "Fixture Advisor", severity: "concern", note: "The migration should be rehearsed on a clean database." },
            { advisor: "Fixture Advisor", severity: "nit", note: "Rename the temporary fixture branch before merging." },
            { advisor: "Fixture Advisor", severity: "nit", note: "The fourth note is intentionally behind the details disclosure." },
          ],
        },
      },
      {
        id: "special-async-result",
        role: "custom",
        customType: "async-result",
        display: true,
        content: "Background jobs finished.",
        details: {
          jobs: [
            { jobId: "job-lint", label: "Lint workspace", type: "lint", durationMs: 182 },
            { jobId: "job-tests", label: "Run focused tests", type: "test", durationMs: 924 },
          ],
        },
      },
      {
        id: "special-late-diagnostic",
        role: "custom",
        customType: "lsp-late-diagnostic",
        display: true,
        content: "Late diagnostics are available.",
        details: {
          files: [
            { path: "src/routes.ts", summary: "Unused route parameter", errored: false },
            { path: "src/auth.ts", summary: "Provider timeout path needs coverage", errored: true },
          ],
        },
      },
      {
        id: "special-background-tangent",
        role: "custom",
        customType: "background-tan-dispatch",
        display: true,
        content: "Background tangent dispatched.",
        details: { jobId: "tangent-review", work: "Review the changed API boundary and report only actionable findings." },
      },
      {
        id: "special-launch-completion",
        role: "custom",
        customType: "launch-completion",
        display: true,
        content: "Local processes completed.",
        details: {
          daemons: [
            { name: "web", state: "running" },
            { name: "worker", state: "exited", exitCode: 0 },
          ],
        },
      },
      {
        id: "special-collab-prompt",
        role: "custom",
        customType: "collab-prompt",
        display: true,
        attribution: "fixture-collaborator",
        content: "Please inspect the fixture's accessibility boundary and return a concise report.",
        details: { from: "Riley" },
      },
      {
        id: "special-skill-prompt",
        role: "custom",
        customType: "skill-prompt",
        display: true,
        attribution: "fixture-extension",
        content: "Apply the semantic transcript review checklist.",
        details: {
          name: "semantic-review",
          path: "skills/transcript/semantic-review.md",
          args: "--strict --viewport=760",
          lineCount: 84,
        },
      },
      {
        id: "special-hook-fallback",
        role: "hookMessage",
        customType: "fixture-release-hook",
        display: true,
        attribution: "fixture-hook",
        content: "Hook completed the release audit without exposing its private details.",
        details: { privatePayload: "FIXTURE_UNKNOWN_DETAILS_MUST_NOT_RENDER" },
      },
      {
        id: "special-handoff",
        role: "custom",
        customType: "handoff",
        display: true,
        content: `<handoff-context>Carry the API review context into the next turn.
Preserve the pending migration warning and the verification commands.
Do not repeat the private handoff metadata.</handoff-context>`,
      },
      {
        id: "special-branch-summary",
        role: "branchSummary",
        summary: "Returned from the accessibility review branch with the following context preserved.\nThe branch verified keyboard navigation and narrow viewport wrapping.\nThe branch also recorded a follow-up migration warning.",
        fromId: "special-collab-prompt",
        timestamp: 20,
      },
      {
        id: "special-compaction-summary",
        role: "compactionSummary",
        summary: Array.from({ length: 12 }, (_, index) => `Compacted context line ${index + 1}: preserve the semantic transcript contract and its verification evidence.`).join("\n"),
        tokensBefore: 8192,
        warning: "Fixture compaction warning: expand to inspect the complete summary.",
        timestamp: 21,
      },
      {
        id: "special-bash-execution",
        role: "bashExecution",
        command: "printf 'semantic execution output'",
        output: Array.from({ length: 12 }, (_, index) => `bash output line ${index + 1}`).join("\n"),
        exitCode: 0,
        cancelled: false,
        truncated: true,
        excludeFromContext: true,
        timestamp: 22,
      },
      {
        id: "special-python-execution",
        role: "pythonExecution",
        code: "print('semantic execution output')",
        output: Array.from({ length: 10 }, (_, index) => `python output line ${index + 1}`).join("\n"),
        exitCode: 0,
        cancelled: false,
        truncated: false,
        timestamp: 23,
      },
      {
        id: "special-file-mention",
        role: "fileMention",
        files: [
          { path: "README.md", lineCount: 42, content: "fixture readme" },
          { path: "assets/logo.png", skippedReason: "binary" },
        ],
        timestamp: 24,
      },
      {
        id: "special-assistant-error",
        role: "assistant",
        content: [],
        stopReason: "error",
        errorMessage: "Fixture provider failed after the response stream ended.\nExpand this panel to inspect the complete terminal diagnostic.",
      },
      {
        id: "special-assistant-recovered",
        role: "assistant",
        content: [{ type: "text", text: "The recovered fixture response is complete." }],
        retryRecovery: { status: "recovered", note: "Recovered after one provider retry." },
      },
      {
        id: "special-hidden-developer",
        role: "developer",
        content: [{ type: "text", text: "FIXTURE_SPECIAL_HIDDEN_DEVELOPER" }],
      },
      {
        id: "special-hidden-custom",
        role: "custom",
        customType: "hidden-special-custom",
        display: false,
        content: "FIXTURE_SPECIAL_HIDDEN_CUSTOM",
      },
      {
        id: "special-hidden-hook",
        role: "hookMessage",
        customType: "hidden-special-hook",
        display: false,
        content: "FIXTURE_SPECIAL_HIDDEN_HOOK",
      },
    ]
  : undefined;
const performanceMessages = performanceFixture
  ? Array.from({ length: 10_000 }, (_, index) => ({
      id: `performance-${index}`,
      role: "assistant",
      content: [{ type: "text", text: `Performance timeline entry ${index}` }],
    }))
  : undefined;
const timelineMessages = timelineFixture
  ? Array.from({ length: 260 }, (_, index) => ({
      id: `timeline-history-${index}`,
      role: "assistant",
      content: [{ type: "text", text: `Deterministic history entry ${index + 1}` }],
    }))
  : undefined;
if (performanceMessages) {
  const reasoningChunk = "x".repeat(512 * 1024);
  for (const message of performanceMessages.slice(-10)) message.content.unshift({ type: "thinking", thinking: reasoningChunk });
  const evalTail = Array.from({ length: 200 }, (_, index) => `performance-eval-tail-${index + 1}`).join("\n");
  for (let index = 0; index < 100; index += 1) {
    const toolCallId = `performance-eval-${index}`;
    performanceMessages.push(
      {
        id: `performance-eval-call-${index}`,
        role: "assistant",
        content: [{
          type: "toolCall",
          id: toolCallId,
          name: "eval",
          arguments: { language: "py", title: `performance eval ${index + 1}`, code: `value = ${index}\n${evalTail}` },
        }],
      },
      {
        id: `performance-eval-result-${index}`,
        role: "toolResult",
        toolCallId,
        isError: false,
        content: [{ type: "text", text: "performance eval complete" }],
        details: {
          languages: ["python"],
          cells: [{
            index: 0,
            title: `performance eval ${index + 1}`,
            language: "python",
            code: `value = ${index}\n${evalTail}`,
            output: `${index}\n${evalTail}`,
            status: "complete",
            durationMs: index + 1,
          }],
          jsonOutputs: [{ marker: `PERFORMANCE_EVAL_RAW_${index}` }],
        },
      },
    );
  }
}

const availableCommands = [
  { name: "status", aliases: ["usage"], description: "Show current session status", source: "builtin" },
  { name: "compact", description: "Compact the current context", input: { hint: "custom instructions" }, source: "builtin" },
  { name: "model", description: "Choose the active model", source: "builtin" },
  { name: "mcp", description: "Manage MCP servers", source: "builtin" },
  { name: "tree", description: "Show the session tree", source: "builtin" },
  { name: "export", description: "Export the current session", input: { hint: "path" }, source: "builtin" },
  { name: "share", description: "Share the current session", source: "builtin" },
  { name: "thinking", description: "Choose the reasoning level", source: "builtin" },
  { name: "fast", description: "Toggle fast mode", source: "builtin" },
  { name: "handoff", description: "Create a handoff prompt", input: { hint: "instructions" }, source: "builtin" },
  { name: "new", description: "Start a new session", source: "builtin" },
  { name: "resume", description: "Resume another session", source: "builtin" },
  { name: "branch", description: "Branch from an earlier message", source: "builtin" },
  { name: "export", description: "Export the transcript", source: "builtin" },
  { name: "copy", description: "Copy the last assistant response", source: "builtin" },
  { name: "clear", description: "Clear the visible transcript", source: "builtin" },
  { name: "reload", description: "Reload extensions and skills", source: "builtin" },
  { name: "theme", description: "Change the interface theme", source: "builtin" },
  { name: "login", description: "Authenticate a provider", source: "builtin" },
  { name: "logout", description: "Sign out of a provider", source: "builtin" },
  { name: "fixture-review", description: "Review the fixture workspace", source: "skill" },
  { name: "fixture-release", description: "Prepare fixture release notes", source: "custom" },
  ...(specialMessagesFixture ? [{ name: "fixture-special", description: "Emit semantic transcript and extension notification fixtures", source: "custom" }] : []),
];
const modelOptions = [
  { provider: "fixture", id: "fixture-model", name: "Fixture Model", reasoning: true, input: ["text", "image"], contextWindow: 4096 },
  { provider: "fixture", id: "fast-model", name: "Fast Fixture", reasoning: true, input: ["text"], contextWindow: 8192 },
  { provider: "alternate", id: "compact-model", name: "Compact Fixture", reasoning: false, input: ["text"], contextWindow: 2048 },
  { provider: "openrouter", id: "openai/gpt-4o", name: "GPT-4o via OpenRouter", reasoning: true, input: ["text", "image"], contextWindow: 128000 },
];
const openRouterProviders = [
  { id: "azure", name: "Azure" },
  { id: "openai", name: "OpenAI" },
];
const disabledOpenRouterProviders = new Set();
const fixtureOAuthAccounts = [
  {
    credentialId: 101,
    email: "alex@gradivus.dev",
    accountId: "acct-openai-primary",
    orgId: "org-gradivus",
    orgName: "Gradivus Labs",
    projectId: "project-gradivus-desktop",
    active: true,
    lockable: true,
  },
  {
    credentialId: 202,
    email: "riley@northstar.dev",
    accountId: "acct-openai-secondary",
    orgId: "org-northstar",
    orgName: "Northstar Studio",
    projectId: "project-northstar-app",
    active: false,
    lockable: true,
  },
];


function openRouterRouting(modelId) {
  return {
    modelId,
    providers: openRouterProviders.map(provider => ({
      ...provider,
      enabled: !disabledOpenRouterProviders.has(provider.id),
    })),
  };
}
let agentSettings = [
  {
    path: "personality",
    tab: "model",
    group: "Prompt behavior",
    label: "Personality",
    description: "Communication style rendered into the system prompt.",
    control: "select",
    value: "default",
    options: [
      { value: "default", label: "Default" },
      { value: "friendly", label: "Friendly" },
      { value: "pragmatic", label: "Pragmatic" },
      { value: "none", label: "None" },
    ],
    apply: "immediate",
  },
  {
    path: "images.autoResize",
    tab: "appearance",
    group: "Images",
    label: "Resize large images",
    description: "Resize oversized image inputs before sending them to the model.",
    control: "toggle",
    value: true,
    apply: "immediate",
  },
  {
    path: "tools.approvalMode",
    tab: "interaction",
    group: "Approvals",
    label: "Tool approval mode",
    description: "Choose which tool operations require confirmation.",
    control: "select",
    value: "yolo",
    options: [
      { value: "always-ask", label: "Always ask" },
      { value: "write", label: "Ask for writes" },
      { value: "yolo", label: "Auto-approve" },
    ],
    apply: "immediate",
  },
  {
    path: "compaction.strategy",
    tab: "context",
    group: "Compaction",
    label: "Compaction strategy",
    description: "How OMP reduces long context windows.",
    control: "select",
    value: "snapcompact",
    options: [
      { value: "context-full", label: "Context full" },
      { value: "handoff", label: "Handoff" },
      { value: "shake", label: "Shake" },
      { value: "snapcompact", label: "Snapcompact" },
      { value: "off", label: "Off" },
    ],
    apply: "immediate",
  },
  {
    path: "generate_image.enabled",
    tab: "tools",
    group: "Native media",
    label: "Generate image",
    description: "Expose the native image generation tool to the agent.",
    control: "toggle",
    value: true,
    apply: "next-session",
  },
  {
    path: "inspect_image.mode",
    tab: "tools",
    group: "Native media",
    label: "Inspect image",
    description: "Control when the delegated image inspection tool is exposed.",
    control: "select",
    value: "auto",
    options: [
      { value: "auto", label: "Auto" },
      { value: "on", label: "On" },
      { value: "off", label: "Off" },
    ],
    apply: "immediate",
  },
  {
    path: "task.maxConcurrency",
    tab: "tasks",
    group: "Delegation",
    label: "Maximum collaborators",
    description: "Maximum number of subagents that can run concurrently.",
    control: "select",
    value: 32,
    options: [
      { value: 4, label: "4" },
      { value: 8, label: "8" },
      { value: 16, label: "16" },
      { value: 32, label: "32" },
    ],
    apply: "immediate",
  },
];
const bundledAgentPrompts = {
  scout: {
    name: "scout",
    description: "Read-only codebase research and evidence gathering.",
    effectiveSource: "bundled",
    systemPrompt: "Inspect the requested surface and return compressed evidence.",
    apply: "next-spawn",
  },
  reviewer: {
    name: "reviewer",
    description: "Evidence-backed code review for correctness and security.",
    effectiveSource: "bundled",
    systemPrompt: "Review the change and report only evidence-backed findings.",
    apply: "next-spawn",
  },
};
let todoState = {
  phases: [{
    id: "phase-fixture-progress",
    name: "Fixture progress",
    tasks: [{
      id: "todo-fixture-exercise",
      content: "Exercise the desktop boundary",
      status: "completed",
    }],
  }],
  revision: 1,
};
let agentPrompts = Object.values(bundledAgentPrompts).map(agent => ({ ...agent }));

function updateAgentPrompt(agent, scope, systemPrompt) {
  const override = {
    systemPrompt,
    revision: Bun.SHA256.hash(`${agent.name}:${scope}:${systemPrompt}`, "hex"),
  };
  const updated = { ...agent, [scope]: override };
  const effective = updated.project ?? updated.user;
  return {
    ...updated,
    effectiveSource: updated.project ? "project" : updated.user ? "user" : "bundled",
    systemPrompt: effective?.systemPrompt ?? bundledAgentPrompts[agent.name]?.systemPrompt ?? agent.systemPrompt,
  };
}
const historyMessages = performanceMessages ?? specialMessages ?? timelineMessages ?? [
  { id: "fixture-welcome", role: "assistant", content: [{ type: "text", text: "Fixture ready. Choose a Work or Code action." }] },
  {
    id: "fixture-hidden-developer",
    role: "developer",
    content: [{ type: "text", text: "FIXTURE_HIDDEN_DEVELOPER_REMINDER" }],
  },
  {
    id: "fixture-hidden-custom",
    role: "custom",
    content: [{ type: "text", text: "FIXTURE_HIDDEN_CUSTOM_MESSAGE" }],
  },
  {
    id: "fixture-hidden-hook",
    role: "hookMessage",
    content: [{ type: "text", text: "FIXTURE_HIDDEN_HOOK_MESSAGE" }],
  },
];
const args = process.argv.slice(2);
const cwdIndex = args.indexOf("--cwd");
const cwd = cwdIndex >= 0 ? args[cwdIndex + 1] : process.cwd();
const resumeIndex = args.indexOf("--resume");
const sessionFile = resumeIndex >= 0 ? args[resumeIndex + 1] : path.join(cwd, ".gradivus-fixture.jsonl");
const sessionId = "fixture-session-0001";
const authStateFile = process.env.GRADIVUS_AUTH_FILE;
let authenticated = false;
let storedOAuthAccounts: typeof fixtureOAuthAccounts = [];
let lockedOAuthCredentialId: number | undefined;
let oauthAccountFailover = false;
if (authStateFile) {
  try {
    const serializedState = fs.readFileSync(authStateFile, "utf8").trim();
    if (serializedState === "authenticated") {
      authenticated = true;
      storedOAuthAccounts = fixtureOAuthAccounts.map(account => ({ ...account }));
    } else {
      const savedState = JSON.parse(serializedState);
      if (savedState?.authenticated === true) {
        authenticated = true;
        const savedCredentialIds = new Set(
          Array.isArray(savedState.accounts)
            ? savedState.accounts.flatMap(account => Number.isSafeInteger(account?.credentialId) ? [account.credentialId] : [])
            : fixtureOAuthAccounts.map(account => account.credentialId),
        );
        storedOAuthAccounts = fixtureOAuthAccounts
          .filter(account => savedCredentialIds.has(account.credentialId))
          .map(account => ({ ...account }));
        lockedOAuthCredentialId = Number.isSafeInteger(savedState.lockedCredentialId)
          && storedOAuthAccounts.some(account => account.credentialId === savedState.lockedCredentialId)
          ? savedState.lockedCredentialId
          : undefined;
        oauthAccountFailover = savedState.failover === true;
      }
    }
  } catch {}
}
let pendingAuth;
let pendingAgentPrompt;
let heldPrompt;
let queuedMessageCount = 0;
let delayedSelectPrompt;
let answerSequence = 0;
let model = modelOptions[0];
let thinkingLevel = "medium";
let fastModeEnabled = false;
let steeringMode = "all";
let followUpMode = "all";
let interruptMode = "immediate";
let autoCompactionEnabled = true;
let autoRetryEnabled = true;
let contextTokens = 128;
let isCompacting = false;
let retryInvocationCount = 0;
let planMode;
let planRevision = 1;
let planReview;
const basePlanBody = `# Fixture rollout

## Goal

Ship the Gradivus plan review safely.

## Execution

1. Update the trusted RPC boundary.
2. Review the desktop workflow.
3. Verify rollback behavior.

### Rollback

Restore the prior runtime and preserve the reviewed Markdown.

## Risks

- Context pressure
- Interrupted execution
`;
const fixturePlanBody = process.env.GRADIVUS_PLAN_LARGE === "1"
  ? `${basePlanBody}\n## Detailed checks\n\n${Array.from({ length: 5_500 }, (_, index) => `- Check ${index + 1}: retain source line anchors.`).join("\n")}\n`
  : basePlanBody;

function makePlanReview(content = fixturePlanBody, title = "FIXTURE ROLLOUT") {
  return {
    id: `plan-fixture-${planRevision}`,
    title,
    planFilePath: "local://fixture-rollout-plan.md",
    revision: `fixture-revision-${planRevision}`,
    status: "ready",
    phase: "ready",
    content,
    annotationState: { annotations: [], deletedSections: [], additionalFeedback: "" },
    suggestedSaveName: "FIXTURE_ROLLOUT_PLAN.md",
    contextUsage: { tokens: 31_000, contextWindow: 32_000, percent: 96.875 },
    keepContextDisabled: true,
    executionModels: [
      { role: "default", provider: "fixture", modelId: "fixture-default", label: "Fixture Default" },
      { role: "slow", provider: "fixture", modelId: "fixture-slow", label: "Fixture Slow", thinkingLevel: "high" },
    ],
    defaultExecutionRole: "default",
  };
}

function emitPlanReview(options = {}) {
  send({
    type: "plan_review_update",
    ...(planReview ? { planReview } : {}),
    ...options,
  });
}
const fixtureAgentCreatedAt = Date.now();
let fixtureAgents = [
  {
    id: "fixture-agent",
    displayName: "Fixture Verifier",
    kind: "sub",
    status: "parked",
    activity: "Waiting for a focused task",
    createdAt: fixtureAgentCreatedAt,
    lastActivity: fixtureAgentCreatedAt,
    transcriptAvailable: true,
    readOnly: false,
    agent: "Verifier",
    resolvedModel: "fixture-model",
    metrics: { tokens: 42, requests: 1, tools: 2, cost: 0.0042, durationMs: 840, contextTokens: 128, contextWindow: 4096 },
    progress: { lastIntent: "Verify the fixture boundary", recentOutput: ["verified"], resolvedModel: "fixture-model", tokens: 42 },
  },
  {
    id: "fixture-advisor",
    displayName: "Fixture Advisor",
    kind: "advisor",
    status: "idle",
    activity: "Transcript-only advisor",
    createdAt: fixtureAgentCreatedAt,
    lastActivity: fixtureAgentCreatedAt,
    transcriptAvailable: true,
    readOnly: true,
    agent: "Advisor",
    resolvedModel: "fixture-model",
    metrics: { tokens: 18, requests: 1, tools: 0, cost: 0.0018, durationMs: 220 },
    progress: undefined,
  },
];

function fixtureAgentHubSnapshot() {
  return { agents: fixtureAgents.map(agent => ({ ...agent, metrics: { ...agent.metrics }, progress: agent.progress ? { ...agent.progress } : undefined })) };
}

function persistOAuthState() {
  if (!authStateFile || !authenticated) return;
  fs.writeFileSync(authStateFile, `${JSON.stringify({
    authenticated,
    accounts: storedOAuthAccounts,
    lockedCredentialId: lockedOAuthCredentialId,
    failover: oauthAccountFailover,
  }, null, 2)}\n`, "utf8");
}

function oauthAccountsResponse() {
  const lockedCredentialId = storedOAuthAccounts.some(account => account.credentialId === lockedOAuthCredentialId)
    ? lockedOAuthCredentialId
    : undefined;
  return {
    providers: [{
      id: "openai-codex",
      name: "ChatGPT Plus/Pro",
      available: true,
      failover: oauthAccountFailover,
      ...(lockedCredentialId === undefined ? {} : { lockedCredentialId }),
      accounts: storedOAuthAccounts.map(account => ({
        ...account,
        locked: account.credentialId === lockedCredentialId,
      })),
    }],
  };
}



fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
if (!fs.existsSync(sessionFile)) fs.writeFileSync(sessionFile, "fixture\n", "utf8");

const grpcHost = process.env.OMP_GRPC_HOST;
const grpcPort = Number(process.env.OMP_GRPC_PORT);
const grpcToken = process.env.OMP_GRPC_TOKEN;
const grpcReadyFile = process.env.OMP_GRPC_READY_FILE;
if (!grpcHost || !Number.isInteger(grpcPort) || !grpcToken || !grpcReadyFile) {
  throw new Error("Fixture requires OMP gRPC bootstrap environment");
}
const grpcServer = await listenOmpGrpc({ host: grpcHost, port: grpcPort, token: grpcToken });
await writeOmpGrpcBootstrapFile(grpcReadyFile, grpcServer.bootstrap);
const connection = await grpcServer.accept();
let sendQueue = connection.send({
  kind: "ready",
  protocolVersion: OMP_GRPC_PROTOCOL_VERSION,
  maxMessageBytes: OMP_GRPC_MAX_MESSAGE_BYTES,
});
let registeredHostTools = [];
const pendingPaneBrowserPrompts = new Map();
let paneBrowserCallSequence = 0;
let lastGradivusPane;
let browserInventory = process.env.GRADIVUS_BROWSER_INVENTORY === "1"
  ? [{
      name: "fixture-omp-tab",
      state: "alive",
      browser: "relay",
      url: "https://agent.example.test/",
      title: "Fixture OMP automation",
      owners: ["fixture-subagent"],
      activeRunCount: 1,
      queuedRunCount: 1,
    }]
  : [];

function send(value) {
  const { type, ...payload } = value;
  const frame = type === "response"
    ? {
        kind: "response",
        id: typeof value.id === "string" ? value.id : undefined,
        command: value.command,
        success: value.success,
        data: value.data,
        error: value.error,
        code: value.code,
      }
    : { kind: "push", type, payload };
  sendQueue = sendQueue.then(() => connection.send(frame));
}

function sendAgentHubUpdate() {
  send({ type: "agent_hub_update", ...fixtureAgentHubSnapshot() });
}

setTimeout(() => send({ type: "available_commands_update", commands: availableCommands }), 10);
if (browserInventory.length > 0) {
  setTimeout(() => send({ type: "browser_inventory_update", inventory: browserInventory }), 15);
}

function handleFrame(frame) {
  if (frame.kind === "ready" || frame.kind === "response") return;
  const raw = frame.kind === "command"
    ? frame.command
    : frame.type === "request"
      ? frame
      : frame.kind === "request"
        ? frame.payload
        : frame;
  if (!raw || (!raw.command && !raw.type && !raw.id)) return;
  const command = {
    ...raw,
    ...(raw?.payload ?? {}),
    type: raw?.command ?? raw?.type,
  };
  const response = (data, success = true, id = command.id, commandName = command.type, error) => send({
    type: "response",
    id,
    command: commandName,
    success: Boolean(success),
    ...(success ? { data } : { error: error ?? "fixture command failed" }),
  });
  const conflictResponse = () => send({
    type: "response",
    id: command.id,
    command: command.type,
    success: false,
    error: "The subagent prompt changed since it was loaded. Reload before saving again.",
    code: "agent_prompt_conflict",
  });
  const promptResult = (promptCommand, agentInvoked, error) => send({
    type: "prompt_result",
    id: promptCommand.id,
    agentInvoked,
    ...(error ? { error } : {}),
  });
  const finishAgent = (
    promptCommand,
    finalText = "Fixture completed the requested work.",
    delay = 120,
    resultCommand = promptCommand,
  ) => {
    const answerId = `fixture-answer-${++answerSequence}`;
    const userId = `fixture-user-${answerSequence}`;
    const report = attachmentAnalyses.get(promptCommand)?.report ?? "";
    setTimeout(() => {
      send({ type: "agent_start" });
      send({ type: "message_start", message: { id: userId, role: "user", content: promptCommand.message } });
      send({ type: "todo_reminder", todos: [{ content: "Fixture progress", status: "completed" }] });
      send({ type: "message_start", message: { id: answerId, role: "assistant", content: [] } });
      send({ type: "message_update", message: { id: answerId, role: "assistant", content: [{ type: "thinking", thinking: "Inspecting the fixture boundary." }] } });
      send({ type: "tool_execution_start", toolCallId: `fixture-write-${answerSequence}`, toolName: "write", args: { path: "result.txt", content: "Fixture result\nGRADIVUS_READY" } });
      send({ type: "tool_execution_end", toolCallId: `fixture-write-${answerSequence}`, result: "GRADIVUS_READY", isError: false });
      send({ type: "message_end", message: { id: answerId, role: "assistant", content: [{ type: "thinking", thinking: "Validated the projected result." }, { type: "text", text: report ? `${finalText}\n\n${report}` : finalText }] } });
      send({ type: "agent_end", isTerminal: true, messages: [] });
      promptResult(resultCommand, true);
    }, delay);
  };
  const finishPlanProposal = promptCommand => {
    const sequence = ++answerSequence;
    const toolCallId = `fixture-plan-proposal-${sequence}`;
    setTimeout(() => {
      planMode = { enabled: true, planFilePath: "local://fixture-rollout-plan.md", workflow: "parallel" };
      send({ type: "config_update", planMode });
      send({ type: "agent_start" });
      send({ type: "message_start", message: { id: `fixture-plan-user-${sequence}`, role: "user", content: promptCommand.message } });
      send({ type: "tool_execution_start", toolCallId, toolName: "write", args: { path: "xd://propose", content: "Fixture rollout" } });
    }, 40);
    setTimeout(() => {
      send({
        type: "tool_execution_end",
        toolCallId,
        toolName: "write",
        result: {
          content: [{ type: "text", text: "Plan ready for review." }],
          details: {
            xdev: {
              tool: "propose",
              mode: "execute",
              inner: { planFilePath: "local://fixture-rollout-plan.md", title: "FIXTURE ROLLOUT", planExists: true },
            },
          },
        },
        isError: false,
      });
      planReview = makePlanReview();
      emitPlanReview();
      send({ type: "message_end", message: { id: `fixture-plan-answer-${sequence}`, role: "assistant", content: [{ type: "text", text: "The fixture plan is ready for review." }] } });
      send({ type: "agent_end", isTerminal: true, messages: [] });
      promptResult(promptCommand, true);
    }, 180);
  };

  const finishTimelineWave = (promptCommand) => {
    const sequence = ++answerSequence;
    const answerId = `fixture-wave-answer-${sequence}`;
    const userId = `fixture-wave-user-${sequence}`;
    const readId = `fixture-wave-read-${sequence}`;
    const writeId = `fixture-wave-write-${sequence}`;
    const editId = `fixture-wave-edit-${sequence}`;
    const imageChanges = [
      { id: `fixture-wave-image-a-${sequence}`, path: "preview-a.png" },
      { id: `fixture-wave-image-b-${sequence}`, path: "preview-b.png" },
    ];
    setTimeout(() => {
      send({ type: "agent_start" });
      send({ type: "message_start", message: { id: userId, role: "user", content: promptCommand.message } });
      send({ type: "tool_execution_start", toolCallId: readId, toolName: "read", args: { path: "notes.txt:1-4", count: 4 } });
    }, 40);
    setTimeout(() => send({
      type: "tool_execution_update",
      toolCallId: readId,
      partialResult: { details: { displayContent: { text: "alpha\nbeta\ngamma\ndelta", lineNumbers: [1, 2, 3, 4] } } },
    }), 140);
    setTimeout(() => send({
      type: "tool_execution_end",
      toolCallId: readId,
      result: { details: { displayContent: { text: "alpha\nbeta\ngamma\ndelta", lineNumbers: [1, 2, 3, 4] } } },
      isError: false,
    }), 240);
    setTimeout(() => send({
      type: "tool_execution_start",
      toolCallId: writeId,
      toolName: "write",
      args: { path: "activity.txt", content: "written line one\nwritten line two" },
    }), 320);
    setTimeout(() => send({ type: "tool_execution_end", toolCallId: writeId, result: "activity.txt written", isError: false }), 420);
    setTimeout(() => send({
      type: "tool_execution_start",
      toolCallId: editId,
      toolName: "edit",
      args: { input: "[notes.txt#ABCD]\n@@\n-alpha\n+alpha updated" },
    }), 500);
    setTimeout(() => send({
      type: "tool_execution_end",
      toolCallId: editId,
      result: "notes.txt edited",
      isError: false,
    }), 600);
    setTimeout(() => {
      for (const image of imageChanges) {
        send({
          type: "tool_execution_start",
          toolCallId: image.id,
          toolName: "write",
          args: { path: image.path, content: "binary image" },
        });
        fs.writeFileSync(path.join(process.cwd(), image.path), FIXTURE_PNG);
        send({
          type: "tool_execution_end",
          toolCallId: image.id,
          result: `${image.path} written`,
          isError: false,
        });
      }
    }, 640);
    setTimeout(() => {
      send({ type: "message_start", message: { id: answerId, role: "assistant", content: [] } });
      send({ type: "message_update", message: { id: answerId, role: "assistant", content: [{ type: "thinking", thinking: "Inspecting the activity stream." }] } });
    }, 680);
    setTimeout(() => send({
      type: "message_update",
      message: { id: answerId, role: "assistant", content: [{ type: "text", text: "Wave assistant update." }] },
    }), 780);
    setTimeout(() => {
      const report = attachmentAnalyses.get(promptCommand)?.report;
      send({ type: "message_end", message: { id: answerId, role: "assistant", content: [{ type: "text", text: report ? `Wave assistant complete ${sequence}.\n\n${report}` : `Wave assistant complete ${sequence}.` }] } });
      send({ type: "agent_end", isTerminal: true, messages: [] });
      promptResult(promptCommand, true);
    }, 880);
  };
  const finishEval = (promptCommand) => {
    const sequence = ++answerSequence;
    const toolCallId = `fixture-eval-${sequence}`;
    const tail = Array.from({ length: 40 }, (_, index) => `tail-${index + 1}`).join("\n");
    setTimeout(() => {
      send({ type: "agent_start" });
      send({ type: "message_start", message: { id: `fixture-eval-user-${sequence}`, role: "user", content: promptCommand.message } });
      send({
        type: "tool_execution_start",
        toolCallId,
        toolName: "eval",
        args: { language: "py", title: "fixture analysis", code: "value = 1\nprint(value)" },
      });
      send({
        type: "tool_execution_end",
        toolCallId,
        result: {
          details: {
            languages: ["python", "js"],
            cells: [
              {
                index: 0,
                title: "fixture analysis",
                language: "python",
                code: `value = 1\n${tail}`,
                output: `1\n${tail}`,
                status: "complete",
                durationMs: 125,
                statusEvents: [{ op: "phase", title: "fixture" }],
              },
              {
                index: 1,
                title: "fixture follow-up",
                language: "js",
                code: "console.log('done')",
                output: "done",
                status: "complete",
                durationMs: 75,
              },
            ],
            jsonOutputs: [{ marker: "FIXTURE_EVAL_JSON_DETAIL" }],
            images: [{ type: "image", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", mimeType: "image/png" }],
          },
        },
        isError: false,
      });
      send({ type: "message_end", message: { id: `fixture-eval-answer-${sequence}`, role: "assistant", content: [{ type: "text", text: "Eval fixture completed." }] } });
      send({ type: "agent_end", isTerminal: true, messages: [] });
      promptResult(promptCommand, true);
    }, 60);
  };
  const finishSpecialMessages = (promptCommand) => {
    const liveIrc = {
      role: "custom",
      customType: "irc:incoming",
      display: true,
      content: "<irc>LIVE_MODEL_IRC_INSTRUCTION_SENTINEL</irc>",
      details: {
        id: "fixture-irc-live-001",
        from: "Avery",
        message: "Live IRC message routed through one stable timeline card.",
      },
    };
    response({ accepted: true });
    send({
      type: "extension_ui_request",
      id: "fixture-special-info",
      method: "notify",
      title: "Fixture semantic transcript",
      message: "Semantic transcript fixture is ready.",
      notifyType: "info",
    });
    setTimeout(() => send({
      type: "notice",
      level: "warning",
      source: "fixture-special",
      message: "A semantic transcript warning is visible for verification.",
    }), 40);
    setTimeout(() => send({
      type: "extension_ui_request",
      id: "fixture-special-warning",
      method: "notify",
      title: "Fixture warning",
      message: "Dismiss this warning toast to continue the fixture journey.",
      notifyType: "warning",
    }), 100);
    setTimeout(() => send({ type: "irc_message", message: liveIrc }), 140);
    setTimeout(() => send({ type: "message_start", message: liveIrc }), 190);
    setTimeout(() => {
      const report = attachmentAnalyses.get(promptCommand)?.report;
      send({ type: "command_output", text: report ? `Fixture semantic command output complete.\n${report}` : "Fixture semantic command output complete." });
      promptResult(promptCommand, false);
    }, 300);
  };
  const finishHeld = (actualCommand, finalText = "Held turn completed after steering.") => {
    if (!heldPrompt) return;
    const resultCommand = heldPrompt;
    heldPrompt = undefined;
    finishAgent(actualCommand, finalText, 60, resultCommand);
  };

  if (command.type === "set_host_tools") {
    if (process.env.GRADIVUS_LEGACY_HOST_TOOLS === "1") {
      return response(undefined, false, command.id, command.type, "Unknown command: set_host_tools");
    }
    registeredHostTools = Array.isArray(command.tools) ? command.tools : [];
    return response({ toolNames: registeredHostTools.map(tool => tool.name) });
  }
  if (command.type === "close_browser_tab") {
    const tab = browserInventory.find(candidate => candidate.name === command.name);
    if (!tab) return response({ closed: false, inventory: browserInventory });
    const busy = tab.owners.length > 0 || tab.activeRunCount > 0 || tab.queuedRunCount > 0;
    if (busy && command.confirm !== true) {
      return response({ closed: false, requiresConfirmation: true, tab, inventory: browserInventory });
    }
    browserInventory = browserInventory.filter(candidate => candidate.name !== command.name);
    send({ type: "browser_inventory_update", inventory: browserInventory });
    return response({ closed: true, inventory: browserInventory });
  }
  if (command.type === "host_tool_result") {
    const pending = pendingPaneBrowserPrompts.get(command.id);
    if (!pending) return;
    pendingPaneBrowserPrompts.delete(command.id);
    send({
      type: "tool_execution_end",
      toolCallId: "fixture-gradivus-pane-tool",
      toolName: "gradivus_pane",
      result: command.result,
      isError: command.isError === true,
    });
    const text = command.result?.content?.find(item => item?.type === "text")?.text;
    let details;
    try { details = typeof text === "string" ? JSON.parse(text) : undefined; } catch {}
    const paneCount = Array.isArray(details?.panes) ? details.panes.length : 0;
    if (details?.panes?.[0]) lastGradivusPane = details.panes[0];
    const controls = Array.isArray(details?.interactive) ? details.interactive.length : 0;
    const title = typeof details?.title === "string" ? details.title : "unknown page";
    finishAgent(pending.prompt, pending.cancelled
      ? "Gradivus pane cancellation failed because a result arrived."
      : command.isError
        ? `Gradivus pane failed: ${String(text || "unknown error")}`
        : pending.mode === "observe"
          ? `Gradivus pane observed ${title} with ${controls} interactive controls.`
          : pending.mode === "control" || pending.mode === "click-navigation"
            ? "Gradivus pane control completed."
            : `Gradivus pane inventory contains ${paneCount} pane${paneCount === 1 ? "" : "s"}.`);
    return;
  }
  if (command.type === "host_tool_cancel") {
    pendingPaneBrowserPrompts.delete(command.targetId);
    return;
  }

  if (command.type === "get_state") return response({
    capabilities: { planReview: 1 },
    sessionId,
    sessionFile,
    model,
    thinkingLevel,
    isStreaming: Boolean(heldPrompt),
    isCompacting,
    steeringMode,
    followUpMode,
    interruptMode,
    autoCompactionEnabled,
    autoRetryEnabled,
    fastModeEnabled,
    fastModeActive: fastModeEnabled,
    ...(planMode ? { planMode } : {}),
    ...(planReview ? { planReview } : {}),
    contextUsage: { tokens: contextTokens, contextWindow: model.contextWindow },
    tokensPerSecond: 22,
    messageCount: historyMessages.length,
    queuedMessageCount,
    todoState,
    runtime: {
      pid: process.pid,
      uptimeMs: Math.round(process.uptime() * 1_000),
      residentMemoryBytes: process.memoryUsage().rss,
      heapUsedBytes: process.memoryUsage().heapUsed,
      heapTotalBytes: process.memoryUsage().heapTotal,
      externalMemoryBytes: process.memoryUsage().external,
    },
  });
  if (command.type === "set_plan_mode") {
    planMode = command.enabled
      ? { enabled: true, planFilePath: command.planFilePath ?? "local://fixture-rollout-plan.md", workflow: command.workflow ?? "parallel" }
      : undefined;
    if (!planMode) planReview = undefined;
    send({ type: "config_update", planMode });
    return response({ planMode });
  }
  if (command.type === "request_plan_review") {
    if (!planReview) {
      if (!planMode) return response(undefined, false, command.id, command.type, "Plan mode is not active.");
      planReview = makePlanReview();
    }
    emitPlanReview();
    return response({ planReview });
  }
  if (command.type === "update_plan_review") {
    if (!planReview || command.reviewId !== planReview.id) {
      send({ type: "response", id: command.id, command: command.type, success: false, error: "This plan review is no longer current.", code: "plan_review_stale" });
      return;
    }
    if (command.expectedRevision !== planReview.revision) {
      send({ type: "response", id: command.id, command: command.type, success: false, error: "The plan changed outside the review.", code: "plan_review_conflict" });
      return;
    }
    if (command.content !== planReview.content) planRevision += 1;
    planReview = {
      ...planReview,
      content: command.content,
      revision: `fixture-revision-${planRevision}`,
      annotationState: command.annotationState,
    };
    emitPlanReview();
    return response({ planReview });
  }
  if (command.type === "resolve_plan_review") {
    if (!planReview || command.reviewId !== planReview.id || command.expectedRevision !== planReview.revision) {
      send({ type: "response", id: command.id, command: command.type, success: false, error: "This plan review is stale.", code: "plan_review_stale" });
      return;
    }
    const decision = command.decision ?? {};
    const decisionFile = process.env.GRADIVUS_PLAN_DECISIONS_FILE;
    if (decisionFile) fs.appendFileSync(decisionFile, `${JSON.stringify(decision)}\n`, "utf8");
    if (decision.kind === "refine" && !String(decision.feedback ?? "").trim()) {
      planReview = { ...planReview, status: "awaiting_refinement", phase: "awaiting_refinement" };
      emitPlanReview();
      return response({ accepted: true, awaitingRefinement: true });
    }
    planReview = { ...planReview, status: "applying", phase: "accepted" };
    emitPlanReview();
    response({ accepted: true });
    if (decision.kind === "save") {
      fs.mkdirSync(path.dirname(decision.outputPath), { recursive: true });
      fs.writeFileSync(decision.outputPath, planReview.content, "utf8");
      planReview = undefined;
      planMode = undefined;
      emitPlanReview();
      send({ type: "config_update", planMode: undefined });
      return;
    }
    if (decision.kind === "refine") {
      const prior = planReview;
      setTimeout(() => {
        planRevision += 1;
        planReview = {
          ...makePlanReview(`${prior.content}\n## Refined\n\n${String(decision.feedback).trim()}\n`, "REFINED FIXTURE ROLLOUT"),
          id: `plan-fixture-${planRevision}`,
        };
        emitPlanReview();
      }, 180);
      return;
    }
    setTimeout(() => {
      planReview = undefined;
      planMode = undefined;
      emitPlanReview();
      send({ type: "config_update", planMode: undefined });
      send({ type: "agent_start" });
      send({ type: "message_start", message: { id: `fixture-plan-execution-${answerSequence + 1}`, role: "developer", content: "Execute the approved fixture plan." } });
      send({ type: "message_end", message: { id: `fixture-plan-execution-answer-${answerSequence + 1}`, role: "assistant", content: [{ type: "text", text: "Approved fixture execution started." }] } });
      send({ type: "agent_end", isTerminal: true, messages: [] });
    }, 180);
    return;
  }
  if (command.type === "get_available_commands") return response({ commands: availableCommands });
  if (command.type === "get_available_models") return response({ models: modelOptions });
  if (command.type === "get_openrouter_model_routing") return response(openRouterRouting(command.modelId));
  if (command.type === "set_openrouter_provider_enabled") {
    if (command.enabled) disabledOpenRouterProviders.delete(command.providerId);
    else disabledOpenRouterProviders.add(command.providerId);
    return response(openRouterRouting(command.modelId));
  }
  if (command.type === "get_login_providers") return response({
    providers: [
      { id: "openai-codex", name: "ChatGPT Plus/Pro", available: true, authenticated },
      { id: "google-gemini-cli", name: "Google Gemini CLI", available: true, authenticated: false },
      { id: "github-copilot", name: "GitHub Copilot", available: false, authenticated: false },
    ],
  });
  if (command.type === "get_oauth_accounts") return response(oauthAccountsResponse());
  if (command.type === "set_oauth_account_lock") {
    if (command.providerId !== "openai-codex") return response(undefined, false);
    if (command.credentialId === undefined) lockedOAuthCredentialId = undefined;
    else if (storedOAuthAccounts.some(account => account.credentialId === command.credentialId)) lockedOAuthCredentialId = command.credentialId;
    else return response(undefined, false);
    persistOAuthState();
    return response(oauthAccountsResponse());
  }
  if (command.type === "compact") {
    const before = contextTokens;
    isCompacting = true;
    send({ type: "auto_compaction_start", reason: "manual" });
    contextTokens = Math.max(16, Math.floor(contextTokens / 2));
    isCompacting = false;
    send({ type: "auto_compaction_end", success: true });
    return response({ tokensBefore: before, tokensAfter: contextTokens });
  }
  if (command.type === "handoff") {
    contextTokens = 0;
    return response({ savedPath: `${sessionFile}.handoff.md` });
  }
  if (command.type === "abort_retry") {
    send({ type: "auto_retry_end", success: false, attempt: 1, finalError: "Retry cancelled" });
    return response(undefined);
  }
  if (command.type === "get_session_stats") return response({
    sessionFile,
    sessionId,
    userMessages: 4,
    assistantMessages: 5,
    toolCalls: 3,
    toolResults: 3,
    totalMessages: 15,
    tokens: { input: 120, output: 80, reasoning: 20, cacheRead: 10, cacheWrite: 5, total: 235 },
    premiumRequests: 2,
    cost: 0.0123,
    contextUsage: { tokens: contextTokens, contextWindow: model.contextWindow, percentage: contextTokens / model.contextWindow * 100 },
  });
  if (command.type === "export_html") {
    fs.writeFileSync(command.outputPath, "<!doctype html><title>Fixture export</title>", "utf8");
    return response({ path: command.outputPath });
  }
  if (command.type === "set_todos") {
    if (command.expectedRevision !== todoState.revision) {
      return send({
        type: "response",
        id: command.id,
        command: command.type,
        success: false,
        error: "The todo list changed since it was loaded. Reload before saving again.",
        code: "todo_conflict",
      });
    }
    todoState = { phases: command.phases, revision: todoState.revision + 1 };
    send({ type: "todo_update", phases: todoState.phases, revision: todoState.revision });
    return response({ todoState });
  }
  if (command.type === "set_oauth_account_failover") {
    oauthAccountFailover = command.enabled === true;
    persistOAuthState();
    return response(oauthAccountsResponse());
  }
  if (command.type === "remove_oauth_account") {
    if (command.providerId !== "openai-codex") return response(undefined, false);
    const removedAccount = storedOAuthAccounts.find(account => account.credentialId === command.credentialId);
    if (!removedAccount) return response(undefined, false);
    storedOAuthAccounts = storedOAuthAccounts.filter(account => account.credentialId !== command.credentialId);
    if (lockedOAuthCredentialId === command.credentialId) lockedOAuthCredentialId = undefined;
    if (removedAccount.active && storedOAuthAccounts.length > 0) {
      storedOAuthAccounts = storedOAuthAccounts.map((account, index) => ({ ...account, active: index === 0 }));
    }
    persistOAuthState();
    return response(oauthAccountsResponse());
  }
  if (command.type === "get_settings") {
    const data = { settings: agentSettings };
    const requestNumber = ++settingsRequestCount;
    if (settingsResponseDelay > 0 && requestNumber > 1) {
      setTimeout(() => response(data), settingsResponseDelay);
      return;
    }
    return response(data);
  }
  if (command.type === "set_setting") {
    const index = agentSettings.findIndex(setting => setting.path === command.path);
    if (index < 0) return response(undefined, false);
    agentSettings = agentSettings.map((setting, settingIndex) => settingIndex === index ? { ...setting, value: command.value } : setting);
    return response({ setting: agentSettings[index] });
  }
  if (command.type === "get_agent_prompts") return response({ agents: agentPrompts });
  if (command.type === "save_agent_prompt") {
    const index = agentPrompts.findIndex(agent => agent.name === command.name);
    if (index < 0 || (command.scope !== "project" && command.scope !== "user") || !command.systemPrompt?.trim()) {
      return response(undefined, false);
    }
    const current = agentPrompts[index][command.scope];
    if ((current?.revision ?? null) !== (command.expectedRevision ?? null)) return conflictResponse();
    const agent = updateAgentPrompt(agentPrompts[index], command.scope, command.systemPrompt);
    agentPrompts = agentPrompts.map((candidate, agentIndex) => agentIndex === index ? agent : candidate);
    return response({ agent });
  }
  if (command.type === "reset_agent_prompt") {
    const index = agentPrompts.findIndex(agent => agent.name === command.name);
    if (index < 0 || (command.scope !== "project" && command.scope !== "user")) return response(undefined, false);
    const current = agentPrompts[index][command.scope];
    if (!current || current.revision !== command.expectedRevision) return conflictResponse();
    const agent = { ...agentPrompts[index] };
    delete agent[command.scope];
    const effective = agent.project ?? agent.user;
    const bundled = bundledAgentPrompts[agent.name];
    agent.effectiveSource = agent.project ? "project" : agent.user ? "user" : "bundled";
    agent.systemPrompt = effective?.systemPrompt ?? bundled?.systemPrompt ?? agent.systemPrompt;
    agentPrompts = agentPrompts.map((candidate, agentIndex) => agentIndex === index ? agent : candidate);
    return response({ agent });
  }
  if (command.type === "login" && command.providerId === "openai-codex") {
    const promptId = `fixture-auth-${Date.now()}`;
    pendingAuth = { command, promptId };
    send({ type: "extension_ui_request", id: promptId, method: "input", title: "Paste the authorization code", placeholder: "fixture-code", sensitive: true });
    return;
  }
  if (command.type === "extension_ui_response" && pendingAuth?.promptId === command.id) {
    authenticated = typeof command.value === "string" && command.value.length > 0;
    storedOAuthAccounts = authenticated ? fixtureOAuthAccounts.map(account => ({ ...account })) : [];
    lockedOAuthCredentialId = undefined;
    if (authenticated) persistOAuthState();
    response({ providerId: "openai-codex" }, true, pendingAuth.command.id, "login");
    pendingAuth = undefined;
    return;
  }
  if (command.type === "extension_ui_response" && pendingAgentPrompt?.promptId === command.id) {
    const promptCommand = pendingAgentPrompt.command;
    pendingAgentPrompt = undefined;
    response({ accepted: true }, true, promptCommand.id, "prompt");
    finishAgent(promptCommand);
    return;
  }
  if (command.type === "extension_ui_response" && delayedSelectPrompt && command.id === "fixture-delayed-select") {
    const promptCommand = delayedSelectPrompt;
    delayedSelectPrompt = undefined;
    const chosen = typeof command.value === "string" ? command.value : "";
    finishAgent(promptCommand, `Fixture continued after the replayed choice: ${chosen}.`, 120);
    return;
  }
  if (command.type === "logout" && command.providerId === "openai-codex") {
    authenticated = false;
    storedOAuthAccounts = [];
    lockedOAuthCredentialId = undefined;
    if (authStateFile) {
      try { fs.unlinkSync(authStateFile); } catch {}
    }
    return response({ providerId: "openai-codex" });
  }
  if (command.type === "get_file_diff") {
    return response({
      path: command.path,
      diff: "diff --git a/result.txt b/result.txt\nnew file mode 100644\n--- /dev/null\n+++ b/result.txt\n@@ -0,0 +1 @@\n+Fixture result\n",
      status: "added",
      additions: 1,
      deletions: 0,
      truncated: false,
    });
  }
  if (command.type === "get_messages_page") {
    const offset = command.cursor ? Number(command.cursor) : 0;
    let pageSize = Math.min(128, historyMessages.length - offset);
    let messages = historyMessages.slice(offset, offset + pageSize);
    while (messages.length > 1 && Buffer.byteLength(JSON.stringify({ messages }), "utf8") > 700 * 1024) {
      pageSize = Math.max(1, Math.floor(pageSize / 2));
      messages = historyMessages.slice(offset, offset + pageSize);
    }
    const nextOffset = offset + messages.length;
    return response({ messages, totalMessages: historyMessages.length, ...(nextOffset < historyMessages.length ? { nextCursor: String(nextOffset) } : {}) });
  }
  if (command.type === "get_messages") return response({ messages: historyMessages });
  if (command.type === "get_agent_hub") return response(fixtureAgentHubSnapshot());
  if (command.type === "get_agent_hub_messages") {
    const requestedFromByte = Number.isFinite(Number(command.fromByte)) ? Number(command.fromByte) : 0;
    const reset = requestedFromByte > 64;
    const fromByte = reset ? 0 : requestedFromByte;
    const messages = fromByte === 0 ? [{ role: "assistant", content: [{ type: "text", text: "Fixture collaborator transcript." }] }] : [];
    const result = { fromByte, nextByte: 64, reset, entries: [], messages };
    if (agentHubMessageDelayMs > 0) {
      setTimeout(() => response(result), agentHubMessageDelayMs);
      return;
    }
    return response(result);
  }
  if (command.type === "agent_hub_message") {
    const agent = fixtureAgents.find(candidate => candidate.id === command.agentId);
    if (!agent || agent.kind === "advisor" || agent.readOnly || agent.status === "aborted" || typeof command.message !== "string" || !command.message.trim()) return response(undefined, false);
    agent.status = "idle";
    agent.activity = `Received: ${command.message.trim()}`;
    agent.lastActivity = Date.now();
    response({ agentId: agent.id });
    sendAgentHubUpdate();
    return;
  }
  if (command.type === "agent_hub_kill") {
    const agent = fixtureAgents.find(candidate => candidate.id === command.agentId);
    if (!agent || agent.kind === "advisor" || agent.readOnly || agent.status === "aborted") return response(undefined, false);
    agent.status = "aborted";
    agent.activity = "Aborted by the desktop";
    agent.lastActivity = Date.now();
    response({ agentId: agent.id });
    sendAgentHubUpdate();
    return;
  }
  if (command.type === "agent_hub_clear") {
    const agent = fixtureAgents.find(candidate => candidate.id === command.agentId);
    if (!agent || agent.kind === "advisor" || agent.readOnly || (agent.status !== "parked" && agent.status !== "aborted")) return response(undefined, false);
    fixtureAgents = fixtureAgents.filter(candidate => candidate.id !== agent.id);
    response({ agentId: agent.id });
    sendAgentHubUpdate();
    return;
  }
  if (command.type === "agent_hub_revive") {
    const agent = fixtureAgents.find(candidate => candidate.id === command.agentId);
    if (!agent || agent.kind === "advisor" || agent.readOnly || agent.status !== "parked") return response(undefined, false);
    agent.status = "idle";
    agent.activity = "Revived and ready";
    agent.lastActivity = Date.now();
    response({ agentId: agent.id });
    sendAgentHubUpdate();
    return;
  }
  if (command.type === "get_subagents") return response({ subagents: [{ id: "fixture-agent", agent: "Verifier", status: "completed", task: "Verify the fixture boundary", progress: { resolvedModel: "fixture-model", tokens: 42, recentOutput: ["verified"] } }] });
  if (command.type === "set_subagent_subscription") return response({ level: command.level });
  if (command.type === "get_subagent_messages") return response({ reset: command.fromByte > 8, nextByte: 16, messages: [{ role: "assistant", content: [{ type: "text", text: "Fixture collaborator transcript." }] }] });
  if (command.type === "set_model") {
    model = modelOptions.find(candidate => candidate.provider === command.provider && candidate.id === command.modelId) ?? model;
    return response(model);
  }
  if (command.type === "set_thinking_level") { thinkingLevel = command.level; return response(); }
  if (command.type === "set_fast_mode") { fastModeEnabled = command.enabled; return response({ enabled: fastModeEnabled, active: fastModeEnabled }); }
  if (command.type === "set_steering_mode") { steeringMode = command.mode; return response(); }
  if (command.type === "set_follow_up_mode") { followUpMode = command.mode; return response(); }
  if (command.type === "set_interrupt_mode") { interruptMode = command.mode; return response(); }
  if (command.type === "set_auto_compaction") { autoCompactionEnabled = command.enabled; return response(); }
  if (command.type === "set_auto_retry") { autoRetryEnabled = command.enabled; return response(); }
  if (command.type === "set_session_name") return response({ accepted: true });
  if (command.type === "steer") {
    captureCommand(command, "steer");
    if (rejectNextSteer) {
      rejectNextSteer = false;
      response(undefined, false, command.id, "steer", "Fixture steer delivery failed.");
      return;
    }
    response({ accepted: true });
    if (heldPrompt) finishHeld(command);
    return;
  }
  if (command.type === "steer_queued") {
    captureCommand(command, "steer_queued");
    if (rejectNextSteerQueued) {
      rejectNextSteerQueued = false;
      return response(undefined, false, command.id, "steer_queued", "Fixture queued steering failed.");
    }
    if (queuedMessageCount === 0) return response(undefined, false, command.id, "steer_queued", "No queued message remains.");
    queuedMessageCount -= 1;
    response({ accepted: true });
    if (heldPrompt) finishHeld(command, "Held turn completed after promoting the queued message.");
    return;
  }
  if (command.type === "follow_up") {
    captureCommand(command, "follow_up");
    if (rejectNextFollowUp) {
      rejectNextFollowUp = false;
      response(undefined, false, command.id, "follow_up", "Fixture follow-up delivery failed.");
      return;
    }
    queuedMessageCount += 1;
    response({ accepted: true });
    return;
  }
  if (command.type === "prompt") {
    const analysis = captureCommand(command, "prompt");
    if (analysis.baseText.trim() === "/status") {
      response({ agentInvoked: false });
      promptResult(command, false);
      send({ type: "command_output", text: analysis.report ? `Fixture status: ready\n${analysis.report}` : "Fixture status: ready" });
      return;
    }
    if (/fixture plan review|\/fixture-plan/i.test(analysis.baseText)) {
      response({ accepted: true });
      finishPlanProposal(command);
      return;
    }
    if (specialMessagesFixture && /\/fixture-special|semantic transcript/i.test(analysis.baseText)) {
      finishSpecialMessages(command);
      return;
    }
    if (/queue delivery failed|fail queue|failure/i.test(analysis.baseText)) {
      response(undefined, false, command.id, "prompt", "Fixture queue delivery failed.");
      setTimeout(() => promptResult(command, false, { message: "Fixture queue delivery failed.", code: "QUEUE_DELIVERY_FAILED" }), 100);
      return;
    }
    if (analysis.baseText.trim() === "/retry") {
      const started = ++retryInvocationCount === 1;
      response({ agentInvoked: started });
      if (started) send({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 250 });
      return;
    }
    if (rejectNextPrompt === "immediate") {
      rejectNextPrompt = undefined;
      response(undefined, false, command.id, "prompt", "Fixture prompt delivery failed.");
      return;
    }
    if (rejectNextPrompt === "delayed") {
      rejectNextPrompt = undefined;
      response({ accepted: true });
      setTimeout(() => promptResult(command, false, { message: "Fixture prompt delivery failed.", code: "PROMPT_DELIVERY_FAILED" }), 700);
      return;
    }
    if (/fixture gradivus pane/i.test(analysis.baseText)) {
      response({ accepted: true });
      if (!registeredHostTools.some(tool => tool?.name === "gradivus_pane")) {
        finishAgent(command, "Gradivus pane host tool unavailable.");
        return;
      }
      const hostCallId = `fixture-gradivus-pane-call-${++paneBrowserCallSequence}`;
      const cancelled = /cancel/i.test(analysis.baseText);
      const mode = /password/i.test(analysis.baseText)
        ? "password"
        : /file input/i.test(analysis.baseText)
          ? "file"
          : /stale/i.test(analysis.baseText)
            ? "stale"
            : /click navigation/i.test(analysis.baseText)
              ? "click-navigation"
              : /invalid navigation/i.test(analysis.baseText)
                ? "invalid-navigation"
                : /control/i.test(analysis.baseText)
                  ? "control"
                  : /observe/i.test(analysis.baseText)
                    ? "observe"
                    : "list";
      const paneOperation = mode === "click-navigation" && lastGradivusPane
        ? {
            action: "act",
            op: "click",
            paneId: lastGradivusPane.paneId,
            documentEpoch: lastGradivusPane.documentEpoch,
            selector: "#fixture-navigate",
            timeoutMs: 5000,
          }
        : mode === "password" && lastGradivusPane
          ? {
              action: "act",
              op: "fill",
              paneId: lastGradivusPane.paneId,
              documentEpoch: lastGradivusPane.documentEpoch,
              selector: "#fixture-password",
              value: "must-not-be-filled",
              timeoutMs: 5000,
            }
          : mode === "file" && lastGradivusPane
            ? {
                action: "act",
                op: "fill",
                paneId: lastGradivusPane.paneId,
                documentEpoch: lastGradivusPane.documentEpoch,
                selector: "#fixture-file",
                value: "C:/must-not-upload.txt",
                timeoutMs: 5000,
              }
            : mode === "stale" && lastGradivusPane
              ? {
                  action: "observe",
                  paneId: lastGradivusPane.paneId,
                  documentEpoch: lastGradivusPane.documentEpoch + 1,
                  timeoutMs: 5000,
                }
              : mode === "invalid-navigation" && lastGradivusPane
                ? {
                    action: "navigate",
                    paneId: lastGradivusPane.paneId,
                    documentEpoch: lastGradivusPane.documentEpoch,
                    url: "file:///C:/forbidden",
                    timeoutMs: 5000,
                  }
                : undefined;
      const toolArguments = paneOperation ?? (mode === "control" && lastGradivusPane
        ? {
            action: "act",
            op: "click",
            paneId: lastGradivusPane.paneId,
            documentEpoch: lastGradivusPane.documentEpoch,
            selector: "#fixture-action",
            timeoutMs: 5000,
          }
        : mode === "observe" && lastGradivusPane
          ? {
              action: "observe",
              paneId: lastGradivusPane.paneId,
              documentEpoch: lastGradivusPane.documentEpoch,
              timeoutMs: 5000,
            }
          : { action: "list" });
      pendingPaneBrowserPrompts.set(hostCallId, { prompt: command, cancelled, mode });
      const dispatchHostCall = () => {
        send({
          type: "tool_execution_start",
          toolCallId: "fixture-gradivus-pane-tool",
          toolName: "gradivus_pane",
          args: toolArguments,
        });
        send({
          type: "host_tool_call",
          id: hostCallId,
          toolCallId: "fixture-gradivus-pane-tool",
          toolName: "gradivus_pane",
          arguments: toolArguments,
        });
        if (!cancelled) return;
        send({ type: "host_tool_cancel", id: `fixture-cancel-${hostCallId}`, targetId: hostCallId });
        setTimeout(() => {
          const pending = pendingPaneBrowserPrompts.get(hostCallId);
          if (!pending?.cancelled) return;
          pendingPaneBrowserPrompts.delete(hostCallId);
          send({
            type: "tool_execution_end",
            toolCallId: "fixture-gradivus-pane-tool",
            toolName: "gradivus_pane",
            result: { content: [{ type: "text", text: "Gradivus pane call cancelled." }] },
            isError: true,
          });
          finishAgent(pending.prompt, "Gradivus pane cancellation acknowledged.");
        }, 250);
      };
      if (mode === "list") dispatchHostCall();
      else setTimeout(dispatchHostCall, 250);
      return;
    }
    response({ accepted: true });
    if (/fixture eval|\/fixture-eval/i.test(analysis.baseText)) {
      finishEval(command);
      return;
    }
    if (/timeline wave|activity wave/i.test(analysis.baseText)) {
      finishTimelineWave(command);
      return;
    }
    if (/markdown copy/i.test(analysis.baseText)) {
      finishAgent(
        command,
        '## Copy proof\n\n```typescript\nconst rawTag = "<copy>";\n```\n\nRendered safely.',
      );
      return;
    }
    if (/locked account|provider error/i.test(analysis.baseText)) {
      setTimeout(() => promptResult(command, false, { message: "The selected OpenAI Codex account is locked.", code: "AUTH_ACCOUNT_LOCKED" }), 100);
      return;
    }
    if (/hold current turn|delayed turn/i.test(analysis.baseText)) {
      heldPrompt = command;
      send({ type: "agent_start" });
      send({ type: "message_start", message: { id: `fixture-hold-${++answerSequence}`, role: "user", content: command.message } });
      return;
    }
    if (/delayed error/i.test(analysis.baseText)) {
      setTimeout(() => promptResult(command, false, { message: "Fixture provider rejected the request.", code: "PROVIDER_UNAVAILABLE" }), 180);
      return;
    }
    if (/background delayed/i.test(analysis.baseText)) {
      finishAgent(command, "Background session completed.", 420);
      return;
    }
    if (/delayed select/i.test(analysis.baseText)) {
      delayedSelectPrompt = command;
      send({ type: "agent_start" });
      send({ type: "message_start", message: { id: `fixture-hold-${++answerSequence}`, role: "user", content: command.message } });
      setTimeout(() => send({
        type: "extension_ui_request",
        id: "fixture-delayed-select",
        method: "select",
        title: "Delayed fixture choice",
        message: "Pick the continuation for this turn.",
        options: ["Continue turn", "Abort turn"],
      }), extensionDelayMs);
      return;
    }
    finishAgent(command);
    return;
  }
  if (command.type === "prompt_result") return response({ agentInvoked: false });
  response(undefined, false);
}
for await (const frame of connection.frames) handleFrame(frame);
await sendQueue;
await connection.close();
await grpcServer.close();
