import {
  listModelsForService,
  loadSecrets,
  resolveServiceModel,
  type AgentSessionConfig,
  type ProjectConfig,
} from "@actalk/inkos-core";
import {
  normalizeServiceConfig,
  serviceConfigKey,
  type ServiceConfigEntry,
} from "./service-config-utils.js";
import {
  filterTextChatModels,
  isTextChatModelId,
  resolveConfiguredServiceBaseUrl,
  resolveConfiguredServiceEntry,
} from "./service-runtime.js";

interface LegacyLLMClientSelection {
  readonly _piModel?: AgentSessionConfig["model"];
  readonly _apiKey?: string;
}

export interface AgentModelSelection {
  readonly model: AgentSessionConfig["model"];
  readonly apiKey?: string;
  readonly configuredEntry?: ServiceConfigEntry;
}

export class AgentModelApiKeyError extends Error {
  constructor(readonly service: string) {
    super(`Missing API key for ${service}`);
    this.name = "AgentModelApiKeyError";
  }
}

export async function resolveAgentModelSelection(args: {
  readonly root: string;
  readonly config: ProjectConfig;
  readonly reqService?: string;
  readonly reqModel?: string;
  readonly legacyClient: LegacyLLMClientSelection;
}): Promise<AgentModelSelection> {
  const { root, config, reqService, reqModel, legacyClient } = args;
  let resolvedModel: AgentSessionConfig["model"] | undefined;
  let resolvedApiKey: string | undefined;
  let explicitConfiguredEntry: ServiceConfigEntry | undefined;

  if (reqService && reqModel) {
    try {
      explicitConfiguredEntry = await resolveConfiguredServiceEntry(root, reqService);
      const resolved = await resolveServiceModel(
        reqService,
        reqModel,
        root,
        await resolveConfiguredServiceBaseUrl(root, reqService),
        explicitConfiguredEntry?.apiFormat,
      );
      resolvedModel = resolved.model;
      resolvedApiKey = resolved.apiKey;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/API key/i.test(message)) {
        throw new AgentModelApiKeyError(reqService);
      }
      throw error;
    }
  }

  if (!resolvedModel) {
    const rawConfig = config.llm as unknown as Record<string, unknown>;
    const defaultModel = rawConfig.defaultModel as string | undefined;
    const servicesArr = normalizeServiceConfig(rawConfig.services);
    const firstService = servicesArr[0];
    if (firstService?.service && defaultModel && isTextChatModelId(defaultModel)) {
      try {
        const resolved = await resolveServiceModel(
          serviceConfigKey(firstService),
          defaultModel,
          root,
          firstService.baseUrl,
          firstService.apiFormat,
        );
        resolvedModel = resolved.model;
        resolvedApiKey = resolved.apiKey;
      } catch {
        // Fall through to stored secrets.
      }
    }
  }

  if (!resolvedModel) {
    const secrets = await loadSecrets(root);
    for (const [serviceName, serviceData] of Object.entries(secrets.services)) {
      if (!serviceData?.apiKey) continue;
      try {
        const models = await listModelsForService(serviceName, serviceData.apiKey);
        const textModels = filterTextChatModels(models);
        if (textModels.length === 0) continue;
        const configuredEntry = await resolveConfiguredServiceEntry(root, serviceName);
        const resolved = await resolveServiceModel(
          serviceName,
          textModels[0].id,
          root,
          await resolveConfiguredServiceBaseUrl(root, serviceName),
          configuredEntry?.apiFormat,
        );
        resolvedModel = resolved.model;
        resolvedApiKey = resolved.apiKey;
        break;
      } catch {
        // Try next configured service.
      }
    }
  }

  if (!resolvedModel) {
    resolvedModel = legacyClient._piModel
      ? legacyClient._piModel
      : { provider: config.llm.provider ?? "anthropic", modelId: config.llm.model };
    resolvedApiKey = legacyClient._apiKey;
  }

  return {
    model: resolvedModel,
    apiKey: resolvedApiKey,
    configuredEntry: reqService
      ? explicitConfiguredEntry ?? await resolveConfiguredServiceEntry(root, reqService)
      : undefined,
  };
}
