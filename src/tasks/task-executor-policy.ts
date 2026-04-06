import type { TaskEventRecord, TaskRecord, TaskStatus } from "./task-registry.types.js";
import {
  extractTaskArtifactHint,
  formatTaskNextAction,
  formatTaskOperatorOutcome,
  formatTaskOperatorStep,
  formatTaskShortId,
  formatTaskStatusTitleText,
  sanitizeTaskStatusText,
} from "./task-status.js";

export function isTerminalTaskStatus(status: TaskStatus): boolean {
  return (
    status === "succeeded" ||
    status === "failed" ||
    status === "timed_out" ||
    status === "cancelled" ||
    status === "lost"
  );
}

function resolveTaskDisplayTitle(task: TaskRecord): string {
  return formatTaskStatusTitleText(
    task.label?.trim() ||
      (task.runtime === "acp"
        ? "ACP background task"
        : task.runtime === "subagent"
          ? "Subagent task"
          : task.task.trim() || "Background task"),
  );
}

function resolveTaskRunLabel(task: TaskRecord): string | undefined {
  return task.runId ? `run ${task.runId.slice(0, 8)}` : undefined;
}

function resolveTaskLabel(task: TaskRecord): string {
  const shortId = formatTaskShortId(task);
  const runLabel = resolveTaskRunLabel(task);
  if (!shortId && !runLabel) {
    return resolveTaskDisplayTitle(task);
  }
  const meta = [shortId ? `task ${shortId}` : undefined, runLabel].filter(Boolean).join(", ");
  return meta ? `${resolveTaskDisplayTitle(task)} (${meta})` : resolveTaskDisplayTitle(task);
}

function ensureSentence(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

function joinSentences(parts: Array<string | null | undefined>): string {
  return parts
    .map((entry) => ensureSentence(entry ?? undefined))
    .filter((entry): entry is string => Boolean(entry))
    .join(" ");
}

export function formatTaskTerminalMessage(task: TaskRecord): string {
  const label = resolveTaskLabel(task);
  const outcome = formatTaskOperatorOutcome(task);
  const artifact = extractTaskArtifactHint(task);
  const nextAction = formatTaskNextAction(task);
  if (task.status === "succeeded") {
    if (task.terminalOutcome === "blocked") {
      return joinSentences([
        `Background task blocked: ${label}`,
        outcome,
        artifact ? `Artifact: ${artifact}` : undefined,
        nextAction ? `Next: ${nextAction}` : undefined,
      ]);
    }
    return joinSentences([
      `Background task done: ${label}`,
      outcome,
      artifact ? `Artifact: ${artifact}` : undefined,
      nextAction ? `Next: ${nextAction}` : undefined,
    ]);
  }
  if (task.status === "timed_out") {
    return joinSentences([
      `Background task timed out: ${label}`,
      outcome,
      artifact ? `Artifact: ${artifact}` : undefined,
      nextAction ? `Next: ${nextAction}` : undefined,
    ]);
  }
  if (task.status === "lost") {
    return joinSentences([
      `Background task lost: ${label}`,
      outcome || "Backing session disappeared",
      artifact ? `Artifact: ${artifact}` : undefined,
      nextAction ? `Next: ${nextAction}` : undefined,
    ]);
  }
  if (task.status === "cancelled") {
    return joinSentences([
      `Background task cancelled: ${label}`,
      outcome,
      artifact ? `Artifact: ${artifact}` : undefined,
      nextAction ? `Next: ${nextAction}` : undefined,
    ]);
  }
  return joinSentences([
    `Background task failed: ${label}`,
    outcome,
    artifact ? `Artifact: ${artifact}` : undefined,
    nextAction ? `Next: ${nextAction}` : undefined,
  ]);
}

export function formatTaskBlockedFollowupMessage(task: TaskRecord): string | null {
  if (task.status !== "succeeded" || task.terminalOutcome !== "blocked") {
    return null;
  }
  const label = resolveTaskLabel(task);
  const outcome =
    formatTaskOperatorOutcome(task) ||
    sanitizeTaskStatusText(task.terminalSummary, { errorContext: true }) ||
    "Task is blocked and needs follow-up.";
  const artifact = extractTaskArtifactHint(task);
  const nextAction = formatTaskNextAction(task);
  return joinSentences([
    `Task needs follow-up: ${label}`,
    outcome,
    artifact ? `Artifact: ${artifact}` : undefined,
    nextAction ? `Next: ${nextAction}` : undefined,
  ]);
}

export function formatTaskStateChangeMessage(
  task: TaskRecord,
  event: TaskEventRecord,
): string | null {
  const label = resolveTaskLabel(task);
  if (event.kind === "running") {
    const step = formatTaskOperatorStep({
      ...task,
      status: task.status === "queued" ? "running" : task.status,
      progressSummary: task.progressSummary ?? "Started.",
    });
    const nextAction = formatTaskNextAction({
      ...task,
      status: task.status === "queued" ? "running" : task.status,
    });
    return joinSentences([
      `Background task update: ${label}`,
      step ? `Current step: ${step}` : undefined,
      nextAction ? `Next: ${nextAction}` : undefined,
    ]);
  }
  if (event.kind === "progress") {
    const summary = sanitizeTaskStatusText(event.summary, {
      maxChars: 180,
    });
    const artifact =
      summary && task.progressSummary !== event.summary
        ? extractTaskArtifactHint({ ...task, progressSummary: summary })
        : extractTaskArtifactHint(task);
    const nextAction = formatTaskNextAction(task);
    return summary
      ? joinSentences([
          `Background task update: ${label}`,
          `Current step: ${summary}`,
          artifact ? `Artifact: ${artifact}` : undefined,
          nextAction ? `Next: ${nextAction}` : undefined,
        ])
      : null;
  }
  return null;
}

export function shouldAutoDeliverTaskTerminalUpdate(task: TaskRecord): boolean {
  if (task.notifyPolicy === "silent") {
    return false;
  }
  if (task.runtime === "subagent" && task.status !== "cancelled") {
    return false;
  }
  if (!isTerminalTaskStatus(task.status)) {
    return false;
  }
  return task.deliveryStatus === "pending";
}

export function shouldAutoDeliverTaskStateChange(task: TaskRecord): boolean {
  return (
    task.notifyPolicy === "state_changes" &&
    task.deliveryStatus === "pending" &&
    !isTerminalTaskStatus(task.status)
  );
}

export function shouldSuppressDuplicateTerminalDelivery(params: {
  task: TaskRecord;
  preferredTaskId?: string;
}): boolean {
  if (params.task.runtime !== "acp" || !params.task.runId?.trim()) {
    return false;
  }
  return Boolean(params.preferredTaskId && params.preferredTaskId !== params.task.taskId);
}
