import type { DeliveryContext } from "../utils/delivery-context.js";
import type { TaskNotifyPolicy } from "./task-registry.types.js";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export type TaskFlowSyncMode = "task_mirrored" | "managed";

export type TaskFlowStatus =
  | "queued"
  | "running"
  | "waiting"
  | "blocked"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "lost";

export type TaskFlowControllerActionKind = "create" | "steer" | "cancel" | "retry";

export type TaskFlowControllerActionStatus = "pending" | "completed";

export type TaskFlowControllerActionRecord = {
  actionKey: string;
  ownerKey: string;
  senderId?: string;
  updateId: string;
  normalizedAction: string;
  kind: TaskFlowControllerActionKind;
  revision: number;
  status: TaskFlowControllerActionStatus;
  flowId?: string;
  responseText?: string;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
};

export type TaskFlowBrowserLeaseRecord = {
  ownerKey: string;
  flowId: string;
  token: string;
  epoch: number;
  acquiredAt: number;
  heartbeatAt: number;
  updatedAt: number;
};

export type TaskFlowRecord = {
  flowId: string;
  syncMode: TaskFlowSyncMode;
  ownerKey: string;
  requesterOrigin?: DeliveryContext;
  controllerId?: string;
  revision: number;
  status: TaskFlowStatus;
  notifyPolicy: TaskNotifyPolicy;
  goal: string;
  currentStep?: string;
  blockedTaskId?: string;
  blockedSummary?: string;
  stateJson?: JsonValue;
  waitJson?: JsonValue;
  cancelRequestedAt?: number;
  createdAt: number;
  updatedAt: number;
  endedAt?: number;
};
