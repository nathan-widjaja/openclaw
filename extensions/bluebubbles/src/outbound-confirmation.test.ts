import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearBlueBubblesOutboundConfirmations,
  confirmBlueBubblesOutboundMessage,
  waitForBlueBubblesOutboundConfirmation,
} from "./outbound-confirmation.js";

afterEach(() => {
  clearBlueBubblesOutboundConfirmations();
  vi.useRealTimers();
});

describe("outbound confirmation", () => {
  it("matches a pending confirmation by chat and message id", async () => {
    const pendingPromise = waitForBlueBubblesOutboundConfirmation({
      accountId: "default",
      chatGuid: "iMessage;-;+15551234567",
      messageId: "msg-123",
      body: "Hello there",
      timeoutMs: 1_000,
    });

    expect(
      confirmBlueBubblesOutboundMessage({
        accountId: "default",
        chatGuid: "iMessage;-;+15551234567",
        messageId: "msg-123",
        body: "Hello there",
      }),
    ).toBe(true);

    await expect(pendingPromise).resolves.toEqual({
      messageId: "msg-123",
      source: "webhook",
    });
  });

  it("falls back to normalized body matching", async () => {
    const pendingPromise = waitForBlueBubblesOutboundConfirmation({
      accountId: "default",
      chatGuid: "iMessage;-;+15551234567",
      body: "**Hello** there",
      timeoutMs: 1_000,
    });

    expect(
      confirmBlueBubblesOutboundMessage({
        accountId: "default",
        chatGuid: "iMessage;-;+15551234567",
        body: "Hello there",
      }),
    ).toBe(true);

    await expect(pendingPromise).resolves.toEqual({
      messageId: undefined,
      source: "webhook",
    });
  });

  it("returns null when confirmation times out", async () => {
    vi.useFakeTimers();

    const pendingPromise = waitForBlueBubblesOutboundConfirmation({
      accountId: "default",
      chatGuid: "iMessage;-;+15551234567",
      body: "Hello there",
      timeoutMs: 250,
    });

    await vi.advanceTimersByTimeAsync(250);

    await expect(pendingPromise).resolves.toBeNull();
  });
});
