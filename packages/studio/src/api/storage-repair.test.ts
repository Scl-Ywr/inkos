import { describe, expect, it } from "vitest";
import { buildDefaultStudioProjectConfig } from "./storage-repair.js";

describe("buildDefaultStudioProjectConfig", () => {
  it("uses a valid built-in text model for empty Studio projects", () => {
    const config = buildDefaultStudioProjectConfig();
    const llm = config.llm as Record<string, unknown>;

    expect(llm.service).toBe("xiaomimimo");
    expect(llm.defaultModel).toBe("mimo-v2-omni");
    expect(llm.model).toBe("mimo-v2-omni");
  });

  it("migrates the legacy apihub/agnes fallback to Xiaomi MiMo", () => {
    const config = buildDefaultStudioProjectConfig({
      llm: {
        service: "apihub",
        baseUrl: "https://token-plan-cn.xiaomimimo.com/v1",
        defaultModel: "agnes-2.0-flash",
      },
    });
    const llm = config.llm as Record<string, unknown>;

    expect(llm.service).toBe("xiaomimimo");
    expect(llm.defaultModel).toBe("mimo-v2-omni");
    expect(llm.model).toBe("mimo-v2-omni");
  });

  it("migrates legacy agnes defaults on custom Xiaomi MiMo gateways", () => {
    const config = buildDefaultStudioProjectConfig({
      llm: {
        service: "custom:mimo",
        defaultModel: "agnes-2.0-flash",
        services: [
          {
            service: "custom",
            name: "mimo",
            baseUrl: "https://token-plan-cn.xiaomimimo.com/v1",
            apiFormat: "chat",
            stream: true,
          },
        ],
      },
    });
    const llm = config.llm as Record<string, unknown>;

    expect(llm.service).toBe("custom:mimo");
    expect(llm.defaultModel).toBe("mimo-v2-omni");
    expect(llm.model).toBe("mimo-v2-omni");
  });

  it("keeps an explicitly selected non-legacy custom model", () => {
    const config = buildDefaultStudioProjectConfig({
      llm: {
        service: "custom:internal",
        defaultModel: "gpt-5.5",
        services: [
          {
            service: "custom",
            name: "internal",
            baseUrl: "https://llm.internal.example/v1",
          },
        ],
      },
    });
    const llm = config.llm as Record<string, unknown>;

    expect(llm.service).toBe("custom:internal");
    expect(llm.defaultModel).toBe("gpt-5.5");
    expect(llm.model).toBe("gpt-5.5");
  });
});
