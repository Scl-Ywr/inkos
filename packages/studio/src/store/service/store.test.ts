import { beforeEach, describe, expect, it, vi } from "vitest";
import { useServiceStore } from "./store";
import { fetchJson } from "../../hooks/use-api";

vi.mock("../../hooks/use-api", () => ({
  fetchJson: vi.fn(),
}));

const fetchJsonMock = vi.mocked(fetchJson);

describe("useServiceStore", () => {
  beforeEach(() => {
    fetchJsonMock.mockReset();
    useServiceStore.setState({
      services: [],
      servicesLoading: false,
      modelsByService: {},
      bankModelsLoading: false,
      customModelsLoading: false,
      liveModelsLoading: {},
    });
  });

  it("prunes cached models for providers that are no longer connected", async () => {
    useServiceStore.setState({
      services: [
        { service: "openai", label: "OpenAI", connected: true },
        { service: "moonshot", label: "Moonshot", connected: true },
      ],
      modelsByService: {
        openai: [{ id: "gpt-old" }],
        moonshot: [{ id: "kimi-live" }],
      },
    });
    fetchJsonMock.mockResolvedValueOnce({
      services: [
        { service: "openai", label: "OpenAI", connected: false },
        { service: "moonshot", label: "Moonshot", connected: true },
      ],
    });

    await useServiceStore.getState().refreshServices();

    expect(useServiceStore.getState().modelsByService).toEqual({
      moonshot: [{ id: "kimi-live" }],
    });
  });
});
