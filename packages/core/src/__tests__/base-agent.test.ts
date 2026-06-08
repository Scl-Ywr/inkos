import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LLMClient, LLMMessage, LLMResponse, TokenOptimizationOptions } from "../llm/provider.js";

const chatCompletionMock = vi.hoisted(() => vi.fn());

vi.mock("../llm/provider.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../llm/provider.js")>();
  return {
    ...actual,
    chatCompletion: chatCompletionMock,
  };
});

const { BaseAgent } = await import("../agents/base.js");

type TestChatOptions = {
  readonly temperature?: number;
  readonly maxTokens?: number;
  readonly tokenOptimization?: Omit<TokenOptimizationOptions, "projectRoot" | "bookId">;
};

class TestAgent extends BaseAgent {
  get name(): string {
    return "test";
  }

  send(
    messages: ReadonlyArray<LLMMessage>,
    options?: TestChatOptions,
  ): Promise<LLMResponse> {
    return this.chat(messages, options);
  }
}

function createClient(): LLMClient {
  return {
    provider: "openai",
    service: "test",
    configSource: "studio",
    apiFormat: "chat",
    stream: true,
    defaults: {
      temperature: 0.7,
      maxTokens: 4096,
      thinkingBudget: 0,
      extra: {},
    },
  };
}

describe("BaseAgent", () => {
  beforeEach(() => {
    chatCompletionMock.mockReset();
    chatCompletionMock.mockResolvedValue({
      content: "ok",
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    } satisfies LLMResponse);
  });

  it("forwards runtime callbacks and token optimization context to chatCompletion", async () => {
    const client = createClient();
    const onStreamProgress = vi.fn();
    const onTextDelta = vi.fn();
    const controller = new AbortController();
    const messages: LLMMessage[] = [{ role: "user", content: "hello" }];
    const agent = new TestAgent({
      client,
      model: "demo-model",
      projectRoot: "D:/project",
      bookId: "demo-book",
      onStreamProgress,
      onTextDelta,
      signal: controller.signal,
    });

    await expect(agent.send(messages, {
      temperature: 0.2,
      maxTokens: 1234,
      tokenOptimization: {
        cache: false,
        compress: true,
      },
    })).resolves.toEqual({
      content: "ok",
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    });

    expect(chatCompletionMock).toHaveBeenCalledWith(client, "demo-model", messages, {
      temperature: 0.2,
      maxTokens: 1234,
      onStreamProgress,
      onTextDelta,
      signal: controller.signal,
      tokenOptimization: {
        cache: false,
        compress: true,
        projectRoot: "D:/project",
        bookId: "demo-book",
      },
    });
  });

  it("still injects project context when no token optimization options are supplied", async () => {
    const client = createClient();
    const messages: LLMMessage[] = [{ role: "user", content: "hello" }];
    const agent = new TestAgent({
      client,
      model: "demo-model",
      projectRoot: "D:/project",
    });

    await agent.send(messages);

    expect(chatCompletionMock).toHaveBeenCalledWith(client, "demo-model", messages, {
      onStreamProgress: undefined,
      onTextDelta: undefined,
      signal: undefined,
      tokenOptimization: {
        projectRoot: "D:/project",
        bookId: undefined,
      },
    });
  });
});
