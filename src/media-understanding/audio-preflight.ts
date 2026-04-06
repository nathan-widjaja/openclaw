import type { MsgContext } from "../auto-reply/templating.js";
import type { OpenClawConfig } from "../config/config.js";
import { logVerbose, shouldLogVerbose } from "../globals.js";
import { isAudioAttachment } from "./attachments.js";
import { runAudioTranscription } from "./audio-transcription-runner.js";
import { DEFAULT_TIMEOUT_SECONDS } from "./defaults.js";
import { resolveConcurrency } from "./resolve.js";
import {
  type ActiveMediaModel,
  normalizeMediaAttachments,
  resolveMediaAttachmentLocalRoots,
} from "./runner.js";
import type { MediaUnderstandingProvider } from "./types.js";

const AUDIO_PREFLIGHT_TIMEOUT_CAP_SECONDS = 15;
const MAX_AUDIO_PREFLIGHT_CONCURRENCY = 2;

let activeAudioPreflights = 0;

function resolveAudioPreflightTimeoutSeconds(cfg: OpenClawConfig): number {
  const configured = cfg.tools?.media?.audio?.timeoutSeconds;
  const normalized =
    typeof configured === "number" && Number.isFinite(configured) && configured > 0
      ? configured
      : DEFAULT_TIMEOUT_SECONDS.audio;
  return Math.min(normalized, AUDIO_PREFLIGHT_TIMEOUT_CAP_SECONDS);
}

function resolveAudioPreflightConcurrencyLimit(cfg: OpenClawConfig): number {
  return Math.max(1, Math.min(resolveConcurrency(cfg), MAX_AUDIO_PREFLIGHT_CONCURRENCY));
}

function buildAudioPreflightConfig(cfg: OpenClawConfig, timeoutSeconds: number): OpenClawConfig {
  const audio = cfg.tools?.media?.audio;
  if (audio?.timeoutSeconds === timeoutSeconds) {
    return cfg;
  }
  return {
    ...cfg,
    tools: {
      ...cfg.tools,
      media: {
        ...cfg.tools?.media,
        audio: {
          ...audio,
          timeoutSeconds,
        },
      },
    },
  };
}

export function resetAudioPreflightStateForTests(): void {
  activeAudioPreflights = 0;
}

/**
 * Transcribes the first audio attachment BEFORE mention checking.
 * This allows voice notes to be processed in group chats with requireMention: true.
 * Returns the transcript or undefined if transcription fails or no audio is found.
 */
export async function transcribeFirstAudio(params: {
  ctx: MsgContext;
  cfg: OpenClawConfig;
  agentDir?: string;
  providers?: Record<string, MediaUnderstandingProvider>;
  activeModel?: ActiveMediaModel;
  requiredForActivation?: boolean;
}): Promise<string | undefined> {
  const { ctx, cfg } = params;

  // Check if audio transcription is enabled in config
  const audioConfig = cfg.tools?.media?.audio;
  if (audioConfig?.enabled === false) {
    return undefined;
  }

  const attachments = normalizeMediaAttachments(ctx);
  if (!attachments || attachments.length === 0) {
    return undefined;
  }

  // Find first audio attachment
  const firstAudio = attachments.find(
    (att) => att && isAudioAttachment(att) && !att.alreadyTranscribed,
  );

  if (!firstAudio) {
    return undefined;
  }

  if (shouldLogVerbose()) {
    logVerbose(`audio-preflight: transcribing attachment ${firstAudio.index} for mention check`);
  }

  const concurrencyLimit = resolveAudioPreflightConcurrencyLimit(cfg);
  const requiredForActivation = params.requiredForActivation === true;
  if (activeAudioPreflights >= concurrencyLimit && !requiredForActivation) {
    if (shouldLogVerbose()) {
      logVerbose(
        `audio-preflight: busy (${activeAudioPreflights}/${concurrencyLimit}); skipping mention-check transcription for attachment ${firstAudio.index}`,
      );
    }
    return undefined;
  }
  if (activeAudioPreflights >= concurrencyLimit && shouldLogVerbose()) {
    logVerbose(
      `audio-preflight: busy (${activeAudioPreflights}/${concurrencyLimit}); continuing transcription for attachment ${firstAudio.index} because activation depends on it`,
    );
  }

  const preflightTimeoutSeconds = resolveAudioPreflightTimeoutSeconds(cfg);
  const preflightCfg = buildAudioPreflightConfig(cfg, preflightTimeoutSeconds);
  activeAudioPreflights += 1;
  try {
    const { transcript } = await runAudioTranscription({
      ctx,
      cfg: preflightCfg,
      attachments,
      agentDir: params.agentDir,
      providers: params.providers,
      activeModel: params.activeModel,
      localPathRoots: resolveMediaAttachmentLocalRoots({ cfg: preflightCfg, ctx }),
    });
    if (!transcript) {
      return undefined;
    }

    // Mark this attachment as transcribed to avoid double-processing
    firstAudio.alreadyTranscribed = true;

    if (shouldLogVerbose()) {
      logVerbose(
        `audio-preflight: transcribed ${transcript.length} chars from attachment ${firstAudio.index}`,
      );
    }

    return transcript;
  } catch (err) {
    // Log but don't throw - let the message proceed with text-only mention check
    if (shouldLogVerbose()) {
      logVerbose(`audio-preflight: transcription failed: ${String(err)}`);
    }
    return undefined;
  } finally {
    activeAudioPreflights = Math.max(0, activeAudioPreflights - 1);
  }
}
