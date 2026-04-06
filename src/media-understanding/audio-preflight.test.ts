import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const runAudioTranscriptionMock = vi.hoisted(() => vi.fn());

vi.mock("./audio-transcription-runner.js", () => ({
  runAudioTranscription: (...args: unknown[]) => runAudioTranscriptionMock(...args),
}));

let resetAudioPreflightStateForTests: typeof import("./audio-preflight.js").resetAudioPreflightStateForTests;
let transcribeFirstAudio: typeof import("./audio-preflight.js").transcribeFirstAudio;

describe("transcribeFirstAudio", () => {
  beforeAll(async () => {
    ({ resetAudioPreflightStateForTests, transcribeFirstAudio } =
      await import("./audio-preflight.js"));
  });

  beforeEach(() => {
    runAudioTranscriptionMock.mockReset();
    resetAudioPreflightStateForTests();
  });

  it("runs audio preflight in auto mode when audio config is absent", async () => {
    runAudioTranscriptionMock.mockResolvedValueOnce({
      transcript: "voice note transcript",
      attachments: [],
    });

    const transcript = await transcribeFirstAudio({
      ctx: {
        Body: "<media:audio>",
        MediaPath: "/tmp/voice.ogg",
        MediaType: "audio/ogg",
      },
      cfg: {},
    });

    expect(transcript).toBe("voice note transcript");
    expect(runAudioTranscriptionMock).toHaveBeenCalledTimes(1);
    expect(runAudioTranscriptionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        cfg: expect.objectContaining({
          tools: expect.objectContaining({
            media: expect.objectContaining({
              audio: expect.objectContaining({
                timeoutSeconds: 15,
              }),
            }),
          }),
        }),
      }),
    );
  });

  it("skips audio preflight when audio config is explicitly disabled", async () => {
    const transcript = await transcribeFirstAudio({
      ctx: {
        Body: "<media:audio>",
        MediaPath: "/tmp/voice.ogg",
        MediaType: "audio/ogg",
      },
      cfg: {
        tools: {
          media: {
            audio: {
              enabled: false,
            },
          },
        },
      },
    });

    expect(transcript).toBeUndefined();
    expect(runAudioTranscriptionMock).not.toHaveBeenCalled();
  });

  it("preserves a smaller configured timeout for preflight", async () => {
    runAudioTranscriptionMock.mockResolvedValueOnce({
      transcript: "voice note transcript",
      attachments: [],
    });

    await transcribeFirstAudio({
      ctx: {
        Body: "<media:audio>",
        MediaPath: "/tmp/voice.ogg",
        MediaType: "audio/ogg",
      },
      cfg: {
        tools: {
          media: {
            audio: {
              timeoutSeconds: 8,
            },
          },
        },
      },
    });

    expect(runAudioTranscriptionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        cfg: expect.objectContaining({
          tools: expect.objectContaining({
            media: expect.objectContaining({
              audio: expect.objectContaining({
                timeoutSeconds: 8,
              }),
            }),
          }),
        }),
      }),
    );
  });

  it("skips best-effort preflight transcription when the concurrency budget is exhausted", async () => {
    let releaseFirst: (() => void) | undefined;
    runAudioTranscriptionMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseFirst = () =>
            resolve({
              transcript: "first transcript",
              attachments: [],
            });
        }),
    );

    const firstPromise = transcribeFirstAudio({
      ctx: {
        Body: "<media:audio>",
        MediaPath: "/tmp/voice-1.ogg",
        MediaType: "audio/ogg",
      },
      cfg: {
        tools: {
          media: {
            concurrency: 1,
          },
        },
      },
    });

    await Promise.resolve();

    const skipped = await transcribeFirstAudio({
      ctx: {
        Body: "<media:audio>",
        MediaPath: "/tmp/voice-2.ogg",
        MediaType: "audio/ogg",
      },
      cfg: {
        tools: {
          media: {
            concurrency: 1,
          },
        },
      },
    });

    expect(skipped).toBeUndefined();
    expect(runAudioTranscriptionMock).toHaveBeenCalledTimes(1);

    releaseFirst?.();
    await expect(firstPromise).resolves.toBe("first transcript");
  });

  it("continues preflight transcription when activation depends on the transcript", async () => {
    let releaseFirst: (() => void) | undefined;
    runAudioTranscriptionMock
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseFirst = () =>
              resolve({
                transcript: "first transcript",
                attachments: [],
              });
          }),
      )
      .mockResolvedValueOnce({
        transcript: "activation transcript",
        attachments: [],
      });

    const firstPromise = transcribeFirstAudio({
      ctx: {
        Body: "<media:audio>",
        MediaPath: "/tmp/voice-1.ogg",
        MediaType: "audio/ogg",
      },
      cfg: {
        tools: {
          media: {
            concurrency: 1,
          },
        },
      },
    });

    await Promise.resolve();

    await expect(
      transcribeFirstAudio({
        ctx: {
          Body: "<media:audio>",
          MediaPath: "/tmp/voice-2.ogg",
          MediaType: "audio/ogg",
        },
        cfg: {
          tools: {
            media: {
              concurrency: 1,
            },
          },
        },
        requiredForActivation: true,
      }),
    ).resolves.toBe("activation transcript");

    expect(runAudioTranscriptionMock).toHaveBeenCalledTimes(2);

    releaseFirst?.();
    await expect(firstPromise).resolves.toBe("first transcript");
  });
});
