import { stripMarkdown } from "./runtime-api.js";

const PENDING_CONFIRMATION_TTL_MS = 2 * 60 * 1000;

export type BlueBubblesOutboundConfirmation = {
  messageId?: string;
  source: "webhook";
};

type PendingBlueBubblesOutboundConfirmation = {
  id: number;
  accountId: string;
  chatGuid?: string;
  chatIdentifier?: string;
  chatId?: number;
  messageId?: string;
  bodyNorm: string;
  createdAt: number;
  resolve: (value: BlueBubblesOutboundConfirmation | null) => void;
  timeout: ReturnType<typeof setTimeout>;
};

const pendingConfirmations: PendingBlueBubblesOutboundConfirmation[] = [];
let nextPendingConfirmationId = 0;

function trimOrUndefined(value?: string | null): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeBody(value: string): string {
  return stripMarkdown(value).replace(/\s+/g, " ").trim().toLowerCase();
}

function prunePendingConfirmations(now = Date.now()): void {
  const cutoff = now - PENDING_CONFIRMATION_TTL_MS;
  for (let i = pendingConfirmations.length - 1; i >= 0; i--) {
    if (pendingConfirmations[i].createdAt < cutoff) {
      const [entry] = pendingConfirmations.splice(i, 1);
      clearTimeout(entry.timeout);
      entry.resolve(null);
    }
  }
}

function removePendingConfirmation(id: number): PendingBlueBubblesOutboundConfirmation | null {
  const index = pendingConfirmations.findIndex((entry) => entry.id === id);
  if (index < 0) {
    return null;
  }
  const [entry] = pendingConfirmations.splice(index, 1);
  clearTimeout(entry.timeout);
  return entry ?? null;
}

function chatsMatch(
  pending: Pick<PendingBlueBubblesOutboundConfirmation, "chatGuid" | "chatIdentifier" | "chatId">,
  candidate: { chatGuid?: string; chatIdentifier?: string; chatId?: number },
): boolean {
  const pendingGuid = trimOrUndefined(pending.chatGuid);
  const candidateGuid = trimOrUndefined(candidate.chatGuid);
  if (pendingGuid && candidateGuid) {
    return pendingGuid === candidateGuid;
  }

  const pendingIdentifier = trimOrUndefined(pending.chatIdentifier);
  const candidateIdentifier = trimOrUndefined(candidate.chatIdentifier);
  if (pendingIdentifier && candidateIdentifier) {
    return pendingIdentifier === candidateIdentifier;
  }

  const pendingChatId = typeof pending.chatId === "number" ? pending.chatId : undefined;
  const candidateChatId = typeof candidate.chatId === "number" ? candidate.chatId : undefined;
  if (pendingChatId !== undefined && candidateChatId !== undefined) {
    return pendingChatId === candidateChatId;
  }

  return false;
}

export async function waitForBlueBubblesOutboundConfirmation(params: {
  accountId: string;
  chatGuid?: string;
  chatIdentifier?: string;
  chatId?: number;
  messageId?: string;
  body: string;
  timeoutMs: number;
}): Promise<BlueBubblesOutboundConfirmation | null> {
  prunePendingConfirmations();
  const normalizedTimeoutMs = Math.max(0, Math.floor(params.timeoutMs));
  const normalizedBody = normalizeBody(params.body);
  if (!normalizedBody || normalizedTimeoutMs === 0) {
    return null;
  }

  return await new Promise<BlueBubblesOutboundConfirmation | null>((resolve) => {
    nextPendingConfirmationId += 1;
    const pendingId = nextPendingConfirmationId;
    const timeout = setTimeout(() => {
      const entry = removePendingConfirmation(pendingId);
      entry?.resolve(null);
    }, normalizedTimeoutMs);

    pendingConfirmations.push({
      id: pendingId,
      accountId: params.accountId,
      chatGuid: trimOrUndefined(params.chatGuid),
      chatIdentifier: trimOrUndefined(params.chatIdentifier),
      chatId: typeof params.chatId === "number" ? params.chatId : undefined,
      messageId: trimOrUndefined(params.messageId),
      bodyNorm: normalizedBody,
      createdAt: Date.now(),
      resolve,
      timeout,
    });
  });
}

export function confirmBlueBubblesOutboundMessage(params: {
  accountId: string;
  chatGuid?: string;
  chatIdentifier?: string;
  chatId?: number;
  messageId?: string;
  body: string;
}): boolean {
  prunePendingConfirmations();
  const normalizedBody = normalizeBody(params.body);
  const normalizedMessageId = trimOrUndefined(params.messageId);
  for (let i = 0; i < pendingConfirmations.length; i++) {
    const pending = pendingConfirmations[i];
    if (pending.accountId !== params.accountId) {
      continue;
    }
    if (!chatsMatch(pending, params)) {
      continue;
    }
    if (normalizedMessageId && pending.messageId && normalizedMessageId === pending.messageId) {
      pendingConfirmations.splice(i, 1);
      clearTimeout(pending.timeout);
      pending.resolve({ messageId: normalizedMessageId, source: "webhook" });
      return true;
    }
    if (!normalizedBody || pending.bodyNorm !== normalizedBody) {
      continue;
    }
    pendingConfirmations.splice(i, 1);
    clearTimeout(pending.timeout);
    pending.resolve({ messageId: normalizedMessageId, source: "webhook" });
    return true;
  }
  return false;
}

export function clearBlueBubblesOutboundConfirmations(): void {
  while (pendingConfirmations.length > 0) {
    const entry = pendingConfirmations.pop();
    if (!entry) {
      continue;
    }
    clearTimeout(entry.timeout);
    entry.resolve(null);
  }
}
