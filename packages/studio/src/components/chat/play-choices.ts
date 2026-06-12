import type { Message, ToolExecution } from "../../store/chat/types";

const PLAY_TOOLS = new Set(["play_start", "play_step", "play_revise"]);

export interface PlayChoiceSet {
  readonly key: string;
  readonly choices: readonly string[];
}

function actionsFromExecution(exec: ToolExecution): string[] {
  if (!PLAY_TOOLS.has(exec.tool) || exec.status !== "completed") return [];
  const details = exec.details as { suggestedActions?: unknown } | undefined;
  return Array.isArray(details?.suggestedActions)
    ? details.suggestedActions.filter((a): a is string => typeof a === "string" && a.trim().length > 0)
    : [];
}

function choiceSetFromExecution(
  exec: ToolExecution,
  fallbackKey: string,
  fallbackChoices: ReadonlyArray<string>,
): PlayChoiceSet | null {
  if (!PLAY_TOOLS.has(exec.tool) || exec.status !== "completed") return null;
  const choices = actionsFromExecution(exec);
  const resolvedChoices = choices.length > 0 ? choices : [...fallbackChoices];
  if (resolvedChoices.length === 0) return null;
  const sourceKey = typeof exec.id === "string" && exec.id.trim() ? exec.id.trim() : "no-tool-id";
  const choiceSignature = JSON.stringify(resolvedChoices.map((choice) => choice.trim()));
  return {
    key: `${fallbackKey}:${sourceKey}:${choiceSignature}`,
    choices: resolvedChoices,
  };
}

export function latestPlayChoiceSet(
  messages: ReadonlyArray<Message>,
  fallbackChoices: ReadonlyArray<string> = [],
): PlayChoiceSet | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const parts = messages[i]?.parts ?? [];
    for (let p = parts.length - 1; p >= 0; p--) {
      const part = parts[p];
      if (part.type !== "tool") continue;
      if (!PLAY_TOOLS.has(part.execution.tool) || part.execution.status !== "completed") continue;
      const set = choiceSetFromExecution(part.execution, `message-${i}-part-${p}`, fallbackChoices);
      if (set) return set;
      return null;
    }

    // Direct tool executions created by confirmed action buttons may be present
    // on the flat message before they are rehydrated into chronological parts.
    const toolExecutions = messages[i]?.toolExecutions ?? [];
    for (let t = toolExecutions.length - 1; t >= 0; t--) {
      if (!PLAY_TOOLS.has(toolExecutions[t].tool) || toolExecutions[t].status !== "completed") continue;
      const set = choiceSetFromExecution(toolExecutions[t], `message-${i}-execution-${t}`, fallbackChoices);
      if (set) return set;
      return null;
    }
  }
  return null;
}

export function latestPlayChoices(messages: ReadonlyArray<Message>): string[] {
  return [...(latestPlayChoiceSet(messages)?.choices ?? [])];
}
