import {
  INTERNAL_RUNTIME_CONTEXT_BEGIN,
  INTERNAL_RUNTIME_CONTEXT_END,
} from "../agents/internal-runtime-context.js";
import { sanitizeUserFacingText } from "../agents/pi-embedded-helpers/errors.js";
import { truncateUtf16Safe } from "../utils.js";
import type { TaskRecord } from "./task-registry.types.js";

const ACTIVE_TASK_STATUSES = new Set(["queued", "running"]);
const FAILURE_TASK_STATUSES = new Set(["failed", "timed_out", "lost"]);
export const TASK_STATUS_RECENT_WINDOW_MS = 5 * 60_000;
export const TASK_STATUS_TITLE_MAX_CHARS = 80;
export const TASK_STATUS_DETAIL_MAX_CHARS = 120;
export const TASK_STATUS_OPERATOR_STEP_MAX_CHARS = 180;

const TASK_OPERATOR_PATH_PATTERNS = [
  /https?:\/\/[^\s"'`<>()]+/i,
  /(?:~|\/(?:Users|tmp|var|private|home|opt|Volumes|mnt|etc|srv|usr|Applications)\b)[^\s"'`<>()]*/u,
  /[A-Za-z]:\\[^\s"'`<>()]+/u,
];

function isActiveTask(task: TaskRecord): boolean {
  return ACTIVE_TASK_STATUSES.has(task.status);
}

function isFailureTask(task: TaskRecord): boolean {
  return FAILURE_TASK_STATUSES.has(task.status);
}

function resolveTaskReferenceAt(task: TaskRecord): number {
  if (isActiveTask(task)) {
    return task.lastEventAt ?? task.startedAt ?? task.createdAt;
  }
  return task.endedAt ?? task.lastEventAt ?? task.startedAt ?? task.createdAt;
}

function isExpiredTask(task: TaskRecord, now: number): boolean {
  return typeof task.cleanupAfter === "number" && task.cleanupAfter <= now;
}

function isRecentTerminalTask(task: TaskRecord, now: number): boolean {
  if (isActiveTask(task)) {
    return false;
  }
  return now - resolveTaskReferenceAt(task) <= TASK_STATUS_RECENT_WINDOW_MS;
}

function truncateTaskStatusText(value: string, maxChars: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= maxChars) {
    return trimmed;
  }
  return `${truncateUtf16Safe(trimmed, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function formatTaskShortIdText(value: string | undefined, maxChars = 8): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  return truncateTaskStatusText(trimmed, maxChars);
}

function stripInlineLeakedInternalContext(value: string): string {
  const beginIndex = value.indexOf(INTERNAL_RUNTIME_CONTEXT_BEGIN);
  if (
    beginIndex !== -1 &&
    (value.includes(INTERNAL_RUNTIME_CONTEXT_END) ||
      value.includes("OpenClaw runtime context (internal):") ||
      value.includes("[Internal task completion event]"))
  ) {
    return value.slice(0, beginIndex);
  }
  const legacyHeaderIndex = value.indexOf("OpenClaw runtime context (internal):");
  if (
    legacyHeaderIndex !== -1 &&
    (value.includes("Keep internal details private.") ||
      value.includes("[Internal task completion event]"))
  ) {
    return value.slice(0, legacyHeaderIndex);
  }
  return value;
}

function sanitizeTaskStatusValue(value: unknown, errorContext: boolean): unknown {
  if (typeof value === "string") {
    const sanitized = sanitizeUserFacingText(stripInlineLeakedInternalContext(value), {
      errorContext,
    })
      .replace(/\s+/g, " ")
      .trim();
    return sanitized || undefined;
  }
  if (Array.isArray(value)) {
    const next = value
      .map((entry) => sanitizeTaskStatusValue(entry, errorContext))
      .filter((entry) => entry !== undefined);
    return next.length > 0 ? next : undefined;
  }
  if (value && typeof value === "object") {
    const nextEntries = Object.entries(value as Record<string, unknown>)
      .map(([key, entry]) => [key, sanitizeTaskStatusValue(entry, errorContext)] as const)
      .filter(([, entry]) => entry !== undefined);
    if (nextEntries.length === 0) {
      return undefined;
    }
    return Object.fromEntries(nextEntries);
  }
  return value;
}

export function sanitizeTaskStatusText(
  value: unknown,
  opts?: { errorContext?: boolean; maxChars?: number },
): string {
  const errorContext = opts?.errorContext ?? false;
  const sanitizedValue = sanitizeTaskStatusValue(value, errorContext);
  const raw =
    typeof sanitizedValue === "string"
      ? sanitizedValue
      : sanitizedValue == null
        ? ""
        : (JSON.stringify(sanitizedValue) ?? "");
  const sanitized = raw.replace(/\s+/g, " ").trim();
  if (!sanitized) {
    return "";
  }
  if (typeof opts?.maxChars === "number") {
    return truncateTaskStatusText(sanitized, opts.maxChars);
  }
  return sanitized;
}

export function formatTaskStatusTitleText(value: unknown, fallback = "Background task"): string {
  return sanitizeTaskStatusText(value, { maxChars: TASK_STATUS_TITLE_MAX_CHARS }) || fallback;
}

export function formatTaskStatusTitle(task: TaskRecord): string {
  return formatTaskStatusTitleText(task.label?.trim() || task.task.trim());
}

export function formatTaskStatusDetail(task: TaskRecord): string | undefined {
  if (task.status === "running" || task.status === "queued") {
    return (
      sanitizeTaskStatusText(task.progressSummary, { maxChars: TASK_STATUS_DETAIL_MAX_CHARS }) ||
      undefined
    );
  }

  const sanitizedError = sanitizeTaskStatusText(task.error, {
    errorContext: true,
    maxChars: TASK_STATUS_DETAIL_MAX_CHARS,
  });
  if (sanitizedError) {
    return sanitizedError;
  }

  return (
    sanitizeTaskStatusText(task.terminalSummary, {
      errorContext: true,
      maxChars: TASK_STATUS_DETAIL_MAX_CHARS,
    }) || undefined
  );
}

function extractTaskArtifactFromText(value: string | undefined): string | undefined {
  const text = sanitizeTaskStatusText(value, { errorContext: true });
  if (!text) {
    return undefined;
  }
  for (const pattern of TASK_OPERATOR_PATH_PATTERNS) {
    const match = text.match(pattern);
    const candidate = match?.[0]?.trim().replace(/[.,;:!?]+$/, "");
    if (candidate) {
      return candidate;
    }
  }
  return undefined;
}

function resolveBlockedTaskNextAction(task: TaskRecord): string {
  const context = [
    sanitizeTaskStatusText(task.terminalSummary, { errorContext: true }),
    sanitizeTaskStatusText(task.error, { errorContext: true }),
    sanitizeTaskStatusText(task.progressSummary),
  ]
    .filter(Boolean)
    .join(" ");
  if (/\b(log(?: ?)?in|sign(?:ed)? ?in|auth|credential|oauth|token)\b/i.test(context)) {
    return "I need a fresh login or credential before I can continue";
  }
  if (
    /\b(approval|approve|authorized?|authorization|permission|writable session|apply_patch)\b/i.test(
      context,
    )
  ) {
    return "I need approval before I can continue";
  }
  return "I need follow-up to continue";
}

export function formatTaskShortId(task: TaskRecord, maxChars = 8): string | undefined {
  return formatTaskShortIdText(task.taskId, maxChars);
}

export function formatTaskOperatorStep(task: TaskRecord): string | undefined {
  if (task.status === "queued" || task.status === "running") {
    const detail = sanitizeTaskStatusText(task.progressSummary, {
      maxChars: TASK_STATUS_OPERATOR_STEP_MAX_CHARS,
    });
    if (detail) {
      return detail;
    }
    return task.status === "queued" ? "Waiting to start." : "Started.";
  }
  return undefined;
}

export function formatTaskOperatorOutcome(task: TaskRecord): string | undefined {
  const error = sanitizeTaskStatusText(task.error, {
    errorContext: true,
    maxChars: TASK_STATUS_OPERATOR_STEP_MAX_CHARS,
  });
  if (error) {
    return error;
  }
  return (
    sanitizeTaskStatusText(task.terminalSummary, {
      errorContext: true,
      maxChars: TASK_STATUS_OPERATOR_STEP_MAX_CHARS,
    }) || undefined
  );
}

export function extractTaskArtifactHint(task: TaskRecord): string | undefined {
  return (
    extractTaskArtifactFromText(task.terminalSummary) ??
    extractTaskArtifactFromText(task.progressSummary) ??
    extractTaskArtifactFromText(task.error)
  );
}

export function formatTaskDeliverySummary(task: TaskRecord): string | undefined {
  switch (task.deliveryStatus) {
    case "failed":
      return "chat delivery failed";
    case "session_queued":
      return "saved for the local session";
    case "parent_missing":
      return "original requester unavailable";
    default:
      return undefined;
  }
}

export function formatTaskNextAction(task: TaskRecord): string | undefined {
  if (task.status === "queued" || task.status === "running") {
    return "I'll keep working and report back here";
  }
  if (task.status === "succeeded") {
    if (task.terminalOutcome === "blocked") {
      return resolveBlockedTaskNextAction(task);
    }
    if (task.deliveryStatus === "failed") {
      return "The work finished, but sending the result back to chat failed";
    }
    if (task.deliveryStatus === "session_queued") {
      return "The result was saved for the local session because direct chat delivery was not available";
    }
    return undefined;
  }
  if (task.status === "timed_out") {
    return "I hit the time limit before finishing";
  }
  if (task.status === "cancelled") {
    return "The work was stopped before it finished";
  }
  if (task.status === "lost") {
    return "The backing runtime disappeared, so this needs a retry";
  }
  if (task.deliveryStatus === "failed") {
    return "The work stopped, and sending the details back to chat also failed";
  }
  if (task.deliveryStatus === "session_queued") {
    return "The work stopped, and the details were saved for the local session";
  }
  return "The work stopped before finishing";
}

export type TaskStatusSnapshot = {
  latest?: TaskRecord;
  focus?: TaskRecord;
  visible: TaskRecord[];
  active: TaskRecord[];
  recentTerminal: TaskRecord[];
  activeCount: number;
  totalCount: number;
  recentFailureCount: number;
};

export function buildTaskStatusSnapshot(
  tasks: TaskRecord[],
  opts?: { now?: number },
): TaskStatusSnapshot {
  const now = opts?.now ?? Date.now();
  const visibleCandidates = tasks.filter((task) => !isExpiredTask(task, now));
  const active = visibleCandidates.filter(isActiveTask);
  const recentTerminal = visibleCandidates.filter((task) => isRecentTerminalTask(task, now));
  const visible = active.length > 0 ? [...active, ...recentTerminal] : recentTerminal;
  const focus =
    active[0] ?? recentTerminal.find((task) => isFailureTask(task)) ?? recentTerminal[0];
  return {
    latest: active[0] ?? recentTerminal[0],
    focus,
    visible,
    active,
    recentTerminal,
    activeCount: active.length,
    totalCount: visible.length,
    recentFailureCount: recentTerminal.filter(isFailureTask).length,
  };
}
