import { describe, expect, it } from "vitest";
import {
  buildAgentModelOverrides,
  buildDetectionConfig,
  buildNotifyChannel,
  detectionDraftFromConfig,
  fixedAgentOverrideRows,
  modelRouteValue,
  notifyDraftFromChannel,
  parseModelRouteValue,
} from "./project-settings-model";

describe("project settings form model", () => {
  it("preserves webhook event filters when round-tripping notification channels", () => {
    const draft = notifyDraftFromChannel({
      type: "webhook",
      url: "https://hooks.example.com/inkos",
      secret: "s1",
      events: ["chapter-complete", "pipeline-error"],
    });

    expect(buildNotifyChannel(draft)).toEqual({
      type: "webhook",
      url: "https://hooks.example.com/inkos",
      secret: "s1",
      events: ["chapter-complete", "pipeline-error"],
    });
  });

  it("honors detection.enabled=false instead of re-enabling the detector", () => {
    const draft = detectionDraftFromConfig({
      enabled: false,
      provider: "custom",
      apiUrl: "https://detector.example.com/api",
      apiKeyEnv: "DETECT_KEY",
      threshold: 0.7,
      autoRewrite: true,
      maxRetries: 4,
    });

    expect(draft.enabled).toBe(false);
    expect(buildDetectionConfig(draft)).toBeNull();
  });

  it("expands agent model routes into fixed UI rows and saves only selected models", () => {
    const rows = fixedAgentOverrideRows({
      writer: "agnes-2.0-flash",
      auditor: { model: "deepseek-chat", baseUrl: "https://api.example.com/v1" },
      unknown: "ignored-model",
    });

    expect(rows.map((row) => row.agent)).toEqual(["architect", "writer", "auditor", "reviser", "exporter", "play"]);
    expect(rows.find((row) => row.agent === "writer")?.model).toBe("agnes-2.0-flash");
    expect(rows.find((row) => row.agent === "auditor")?.rest).toEqual({ baseUrl: "https://api.example.com/v1" });

    expect(buildAgentModelOverrides(rows)).toEqual({
      writer: "agnes-2.0-flash",
      auditor: { model: "deepseek-chat", baseUrl: "https://api.example.com/v1" },
    });
  });

  it("keeps the configured service together with each selected agent model", () => {
    const rows = fixedAgentOverrideRows({
      writer: { service: "custom:Novel API", model: "novel-pro" },
    });

    expect(rows.find((row) => row.agent === "writer")).toMatchObject({
      service: "custom:Novel API",
      model: "novel-pro",
    });
    expect(buildAgentModelOverrides(rows)).toEqual({
      writer: { service: "custom:Novel API", model: "novel-pro" },
    });
  });

  it("round-trips service and model through the select option value", () => {
    const value = modelRouteValue("custom:中文服务", "model/name:latest");
    expect(parseModelRouteValue(value)).toEqual({
      service: "custom:中文服务",
      model: "model/name:latest",
    });
  });

  it("normalizes double-encoded custom service ids before saving model routes", () => {
    const doubleEncoded = `${encodeURIComponent(encodeURIComponent("custom:中文服务"))}::${encodeURIComponent("novel-pro")}`;

    expect(parseModelRouteValue(doubleEncoded)).toEqual({
      service: "custom:中文服务",
      model: "novel-pro",
    });
    expect(buildAgentModelOverrides([
      { agent: "writer", service: "custom%3A中文服务", model: "novel-pro" },
    ])).toEqual({
      writer: { service: "custom:中文服务", model: "novel-pro" },
    });
  });
});
