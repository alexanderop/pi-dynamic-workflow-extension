import type { WorkflowTaskNotification } from "#src/workflows/launch/launcher.ts";

export interface WorkflowNotificationDeliveryOptions {
  readonly deliverAs?: "steer" | "followUp" | "nextTurn";
  readonly triggerTurn?: boolean;
}

export function workflowNotificationDeliveryOptions(
  notification: WorkflowTaskNotification,
): WorkflowNotificationDeliveryOptions {
  return {
    deliverAs: "followUp",
    triggerTurn: notification.details.status !== "stopped",
  };
}

export function withStoppedWorkflowDoNotRerunPrompt(
  notification: WorkflowTaskNotification,
): WorkflowTaskNotification {
  if (notification.details.status !== "stopped") return notification;

  return {
    ...notification,
    content: [
      "This background workflow was stopped by the user from /workflows.",
      "Do not rerun, resume, or replace it yourself. Only the user may resume or restart workflow work from /workflows.",
      "Treat this notification as cancellation state, not as a request to continue the task.",
      "",
      notification.content,
    ].join("\n"),
  };
}

/**
 * Single seam for delivering a terminal workflow notification. Stopped runs are
 * always rewritten to the do-not-rerun prompt and never trigger a turn; any other
 * status is passed through `decorate` (e.g. an ultracode continuation prompt). This
 * keeps the "stopped means cancellation, not continue" policy in exactly one place.
 */
export function prepareWorkflowNotification(
  notification: WorkflowTaskNotification,
  decorate: (notification: WorkflowTaskNotification) => WorkflowTaskNotification = (n) => n,
): {
  readonly message: WorkflowTaskNotification;
  readonly delivery: WorkflowNotificationDeliveryOptions;
} {
  const message =
    notification.details.status === "stopped"
      ? withStoppedWorkflowDoNotRerunPrompt(notification)
      : decorate(notification);
  return { message, delivery: workflowNotificationDeliveryOptions(notification) };
}
