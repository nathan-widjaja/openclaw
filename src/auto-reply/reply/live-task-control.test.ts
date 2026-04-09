import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRunningTaskRun } from "../../tasks/task-executor.js";
import {
  createManagedTaskFlow,
  resetTaskFlowRegistryForTests,
} from "../../tasks/task-flow-registry.js";
import { resetTaskRegistryForTests } from "../../tasks/task-registry.js";
import {
  beginLiveTaskControllerAction,
  beginBackgroundLiveTaskFlow,
  buildBackgroundLiveTaskAck,
  beginForegroundLiveTaskFlow,
  buildForegroundLiveTaskAck,
  buildLiveTaskBoardText,
  buildBlockingLiveTaskReply,
  buildLiveTaskStatusLine,
  cancelLiveTaskFlow,
  continueLiveTaskFlow,
  createQueuedLiveTaskFlow,
  formatLiveTaskHandle,
  isAuthorizedLiveTaskOperator,
  isLiveTaskDirectMessage,
  queueLiveTaskFlowForRetry,
  resolveLiveTaskBoard,
  setLiveTaskControllerActionReplyText,
  steerForegroundLiveTask,
} from "./live-task-control.js";
import { clearFollowupQueue, enqueueFollowupRun, listFollowupQueueItems } from "./queue.js";
import {
  __testing as replyRunRegistryTesting,
  createReplyOperation,
} from "./reply-run-registry.js";
import { createMockFollowupRun } from "./test-helpers.js";

const activeSessionIdMock = vi.fn<() => string | undefined>(() => undefined);
const isActiveRunMock = vi.fn<(sessionId: string) => boolean>(() => false);
const abortEmbeddedPiRunMock = vi.fn();

vi.mock("../../agents/pi-embedded.js", () => ({
  abortEmbeddedPiRun: (...args: unknown[]) => abortEmbeddedPiRunMock(...args),
  resolveActiveEmbeddedRunSessionId: (...args: unknown[]) => activeSessionIdMock(...args),
  isEmbeddedPiRunActive: (...args: unknown[]) => isActiveRunMock(...args),
}));

function createSessionFollowup(prompt: string) {
  return createMockFollowupRun({
    prompt,
    summaryLine: prompt,
    messageId: `telegram:${prompt}`,
    originatingChannel: "telegram",
    originatingChatType: "direct",
    run: {
      sessionKey: "agent:main:main",
      messageProvider: "telegram",
    },
  });
}

describe("live task control", () => {
  beforeEach(() => {
    resetTaskFlowRegistryForTests();
    resetTaskRegistryForTests();
    clearFollowupQueue("agent:main:main");
    activeSessionIdMock.mockReset();
    activeSessionIdMock.mockReturnValue(undefined);
    isActiveRunMock.mockReset();
    isActiveRunMock.mockReturnValue(false);
    abortEmbeddedPiRunMock.mockReset();
    replyRunRegistryTesting.resetReplyRunRegistry();
  });

  afterEach(() => {
    resetTaskFlowRegistryForTests();
    resetTaskRegistryForTests();
    clearFollowupQueue("agent:main:main");
    replyRunRegistryTesting.resetReplyRunRegistry();
  });

  it("creates a browser-lease wait flow and keeps the same handle across retry", () => {
    const followup = createSessionFollowup("continue replies now while the browser state is warm");
    const waiting = createQueuedLiveTaskFlow({
      queueKey: "agent:main:main",
      followupRun: followup,
    });

    expect(waiting.status).toBe("waiting");
    expect(waiting.waitJson).toMatchObject({
      kind: "browser_lease",
    });
    expect(followup.controller?.skipQueuedLifecycle).toBe(true);
    expect(followup.controllerFlowId).toBe(waiting.flowId);
    expect(followup.controllerBypassQueueLifecycle).toBe(true);
    expect(followup.controllerBrowserLease).toBe(true);

    const result = queueLiveTaskFlowForRetry({
      sessionKey: "agent:main:main",
      flow: waiting,
      template: createSessionFollowup("retry"),
      enqueueFollowupRun: (run) =>
        enqueueFollowupRun(
          "agent:main:main",
          run,
          { mode: "followup" },
          "prompt",
          async () => {},
          false,
        ),
    });

    const queued = listFollowupQueueItems("agent:main:main");
    expect(queued).toHaveLength(1);
    expect(queued[0].controller?.flowId).toBe(waiting.flowId);
    expect(result.text).toContain(formatLiveTaskHandle(waiting));
  });

  it("replays a pending controller action instead of creating duplicate side effects", () => {
    const followup = createSessionFollowup("draft the next reply");
    followup.messageId = "telegram:controller-action-1";

    const started = beginLiveTaskControllerAction({
      sessionKey: "agent:main:main",
      followupRun: followup,
      kind: "create",
      normalizedAction: "create",
    });
    const replay = beginLiveTaskControllerAction({
      sessionKey: "agent:main:main",
      followupRun: followup,
      kind: "create",
      normalizedAction: "create",
    });

    expect(started?.replayText).toBeUndefined();
    expect(replay?.replayText).toBe("Still processing your last control message.\nNext: /tasks");

    setLiveTaskControllerActionReplyText({
      actionKey: started?.actionKey,
      text: "Flow controller42 is now running.\nNext: /tasks controller42",
    });

    const replayWithAck = beginLiveTaskControllerAction({
      sessionKey: "agent:main:main",
      followupRun: followup,
      kind: "create",
      normalizedAction: "create",
    });

    expect(replayWithAck?.replayText).toContain("Flow controller42 is now running.");
  });

  it("only enables the live task controller for Telegram direct messages", () => {
    expect(
      isLiveTaskDirectMessage(
        createMockFollowupRun({
          originatingChannel: "telegram",
          originatingChatType: "private",
          run: {
            sessionKey: "agent:main:main",
            messageProvider: "telegram",
          },
        }),
      ),
    ).toBe(true);
    expect(
      isLiveTaskDirectMessage(
        createMockFollowupRun({
          originatingChannel: "whatsapp",
          originatingChatType: "direct",
          run: {
            sessionKey: "agent:main:main",
            messageProvider: "whatsapp",
          },
        }),
      ),
    ).toBe(false);
    expect(
      isLiveTaskDirectMessage(
        createMockFollowupRun({
          originatingChannel: "telegram",
          originatingChatType: "group",
          run: {
            sessionKey: "agent:main:main",
            messageProvider: "telegram",
          },
        }),
      ),
    ).toBe(false);
  });

  it("only authorizes the configured Telegram operator", () => {
    expect(
      isAuthorizedLiveTaskOperator(
        createMockFollowupRun({
          originatingChannel: "telegram",
          originatingChatType: "private",
          run: {
            sessionKey: "agent:main:main",
            messageProvider: "telegram",
            senderId: "telegram:owner",
            ownerNumbers: ["telegram:owner"],
          },
        }),
      ),
    ).toBe(true);
    expect(
      isAuthorizedLiveTaskOperator(
        createMockFollowupRun({
          originatingChannel: "telegram",
          originatingChatType: "private",
          run: {
            sessionKey: "agent:main:main",
            messageProvider: "telegram",
            senderId: "telegram:stranger",
            ownerNumbers: ["telegram:owner"],
          },
        }),
      ),
    ).toBe(false);
    expect(
      isAuthorizedLiveTaskOperator(
        createMockFollowupRun({
          originatingChannel: "telegram",
          originatingChatType: "private",
          run: {
            sessionKey: "agent:main:main",
            messageProvider: "telegram",
          },
        }),
      ),
    ).toBe(false);
  });

  it("creates a capacity wait flow when no warm browser lease is involved", () => {
    const waiting = createQueuedLiveTaskFlow({
      queueKey: "agent:main:main",
      followupRun: createSessionFollowup("plan the next outreach batch"),
    });

    expect(waiting.waitJson).toMatchObject({
      kind: "capacity",
    });
  });

  it("marks a stale foreground flow as lost after restart", () => {
    const running = beginForegroundLiveTaskFlow({
      queueKey: "agent:main:main",
      followupRun: createSessionFollowup("reply to the thread"),
    });
    const board = resolveLiveTaskBoard("agent:main:main");

    const reconciled = board.all.find((flow) => flow.flowId === running.flowId);
    expect(reconciled?.status).toBe("lost");
  });

  it("keeps a running flow alive while its inline reply operation is still active", () => {
    const running = beginForegroundLiveTaskFlow({
      queueKey: "agent:main:main",
      followupRun: createSessionFollowup("reply to the thread"),
    });
    const operation = createReplyOperation({
      sessionKey: "agent:main:main",
      sessionId: "live-session-1",
      resetTriggered: false,
    });

    const board = resolveLiveTaskBoard("agent:main:main");
    const reconciled = board.all.find((flow) => flow.flowId === running.flowId);

    expect(reconciled?.status).toBe("running");
    operation.complete();
  });

  it("keeps a background-running flow alive while its reply operation is still active", () => {
    const waiting = createQueuedLiveTaskFlow({
      queueKey: "agent:main:main",
      followupRun: createSessionFollowup("draft the founder reply"),
    });
    const running = beginBackgroundLiveTaskFlow({
      flowId: waiting.flowId,
    });
    const operation = createReplyOperation({
      sessionKey: "agent:main:main",
      sessionId: "live-session-2",
      resetTriggered: false,
    });

    const board = resolveLiveTaskBoard("agent:main:main");
    const reconciled = board.all.find((flow) => flow.flowId === running?.flowId);

    expect(reconciled?.status).toBe("running");
    expect(reconciled?.currentStep).toBe("Working in the background.");
    operation.complete();
  });

  it("keeps a running flow alive when a linked subagent task is still active", () => {
    const flow = createManagedTaskFlow({
      ownerKey: "agent:main:main",
      controllerId: "auto-reply/live-task-control",
      goal: "Coordinate a background worker",
      status: "running",
      currentStep: "Waiting for the worker to finish.",
      stateJson: {
        controller: {
          foreground: true,
          browserLease: false,
        },
        request: {
          prompt: "Coordinate a background worker",
          summaryLine: "Coordinate a background worker",
          waitKind: "capacity",
        },
      },
    });
    createRunningTaskRun({
      runtime: "subagent",
      requesterSessionKey: "agent:main:main",
      childSessionKey: "agent:main:subagent:worker-1",
      parentFlowId: flow.flowId,
      runId: "run-live-task-worker-1",
      task: "background worker",
    });

    const board = resolveLiveTaskBoard("agent:main:main");
    const reconciled = board.all.find((entry) => entry.flowId === flow.flowId);

    expect(reconciled?.status).toBe("running");
  });

  it("cancels queued flows and removes their internal queue items", () => {
    const followup = createSessionFollowup("draft the reply");
    const waiting = createQueuedLiveTaskFlow({
      queueKey: "agent:main:main",
      followupRun: followup,
    });
    enqueueFollowupRun(
      "agent:main:main",
      followup,
      { mode: "followup" },
      "prompt",
      async () => {},
      false,
    );

    const reply = cancelLiveTaskFlow({
      sessionKey: "agent:main:main",
      flow: waiting,
    });

    expect(reply.text).toContain("Cancelled flow");
    expect(listFollowupQueueItems("agent:main:main")).toHaveLength(0);
  });

  it("requires confirmation before cancelling an active browser-held flow", () => {
    const running = beginForegroundLiveTaskFlow({
      queueKey: "agent:main:main",
      followupRun: createSessionFollowup("reply while the browser is warm"),
    });

    const reply = cancelLiveTaskFlow({
      sessionKey: "agent:main:main",
      flow: running,
    });

    expect(reply.text).toContain("actively holding the live browser");
    expect(reply.text).toContain(`cancel ${formatLiveTaskHandle(running)} confirm`);
    expect(abortEmbeddedPiRunMock).not.toHaveBeenCalled();
  });

  it("renders the controller status surfaces with health, handles, and legend", () => {
    const running = beginForegroundLiveTaskFlow({
      queueKey: "agent:main:main",
      followupRun: createSessionFollowup("reply while the browser is warm"),
    });
    const operation = createReplyOperation({
      sessionKey: "agent:main:main",
      sessionId: "live-session-status-1",
      resetTriggered: false,
    });

    const boardText = buildLiveTaskBoardText({
      sessionKey: "agent:main:main",
    });
    const statusLine = buildLiveTaskStatusLine("agent:main:main");
    const ack = buildForegroundLiveTaskAck(running);

    expect(boardText).toContain("Controller: healthy");
    expect(boardText).toContain("Legend: handles are short flow ids.");
    expect(boardText).toContain(formatLiveTaskHandle(running));
    expect(statusLine).toContain("controller healthy");
    expect(statusLine).toContain(`foreground ${formatLiveTaskHandle(running)}`);
    expect(ack.text).toContain(`Flow ${formatLiveTaskHandle(running)} is now running.`);
    operation.complete();
  });

  it("reports when a retry is deduped instead of claiming it was queued", () => {
    const waiting = createQueuedLiveTaskFlow({
      queueKey: "agent:main:main",
      followupRun: createSessionFollowup("resume the waiting task"),
    });

    const result = queueLiveTaskFlowForRetry({
      sessionKey: "agent:main:main",
      flow: waiting,
      template: createSessionFollowup("retry"),
      enqueueFollowupRun: () => false,
    });

    expect(result.text).toContain("Did not queue flow");
  });

  it("moves a waiting flow into the foreground and clears a stale browser holder", () => {
    beginForegroundLiveTaskFlow({
      queueKey: "agent:main:main",
      followupRun: createSessionFollowup("reply while the browser is warm"),
    });
    const waitingFollowup = createSessionFollowup("review the next thread");
    const waiting = createQueuedLiveTaskFlow({
      queueKey: "agent:main:main",
      followupRun: waitingFollowup,
    });
    enqueueFollowupRun(
      "agent:main:main",
      waitingFollowup,
      { mode: "followup" },
      "prompt",
      async () => {},
      false,
    );

    const reply = continueLiveTaskFlow({
      sessionKey: "agent:main:main",
      flow: waiting,
    });
    const board = resolveLiveTaskBoard("agent:main:main");

    expect(reply?.text).toContain(
      `Flow ${formatLiveTaskHandle(waiting)} is now the foreground flow.`,
    );
    expect(board.foreground?.flowId).toBe(waiting.flowId);
    expect(board.browserHolder?.flowId).toBe(waiting.flowId);
  });

  it("reports foreground and next waiting flow in the blocker reply", () => {
    const foreground = beginForegroundLiveTaskFlow({
      queueKey: "agent:main:main",
      followupRun: createSessionFollowup("reply while the browser is warm"),
    });
    const waitingFollowup = createSessionFollowup("review the next follow-up");
    const waiting = createQueuedLiveTaskFlow({
      queueKey: "agent:main:main",
      followupRun: waitingFollowup,
    });
    enqueueFollowupRun(
      "agent:main:main",
      waitingFollowup,
      { mode: "followup" },
      "prompt",
      async () => {},
      false,
    );

    expect(waiting.flowId).not.toBe(foreground.flowId);

    const reply = buildBlockingLiveTaskReply("agent:main:main");

    expect(reply?.text).toContain("Next waiting flow");
    expect(reply?.text).toContain(formatLiveTaskHandle(waiting));
  });

  it("chooses the earliest queued waiting flow as the next waiting flow", () => {
    beginForegroundLiveTaskFlow({
      queueKey: "agent:main:main",
      followupRun: createSessionFollowup("reply while the browser is warm"),
    });
    const firstFollowup = createSessionFollowup("first waiting flow");
    const firstWaiting = createQueuedLiveTaskFlow({
      queueKey: "agent:main:main",
      followupRun: firstFollowup,
    });
    enqueueFollowupRun(
      "agent:main:main",
      firstFollowup,
      { mode: "followup" },
      "prompt",
      async () => {},
      false,
    );
    const secondFollowup = createSessionFollowup("second waiting flow");
    const secondWaiting = createQueuedLiveTaskFlow({
      queueKey: "agent:main:main",
      followupRun: secondFollowup,
    });
    enqueueFollowupRun(
      "agent:main:main",
      secondFollowup,
      { mode: "followup" },
      "prompt",
      async () => {},
      false,
    );

    const board = resolveLiveTaskBoard("agent:main:main");
    const reply = buildBlockingLiveTaskReply("agent:main:main");

    expect(firstWaiting.flowId).not.toBe(secondWaiting.flowId);
    expect(board.waiting[0]?.flowId).toBe(firstWaiting.flowId);
    expect(reply?.text).toContain(`Next waiting flow: ${formatLiveTaskHandle(firstWaiting)}.`);
    expect(reply?.text).not.toContain(`Next waiting flow: ${formatLiveTaskHandle(secondWaiting)}.`);
  });

  it("formats the immediate background ack without queue wording", () => {
    const waiting = createQueuedLiveTaskFlow({
      queueKey: "agent:main:main",
      followupRun: createSessionFollowup("draft the next batch"),
    });

    const reply = buildBackgroundLiveTaskAck(waiting);

    expect(reply.text).toContain(`background as ${formatLiveTaskHandle(waiting)}`);
    expect(reply.text).toContain(`cancel ${formatLiveTaskHandle(waiting)}`);
    expect(reply.text).not.toContain("Queued as flow");
    expect(reply.text).not.toContain("foreground capacity");
  });

  it("steers the foreground flow while the browser is warm", () => {
    const foreground = beginForegroundLiveTaskFlow({
      queueKey: "agent:main:main",
      followupRun: createSessionFollowup("reply while the browser is warm"),
    });
    activeSessionIdMock.mockReturnValue("pi-session-1");

    const reply = steerForegroundLiveTask({
      sessionKey: "agent:main:main",
      prompt: "continue replies now while the browser state is warm",
      queueEmbeddedPiMessage: (sessionId, text) =>
        sessionId === "pi-session-1" &&
        text === "continue replies now while the browser state is warm",
    });

    expect(reply?.text).toContain(`Steered foreground flow ${formatLiveTaskHandle(foreground)}`);
  });

  it("falls back to the blocked summary when a managed flow is blocked on the user", () => {
    beginForegroundLiveTaskFlow({
      queueKey: "agent:main:main",
      followupRun: createSessionFollowup("keep the foreground moving"),
    });
    const blocked = createManagedTaskFlow({
      ownerKey: "agent:main:main",
      controllerId: "auto-reply/live-task-control",
      goal: "Need user confirmation",
      status: "blocked",
      blockedSummary: "Waiting for user confirmation before sending.",
      stateJson: {
        controller: {
          foreground: false,
          browserLease: false,
        },
        request: {
          prompt: "Need user confirmation",
          summaryLine: "Need user confirmation",
          waitKind: "capacity",
        },
      },
    });

    const reply = buildBlockingLiveTaskReply("agent:main:main");

    expect(reply?.text).toContain("Blocked flow");
    expect(reply?.text).toContain(formatLiveTaskHandle(blocked));
    expect(reply?.text).toContain("Waiting for user confirmation before sending.");
  });
});
