import crypto from "node:crypto";
import { resolveBlueBubblesAccount } from "./accounts.js";
import { fetchBlueBubblesHistory } from "./history.js";
import { waitForBlueBubblesOutboundConfirmation } from "./outbound-confirmation.js";
import {
  getCachedBlueBubblesPrivateApiStatus,
  isBlueBubblesPrivateApiStatusEnabled,
} from "./probe.js";
import type { OpenClawConfig } from "./runtime-api.js";
import { stripMarkdown } from "./runtime-api.js";
import { warnBlueBubbles } from "./runtime.js";
import { normalizeSecretInputString } from "./secret-input.js";
import { extractBlueBubblesMessageId, resolveBlueBubblesSendTarget } from "./send-helpers.js";
import { extractHandleFromChatGuid, normalizeBlueBubblesHandle } from "./targets.js";
import {
  blueBubblesFetchWithTimeout,
  buildBlueBubblesApiUrl,
  type BlueBubblesSendTarget,
} from "./types.js";

export type BlueBubblesSendOpts = {
  serverUrl?: string;
  password?: string;
  accountId?: string;
  timeoutMs?: number;
  cfg?: OpenClawConfig;
  /** Message GUID to reply to (reply threading) */
  replyToMessageGuid?: string;
  /** Part index for reply (default: 0) */
  replyToPartIndex?: number;
  /** Effect ID or short name for message effects (e.g., "slam", "balloons") */
  effectId?: string;
  /** Wait for webhook or history confirmation before treating the send as delivered. */
  deliveryConfirmationTimeoutMs?: number;
  /** Retries to attempt when BlueBubbles accepts a send but no delivery confirmation arrives. */
  deliveryRetryCount?: number;
  /** Base delay between retry attempts; exponential backoff is applied from this value. */
  deliveryRetryBaseDelayMs?: number;
};

export type BlueBubblesSendResult = {
  messageId: string;
};

/** Maps short effect names to full Apple effect IDs */
const EFFECT_MAP: Record<string, string> = {
  // Bubble effects
  slam: "com.apple.MobileSMS.expressivesend.impact",
  loud: "com.apple.MobileSMS.expressivesend.loud",
  gentle: "com.apple.MobileSMS.expressivesend.gentle",
  invisible: "com.apple.MobileSMS.expressivesend.invisibleink",
  "invisible-ink": "com.apple.MobileSMS.expressivesend.invisibleink",
  "invisible ink": "com.apple.MobileSMS.expressivesend.invisibleink",
  invisibleink: "com.apple.MobileSMS.expressivesend.invisibleink",
  // Screen effects
  echo: "com.apple.messages.effect.CKEchoEffect",
  spotlight: "com.apple.messages.effect.CKSpotlightEffect",
  balloons: "com.apple.messages.effect.CKHappyBirthdayEffect",
  confetti: "com.apple.messages.effect.CKConfettiEffect",
  love: "com.apple.messages.effect.CKHeartEffect",
  heart: "com.apple.messages.effect.CKHeartEffect",
  hearts: "com.apple.messages.effect.CKHeartEffect",
  lasers: "com.apple.messages.effect.CKLasersEffect",
  fireworks: "com.apple.messages.effect.CKFireworksEffect",
  celebration: "com.apple.messages.effect.CKSparklesEffect",
};

function resolveEffectId(raw?: string): string | undefined {
  if (!raw) {
    return undefined;
  }
  const trimmed = raw.trim().toLowerCase();
  if (EFFECT_MAP[trimmed]) {
    return EFFECT_MAP[trimmed];
  }
  const normalized = trimmed.replace(/[\s_]+/g, "-");
  if (EFFECT_MAP[normalized]) {
    return EFFECT_MAP[normalized];
  }
  const compact = trimmed.replace(/[\s_-]+/g, "");
  if (EFFECT_MAP[compact]) {
    return EFFECT_MAP[compact];
  }
  return raw;
}

type PrivateApiDecision = {
  canUsePrivateApi: boolean;
  throwEffectDisabledError: boolean;
  warningMessage?: string;
};

function resolvePrivateApiDecision(params: {
  privateApiStatus: boolean | null;
  wantsReplyThread: boolean;
  wantsEffect: boolean;
}): PrivateApiDecision {
  const { privateApiStatus, wantsReplyThread, wantsEffect } = params;
  const needsPrivateApi = wantsReplyThread || wantsEffect;
  const canUsePrivateApi =
    needsPrivateApi && isBlueBubblesPrivateApiStatusEnabled(privateApiStatus);
  const throwEffectDisabledError = wantsEffect && privateApiStatus === false;
  if (!needsPrivateApi || privateApiStatus !== null) {
    return { canUsePrivateApi, throwEffectDisabledError };
  }
  const requested = [
    wantsReplyThread ? "reply threading" : null,
    wantsEffect ? "message effects" : null,
  ]
    .filter(Boolean)
    .join(" + ");
  return {
    canUsePrivateApi,
    throwEffectDisabledError,
    warningMessage: `Private API status unknown; sending without ${requested}. Run a status probe to restore private-api features.`,
  };
}

const DEFAULT_DELIVERY_CONFIRMATION_TIMEOUT_MS = 8_000;
const DEFAULT_DELIVERY_RETRY_COUNT = 1;
const DEFAULT_DELIVERY_RETRY_BASE_DELAY_MS = 1_500;
const DELIVERY_HISTORY_CHECK_LIMIT = 8;

type BlueBubblesDeliveryConfig = {
  timeoutMs: number;
  retryCount: number;
  retryBaseDelayMs: number;
};

type ParsedBlueBubblesMessageResponse = BlueBubblesSendResult & {
  chatGuid?: string | null;
};

type BlueBubblesApiRecord = Record<string, unknown>;

function asBlueBubblesRecord(value: unknown): BlueBubblesApiRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as BlueBubblesApiRecord)
    : null;
}

function extractBlueBubblesResponseError(
  payload: unknown,
): { status?: number; message: string } | null {
  const record = asBlueBubblesRecord(payload);
  if (!record) {
    return null;
  }

  const status =
    typeof record.status === "number" && Number.isFinite(record.status) ? record.status : undefined;
  const errorRecord = asBlueBubblesRecord(record.error);
  const explicitMessage =
    (typeof errorRecord?.message === "string" && errorRecord.message) ||
    (typeof errorRecord?.error === "string" && errorRecord.error) ||
    (typeof record.message === "string" &&
      status !== undefined &&
      status >= 400 &&
      record.message) ||
    "";
  if (status !== undefined && status >= 400) {
    return { status, message: explicitMessage || `status ${status}` };
  }
  if (errorRecord) {
    return {
      status,
      message:
        explicitMessage ||
        (typeof errorRecord.type === "string" && errorRecord.type) ||
        "unknown error",
    };
  }
  if (record.success === false) {
    return {
      status,
      message: explicitMessage || "request was not accepted by BlueBubbles",
    };
  }
  return null;
}

function extractBlueBubblesResponseChatGuid(payload: unknown): string | null {
  const record = asBlueBubblesRecord(payload);
  if (!record) {
    return null;
  }
  const data = asBlueBubblesRecord(record.data);
  const result = asBlueBubblesRecord(record.result);
  const payloadRecord = asBlueBubblesRecord(record.payload);
  const roots = [record, data, result, payloadRecord];
  for (const root of roots) {
    if (!root) {
      continue;
    }
    const candidates = [root.chatGuid, root.chat_guid, root.guid, root.chatIdentifier];
    for (const candidate of candidates) {
      if (typeof candidate === "string" && candidate.trim()) {
        return candidate.trim();
      }
    }
  }
  return null;
}

function clampPositiveNumber(value: number | undefined, fallback: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  const normalized = Math.floor(value);
  if (normalized <= 0) {
    return fallback;
  }
  return Math.min(normalized, max);
}

function resolveDeliveryConfig(
  opts: BlueBubblesSendOpts,
  account: ReturnType<typeof resolveBlueBubblesAccount>,
): BlueBubblesDeliveryConfig {
  return {
    timeoutMs: clampPositiveNumber(
      opts.deliveryConfirmationTimeoutMs ?? account.config.sendConfirmationTimeoutMs,
      DEFAULT_DELIVERY_CONFIRMATION_TIMEOUT_MS,
      30_000,
    ),
    retryCount: Math.min(
      clampPositiveNumber(
        opts.deliveryRetryCount ?? account.config.sendRetryCount,
        DEFAULT_DELIVERY_RETRY_COUNT,
        3,
      ),
      3,
    ),
    retryBaseDelayMs: clampPositiveNumber(
      opts.deliveryRetryBaseDelayMs ?? account.config.sendRetryBaseDelayMs,
      DEFAULT_DELIVERY_RETRY_BASE_DELAY_MS,
      30_000,
    ),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeConfirmationBody(text: string): string {
  return stripMarkdown(text).replace(/\s+/g, " ").trim().toLowerCase();
}

async function isMessageVisibleInRecentHistory(params: {
  baseUrl: string;
  password: string;
  accountId: string;
  chatGuid: string;
  body: string;
  timeoutMs?: number;
}): Promise<string | null> {
  const bodyNorm = normalizeConfirmationBody(params.body);
  if (!bodyNorm) {
    return null;
  }
  const history = await fetchBlueBubblesHistory(params.chatGuid, DELIVERY_HISTORY_CHECK_LIMIT, {
    serverUrl: params.baseUrl,
    password: params.password,
    accountId: params.accountId,
    timeoutMs: params.timeoutMs,
  });
  for (let i = history.entries.length - 1; i >= 0; i--) {
    const entry = history.entries[i];
    if (entry.sender !== "me") {
      continue;
    }
    if (normalizeConfirmationBody(entry.body) !== bodyNorm) {
      continue;
    }
    const messageId = entry.messageId?.trim();
    return messageId || "ok";
  }
  return null;
}

async function waitForDeliveryConfirmation(params: {
  baseUrl: string;
  password: string;
  accountId: string;
  chatGuid: string;
  messageId: string;
  body: string;
  confirmationTimeoutMs: number;
  timeoutMs?: number;
}): Promise<{ confirmed: boolean; messageId: string }> {
  const webhookConfirmation = await waitForBlueBubblesOutboundConfirmation({
    accountId: params.accountId,
    chatGuid: params.chatGuid,
    messageId: params.messageId,
    body: params.body,
    timeoutMs: params.confirmationTimeoutMs,
  });
  if (webhookConfirmation) {
    return {
      confirmed: true,
      messageId: webhookConfirmation.messageId?.trim() || params.messageId,
    };
  }

  const historyMessageId = await isMessageVisibleInRecentHistory({
    baseUrl: params.baseUrl,
    password: params.password,
    accountId: params.accountId,
    chatGuid: params.chatGuid,
    body: params.body,
    timeoutMs: params.timeoutMs,
  });
  if (historyMessageId) {
    return { confirmed: true, messageId: historyMessageId };
  }

  return { confirmed: false, messageId: params.messageId };
}

async function parseBlueBubblesMessageResponse(
  res: Response,
): Promise<ParsedBlueBubblesMessageResponse> {
  const body = await res.text();
  if (!body) {
    return { messageId: "ok", chatGuid: null };
  }
  try {
    const parsed = JSON.parse(body) as unknown;
    const responseError = extractBlueBubblesResponseError(parsed);
    if (responseError) {
      const statusSuffix = responseError.status ? ` (${responseError.status})` : "";
      throw new Error(
        `BlueBubbles send failed${statusSuffix}: ${responseError.message || "unknown"}`,
      );
    }
    return {
      messageId: extractBlueBubblesMessageId(parsed),
      chatGuid: extractBlueBubblesResponseChatGuid(parsed),
    };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("BlueBubbles send failed")) {
      throw error;
    }
    return { messageId: "ok", chatGuid: null };
  }
}

type BlueBubblesChatRecord = Record<string, unknown>;

function extractChatGuid(chat: BlueBubblesChatRecord): string | null {
  const candidates = [
    chat.chatGuid,
    chat.guid,
    chat.chat_guid,
    chat.identifier,
    chat.chatIdentifier,
    chat.chat_identifier,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }
  return null;
}

function extractChatId(chat: BlueBubblesChatRecord): number | null {
  const candidates = [chat.chatId, chat.id, chat.chat_id];
  for (const candidate of candidates) {
    if (typeof candidate === "number" && Number.isFinite(candidate)) {
      return candidate;
    }
  }
  return null;
}

function extractChatIdentifierFromChatGuid(chatGuid: string): string | null {
  const parts = chatGuid.split(";");
  if (parts.length < 3) {
    return null;
  }
  const identifier = parts[2]?.trim();
  return identifier ? identifier : null;
}

function extractParticipantAddresses(chat: BlueBubblesChatRecord): string[] {
  const raw =
    (Array.isArray(chat.participants) ? chat.participants : null) ??
    (Array.isArray(chat.handles) ? chat.handles : null) ??
    (Array.isArray(chat.participantHandles) ? chat.participantHandles : null);
  if (!raw) {
    return [];
  }
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry === "string") {
      out.push(entry);
      continue;
    }
    if (entry && typeof entry === "object") {
      const record = entry as Record<string, unknown>;
      const candidate =
        (typeof record.address === "string" && record.address) ||
        (typeof record.handle === "string" && record.handle) ||
        (typeof record.id === "string" && record.id) ||
        (typeof record.identifier === "string" && record.identifier);
      if (candidate) {
        out.push(candidate);
      }
    }
  }
  return out;
}

async function queryChats(params: {
  baseUrl: string;
  password: string;
  timeoutMs?: number;
  offset: number;
  limit: number;
}): Promise<BlueBubblesChatRecord[]> {
  const url = buildBlueBubblesApiUrl({
    baseUrl: params.baseUrl,
    path: "/api/v1/chat/query",
    password: params.password,
  });
  const res = await blueBubblesFetchWithTimeout(
    url,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        limit: params.limit,
        offset: params.offset,
        with: ["participants"],
      }),
    },
    params.timeoutMs,
  );
  if (!res.ok) {
    return [];
  }
  const payload = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  const data = payload && typeof payload.data !== "undefined" ? (payload.data as unknown) : null;
  return Array.isArray(data) ? (data as BlueBubblesChatRecord[]) : [];
}

export async function resolveChatGuidForTarget(params: {
  baseUrl: string;
  password: string;
  timeoutMs?: number;
  target: BlueBubblesSendTarget;
}): Promise<string | null> {
  if (params.target.kind === "chat_guid") {
    return params.target.chatGuid;
  }

  const normalizedHandle =
    params.target.kind === "handle" ? normalizeBlueBubblesHandle(params.target.address) : "";
  const targetChatId = params.target.kind === "chat_id" ? params.target.chatId : null;
  const targetChatIdentifier =
    params.target.kind === "chat_identifier" ? params.target.chatIdentifier : null;

  const limit = 500;
  let participantMatch: string | null = null;
  for (let offset = 0; offset < 5000; offset += limit) {
    const chats = await queryChats({
      baseUrl: params.baseUrl,
      password: params.password,
      timeoutMs: params.timeoutMs,
      offset,
      limit,
    });
    if (chats.length === 0) {
      break;
    }
    for (const chat of chats) {
      if (targetChatId != null) {
        const chatId = extractChatId(chat);
        if (chatId != null && chatId === targetChatId) {
          return extractChatGuid(chat);
        }
      }
      if (targetChatIdentifier) {
        const guid = extractChatGuid(chat);
        if (guid) {
          // Back-compat: some callers might pass a full chat GUID.
          if (guid === targetChatIdentifier) {
            return guid;
          }

          // Primary match: BlueBubbles `chat_identifier:*` targets correspond to the
          // third component of the chat GUID: `service;(+|-) ;identifier`.
          const guidIdentifier = extractChatIdentifierFromChatGuid(guid);
          if (guidIdentifier && guidIdentifier === targetChatIdentifier) {
            return guid;
          }
        }

        const identifier =
          typeof chat.identifier === "string"
            ? chat.identifier
            : typeof chat.chatIdentifier === "string"
              ? chat.chatIdentifier
              : typeof chat.chat_identifier === "string"
                ? chat.chat_identifier
                : "";
        if (identifier && identifier === targetChatIdentifier) {
          return guid ?? extractChatGuid(chat);
        }
      }
      if (normalizedHandle) {
        const guid = extractChatGuid(chat);
        const directHandle = guid ? extractHandleFromChatGuid(guid) : null;
        if (directHandle && directHandle === normalizedHandle) {
          return guid;
        }
        if (!participantMatch && guid) {
          // Only consider DM chats (`;-;` separator) as participant matches.
          // Group chats (`;+;` separator) should never match when searching by handle/phone.
          // This prevents routing "send to +1234567890" to a group chat that contains that number.
          const isDmChat = guid.includes(";-;");
          if (isDmChat) {
            const participants = extractParticipantAddresses(chat).map((entry) =>
              normalizeBlueBubblesHandle(entry),
            );
            if (participants.includes(normalizedHandle)) {
              participantMatch = guid;
            }
          }
        }
      }
    }
  }
  return participantMatch;
}

/**
 * Creates a new DM chat for the given address and returns the chat GUID.
 * Requires Private API to be enabled in BlueBubbles.
 *
 * If a `message` is provided it is sent as the initial message in the new chat;
 * otherwise an empty-string message body is used (BlueBubbles still creates the
 * chat but will not deliver a visible bubble).
 */
export async function createChatForHandle(params: {
  baseUrl: string;
  password: string;
  address: string;
  message?: string;
  timeoutMs?: number;
}): Promise<{ chatGuid: string | null; messageId: string }> {
  const url = buildBlueBubblesApiUrl({
    baseUrl: params.baseUrl,
    path: "/api/v1/chat/new",
    password: params.password,
  });
  const payload = {
    addresses: [params.address],
    message: params.message ?? "",
    tempGuid: `temp-${crypto.randomUUID()}`,
  };
  const res = await blueBubblesFetchWithTimeout(
    url,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
    params.timeoutMs,
  );
  if (!res.ok) {
    const errorText = await res.text();
    if (
      res.status === 400 ||
      res.status === 403 ||
      errorText.toLowerCase().includes("private api")
    ) {
      throw new Error(
        `BlueBubbles send failed: Cannot create new chat - Private API must be enabled. Original error: ${errorText || res.status}`,
      );
    }
    throw new Error(`BlueBubbles create chat failed (${res.status}): ${errorText || "unknown"}`);
  }
  const body = await res.text();
  let messageId = "ok";
  let chatGuid: string | null = null;
  if (body) {
    try {
      const parsed = JSON.parse(body) as Record<string, unknown>;
      messageId = extractBlueBubblesMessageId(parsed);
      // Extract chatGuid from the response data
      const data = parsed.data as Record<string, unknown> | undefined;
      if (data) {
        chatGuid =
          (typeof data.chatGuid === "string" && data.chatGuid) ||
          (typeof data.guid === "string" && data.guid) ||
          null;
        // Also try nested chats array (some BB versions nest it)
        if (!chatGuid) {
          const chats = data.chats ?? data.chat;
          if (Array.isArray(chats) && chats.length > 0) {
            const first = chats[0] as Record<string, unknown> | undefined;
            chatGuid =
              (typeof first?.guid === "string" && first.guid) ||
              (typeof first?.chatGuid === "string" && first.chatGuid) ||
              null;
          } else if (chats && typeof chats === "object" && !Array.isArray(chats)) {
            const chatObj = chats as Record<string, unknown>;
            chatGuid =
              (typeof chatObj.guid === "string" && chatObj.guid) ||
              (typeof chatObj.chatGuid === "string" && chatObj.chatGuid) ||
              null;
          }
        }
      }
    } catch {
      // ignore parse errors
    }
  }
  return { chatGuid, messageId };
}

async function sendTextMessageOnce(params: {
  baseUrl: string;
  password: string;
  payload: Record<string, unknown>;
  timeoutMs?: number;
}): Promise<ParsedBlueBubblesMessageResponse> {
  const url = buildBlueBubblesApiUrl({
    baseUrl: params.baseUrl,
    path: "/api/v1/message/text",
    password: params.password,
  });
  const res = await blueBubblesFetchWithTimeout(
    url,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params.payload),
    },
    params.timeoutMs,
  );
  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`BlueBubbles send failed (${res.status}): ${errorText || "unknown"}`);
  }
  return parseBlueBubblesMessageResponse(res);
}

async function sendMessageWithDeliveryRetries(params: {
  accountId: string;
  baseUrl: string;
  password: string;
  message: string;
  confirmationChatGuid?: string | null;
  resolveConfirmationChatGuid?: () => Promise<string | null>;
  timeoutMs?: number;
  delivery: BlueBubblesDeliveryConfig;
  send: () => Promise<ParsedBlueBubblesMessageResponse>;
}): Promise<BlueBubblesSendResult> {
  const maxAttempts = Math.max(1, params.delivery.retryCount + 1);
  let resolvedChatGuid = params.confirmationChatGuid?.trim() || null;
  let lastMessageId = "ok";

  for (let attemptIndex = 0; attemptIndex < maxAttempts; attemptIndex++) {
    const sendResult = await params.send();
    lastMessageId = sendResult.messageId;
    resolvedChatGuid = sendResult.chatGuid?.trim() || resolvedChatGuid;
    if (!resolvedChatGuid && params.resolveConfirmationChatGuid) {
      resolvedChatGuid = await params.resolveConfirmationChatGuid();
    }
    if (!resolvedChatGuid) {
      warnBlueBubbles(
        "send accepted by BlueBubbles, but no chatGuid was available to verify delivery. Returning the API result without confirmation.",
      );
      return { messageId: lastMessageId };
    }

    const confirmation = await waitForDeliveryConfirmation({
      baseUrl: params.baseUrl,
      password: params.password,
      accountId: params.accountId,
      chatGuid: resolvedChatGuid,
      messageId: sendResult.messageId,
      body: params.message,
      confirmationTimeoutMs: params.delivery.timeoutMs,
      timeoutMs: params.timeoutMs,
    });
    if (confirmation.confirmed) {
      return { messageId: confirmation.messageId || sendResult.messageId };
    }

    const attemptsLeft = maxAttempts - attemptIndex - 1;
    const messageIdHint = sendResult.messageId?.trim();
    const attemptLabel = `attempt ${attemptIndex + 1}/${maxAttempts}`;
    if (attemptsLeft <= 0) {
      throw new Error(
        `BlueBubbles send could not be confirmed after ${maxAttempts} attempts. The API accepted the request${messageIdHint && messageIdHint !== "ok" && messageIdHint !== "unknown" ? ` (messageId=${messageIdHint})` : ""}, but no webhook or history confirmation arrived within ${params.delivery.timeoutMs}ms.`,
      );
    }

    warnBlueBubbles(
      `send delivery not confirmed for ${attemptLabel}; retrying in ${params.delivery.retryBaseDelayMs * 2 ** attemptIndex}ms.`,
    );
    await sleep(params.delivery.retryBaseDelayMs * 2 ** attemptIndex);
  }

  return { messageId: lastMessageId };
}

/**
 * Creates a new chat (DM) and sends an initial message.
 * Requires Private API to be enabled in BlueBubbles.
 */
async function createNewChatWithMessage(params: {
  accountId: string;
  baseUrl: string;
  password: string;
  address: string;
  message: string;
  timeoutMs?: number;
  delivery: BlueBubblesDeliveryConfig;
}): Promise<BlueBubblesSendResult> {
  return await sendMessageWithDeliveryRetries({
    accountId: params.accountId,
    baseUrl: params.baseUrl,
    password: params.password,
    message: params.message,
    timeoutMs: params.timeoutMs,
    delivery: params.delivery,
    resolveConfirmationChatGuid: async () =>
      await resolveChatGuidForTarget({
        baseUrl: params.baseUrl,
        password: params.password,
        timeoutMs: params.timeoutMs,
        target: {
          kind: "handle",
          address: params.address,
        },
      }),
    send: async () => {
      const result = await createChatForHandle({
        baseUrl: params.baseUrl,
        password: params.password,
        address: params.address,
        message: params.message,
        timeoutMs: params.timeoutMs,
      });
      return { messageId: result.messageId, chatGuid: result.chatGuid };
    },
  });
}

export async function sendMessageBlueBubbles(
  to: string,
  text: string,
  opts: BlueBubblesSendOpts = {},
): Promise<BlueBubblesSendResult> {
  const trimmedText = text ?? "";
  if (!trimmedText.trim()) {
    throw new Error("BlueBubbles send requires text");
  }
  // Strip markdown early and validate - ensures messages like "***" or "---" don't become empty
  const strippedText = stripMarkdown(trimmedText);
  if (!strippedText.trim()) {
    throw new Error("BlueBubbles send requires text (message was empty after markdown removal)");
  }

  const account = resolveBlueBubblesAccount({
    cfg: opts.cfg ?? {},
    accountId: opts.accountId,
  });
  const baseUrl =
    normalizeSecretInputString(opts.serverUrl) ||
    normalizeSecretInputString(account.config.serverUrl);
  const password =
    normalizeSecretInputString(opts.password) ||
    normalizeSecretInputString(account.config.password);
  if (!baseUrl) {
    throw new Error("BlueBubbles serverUrl is required");
  }
  if (!password) {
    throw new Error("BlueBubbles password is required");
  }
  const privateApiStatus = getCachedBlueBubblesPrivateApiStatus(account.accountId);
  const delivery = resolveDeliveryConfig(opts, account);

  const target = resolveBlueBubblesSendTarget(to);
  const chatGuid = await resolveChatGuidForTarget({
    baseUrl,
    password,
    timeoutMs: opts.timeoutMs,
    target,
  });
  if (!chatGuid) {
    // If target is a phone number/handle and no existing chat found,
    // auto-create a new DM chat using the /api/v1/chat/new endpoint
    if (target.kind === "handle") {
      return createNewChatWithMessage({
        accountId: account.accountId,
        baseUrl,
        password,
        address: target.address,
        message: strippedText,
        timeoutMs: opts.timeoutMs,
        delivery,
      });
    }
    throw new Error(
      "BlueBubbles send failed: chatGuid not found for target. Use a chat_guid target or ensure the chat exists.",
    );
  }
  const effectId = resolveEffectId(opts.effectId);
  const wantsReplyThread = Boolean(opts.replyToMessageGuid?.trim());
  const wantsEffect = Boolean(effectId);
  const privateApiDecision = resolvePrivateApiDecision({
    privateApiStatus,
    wantsReplyThread,
    wantsEffect,
  });
  if (privateApiDecision.throwEffectDisabledError) {
    throw new Error(
      "BlueBubbles send failed: reply/effect requires Private API, but it is disabled on the BlueBubbles server.",
    );
  }
  if (privateApiDecision.warningMessage) {
    warnBlueBubbles(privateApiDecision.warningMessage);
  }

  return await sendMessageWithDeliveryRetries({
    accountId: account.accountId,
    baseUrl,
    password,
    message: strippedText,
    confirmationChatGuid: chatGuid,
    timeoutMs: opts.timeoutMs,
    delivery,
    send: async () => {
      const payload: Record<string, unknown> = {
        chatGuid,
        tempGuid: crypto.randomUUID(),
        message: strippedText,
      };
      if (privateApiDecision.canUsePrivateApi) {
        payload.method = "private-api";
      }

      if (wantsReplyThread && privateApiDecision.canUsePrivateApi) {
        payload.selectedMessageGuid = opts.replyToMessageGuid;
        payload.partIndex = typeof opts.replyToPartIndex === "number" ? opts.replyToPartIndex : 0;
      }

      if (effectId && privateApiDecision.canUsePrivateApi) {
        payload.effectId = effectId;
      }

      return await sendTextMessageOnce({
        baseUrl,
        password,
        payload,
        timeoutMs: opts.timeoutMs,
      });
    },
  });
}
