import type { LanguageModelV4 } from "@ai-sdk/provider";
import { asSchema, type FlexibleSchema } from "ai";
import { env } from "@/env";
import { SafeError } from "@/utils/error";
import { Provider } from "@/utils/llms/config";

type CliProvider = string;

type CliProviderModule = Record<string, unknown>;

type CliModelFactory = (
  modelName: string,
  settings?: Record<string, unknown>,
) => LanguageModelV4;

type McpBridgedTool = {
  description?: string;
  inputSchema: FlexibleSchema<unknown>;
  execute?: (input: never, options?: unknown) => unknown;
};

type McpBridgeFactory = (
  name: string,
  tools: Record<string, McpBridgedTool>,
) => unknown;

type CodexMcpServer = {
  config: unknown;
  stop: () => Promise<void>;
};

type CodexMcpTool = {
  name: string;
  description: string;
  inputSchema: unknown;
  execute: (input: unknown) => Promise<unknown>;
};

type CodexMcpServerFactory = (options: {
  name: string;
  tools: CodexMcpTool[];
}) => Promise<CodexMcpServer>;

type CodexAppServerProvider = CliModelFactory & { close: () => Promise<void> };

type CodexAppServerFactory = (options: {
  defaultSettings: Record<string, unknown>;
}) => CodexAppServerProvider;

const runtimeImport = (specifier: string): Promise<CliProviderModule> =>
  import(/* webpackIgnore: true */ specifier);

const CLAUDE_CODE_PACKAGE = "ai-sdk-provider-claude-code";
const CLAUDE_CODE_MCP_SERVER_NAME = "inboxzero";

export function assertCliLlmEnabled(provider: CliProvider) {
  if (env.CLI_LLM_ENABLED) return;

  throw new SafeError(
    `CLI LLM provider "${provider}" is disabled. Set CLI_LLM_ENABLED=true and install the matching community provider package to use it.`,
  );
}

export function createCliLanguageModel({
  provider,
  modelName,
}: {
  provider: CliProvider;
  modelName: string;
}): LanguageModelV4 {
  assertCliLlmEnabled(provider);

  let modelPromise: Promise<LanguageModelV4> | undefined;

  const getModel = () => {
    modelPromise ??= loadCliLanguageModel({ provider, modelName });
    return modelPromise;
  };

  return {
    specificationVersion: "v4",
    provider,
    modelId: modelName,
    supportedUrls: {},
    async doGenerate(...args: unknown[]) {
      const model = await getModel();
      const doGenerate = getModelMethod(model, "doGenerate", provider);
      return doGenerate(...args);
    },
    async doStream(...args: unknown[]) {
      const model = await getModel();
      const doStream = getModelMethod(model, "doStream", provider);
      return doStream(...args);
    },
  } as unknown as LanguageModelV4;
}

// AI SDK tools cannot be auto-bridged at the LanguageModelV4 layer: by the
// time the wrapper sees them they have been reduced to JSON schemas with no
// `execute`. Callers that pass tools must therefore use this helper, which
// wires the original tool record through `createAiSdkMcpServer` so the
// Claude Code CLI can invoke them locally over MCP.
export async function createClaudeCodeLanguageModelWithBridgedTools({
  modelName,
  tools,
}: {
  modelName: string;
  tools: Record<string, McpBridgedTool>;
}): Promise<LanguageModelV4> {
  assertCliLlmEnabled(Provider.CLAUDE_CODE);

  const module = await importOptionalProviderPackage(
    CLAUDE_CODE_PACKAGE,
    Provider.CLAUDE_CODE,
  );
  const claudeCode = getFactory(module, "claudeCode", Provider.CLAUDE_CODE);
  const createBridge = getFactory(
    module,
    "createAiSdkMcpServer",
    Provider.CLAUDE_CODE,
  ) as McpBridgeFactory;

  const toolNames = Object.keys(tools);
  if (toolNames.length === 0) return createClaudeCodeLanguageModel(modelName);

  const mcpServer = createBridge(CLAUDE_CODE_MCP_SERVER_NAME, tools);
  const allowedTools = toolNames.map((name) => prefixToolName(name));

  const inner = claudeCode(modelName, {
    settingSources: [],
    allowedTools,
    mcpServers: { [CLAUDE_CODE_MCP_SERVER_NAME]: mcpServer },
    permissionMode: "default",
    sandbox: { enabled: true },
  });

  return wrapWithUnprefixedToolNames(inner);
}

export async function createCodexLanguageModelWithBridgedTools({
  modelName,
  tools,
}: {
  modelName: string;
  tools: Record<string, McpBridgedTool>;
}): Promise<LanguageModelV4> {
  assertCliLlmEnabled(Provider.CODEX_CLI);
  const module = await importOptionalProviderPackage(
    "ai-sdk-provider-codex-cli",
    Provider.CODEX_CLI,
  );
  // Optional package exports are checked for callability by getFactory.
  const createAppServer = getFactory(
    module,
    "createCodexAppServer",
    Provider.CODEX_CLI,
  ) as unknown as CodexAppServerFactory;
  const createServer = getFactory(
    module,
    "createLocalMcpServer",
    Provider.CODEX_CLI,
  ) as unknown as CodexMcpServerFactory;
  const schemas = await Promise.all(
    Object.entries(tools).map(async ([name, tool]) => {
      if (!tool.execute) {
        throw new SafeError(`Codex MCP tool "${name}" requires an executor.`);
      }
      const schema = asSchema(tool.inputSchema);
      return { name, tool, schema, inputSchema: await schema.jsonSchema };
    }),
  );

  const openModel = async (
    options: Parameters<LanguageModelV4["doStream"]>[0],
  ) => {
    const server = await createServer({
      name: "inboxzero",
      tools: schemas.map(({ name, tool, schema, inputSchema }) => ({
        name,
        description: tool.description ?? name,
        inputSchema,
        async execute(input) {
          options.abortSignal?.throwIfAborted();
          const validated = await schema.validate?.(input);
          if (validated && !validated.success) throw validated.error;
          return await tool.execute!(
            (validated?.success ? validated.value : input) as never,
            {
              toolCallId: crypto.randomUUID(),
              messages: options.prompt,
              abortSignal: options.abortSignal,
            },
          );
        },
      })),
    });
    let provider: CodexAppServerProvider | undefined;
    try {
      provider = createAppServer({
        defaultSettings: {
          approvalPolicy: "on-request",
          sandboxPolicy: "read-only",
          ...(env.CODEX_CLI_PATH ? { codexPath: env.CODEX_CLI_PATH } : {}),
          mcpServers: { inboxzero: server.config },
          autoApprove: false,
          serverRequests: {
            onMcpElicitation: async ({
              params,
            }: {
              params: {
                serverName: string;
                _meta?: Record<string, unknown>;
              };
            }) =>
              params.serverName === "inboxzero" &&
              params._meta?.codex_approval_kind === "mcp_tool_call"
                ? { action: "accept", content: {} }
                : { action: "decline", content: null },
          },
          logger: false,
        },
      });
      const model = provider(modelName);
      const close = async () => {
        try {
          await provider!.close();
        } finally {
          await server.stop();
        }
      };
      return { model, close };
    } catch (error) {
      await server.stop();
      await provider?.close();
      throw error;
    }
  };

  return {
    specificationVersion: "v4",
    provider: Provider.CODEX_CLI,
    modelId: modelName,
    supportedUrls: {},
    async doGenerate(options) {
      const { model, close } = await openModel(options);
      try {
        const result = await model.doGenerate(options);
        const callNames = new Map<string, string>();
        return {
          ...result,
          content: result.content.map((part) =>
            normalizeCodexToolPart(part, tools, callNames),
          ),
        };
      } finally {
        await close();
      }
    },
    async doStream(options) {
      const abortController = new AbortController();
      const abortSignal = options.abortSignal
        ? AbortSignal.any([options.abortSignal, abortController.signal])
        : abortController.signal;
      const { model, close } = await openModel({ ...options, abortSignal });
      try {
        const result = await model.doStream({ ...options, abortSignal });
        const reader = result.stream.getReader();
        const callNames = new Map<string, string>();
        let closed = false;
        const stop = async () => {
          if (closed) return;
          closed = true;
          await close();
        };
        return {
          ...result,
          stream: new ReadableStream({
            async pull(controller) {
              try {
                const { done, value } = await reader.read();
                if (done) {
                  await stop();
                  controller.close();
                } else {
                  controller.enqueue(
                    normalizeCodexToolPart(value, tools, callNames),
                  );
                }
              } catch (error) {
                await stop();
                controller.error(error);
              }
            },
            async cancel(reason) {
              abortController.abort(reason);
              try {
                await reader.cancel(reason);
              } finally {
                await stop();
              }
            },
          }),
        };
      } catch (error) {
        abortController.abort(error);
        await close();
        throw error;
      }
    },
  } as LanguageModelV4;
}

function normalizeCodexToolPart<T>(
  part: T,
  tools: Record<string, McpBridgedTool>,
  callNames: Map<string, string>,
): T {
  const value = part as Record<string, unknown>;
  const toolName =
    typeof value.toolName === "string"
      ? value.toolName.replace(/^mcp__inboxzero__/, "")
      : typeof value.id === "string"
        ? callNames.get(value.id)
        : undefined;
  if (!toolName || !Object.hasOwn(tools, toolName)) return part;
  if (value.type === "tool-input-start" && typeof value.id === "string") {
    callNames.set(value.id, toolName);
  }
  if (value.type === "tool-input-delta" || value.type === "tool-call") {
    const field = value.type === "tool-call" ? "input" : "delta";
    const payload = JSON.parse(value[field] as string);
    return {
      ...value,
      ...(value.toolName ? { toolName } : {}),
      [field]: JSON.stringify(payload.arguments),
    } as T;
  }
  if (value.type === "tool-result") {
    const payload = value.result as {
      result?: {
        content?: { type: string; text?: string }[];
        isError?: boolean;
      };
      error?: unknown;
    };
    const text = payload.result?.content
      ?.filter((item) => item.type === "text")
      .map((item) => item.text ?? "")
      .join("\n");
    let result: unknown = text ?? payload.error;
    if (text) {
      try {
        result = JSON.parse(text);
      } catch {
        // MCP permits plain-text results as well as JSON.
      }
    }
    return {
      ...value,
      toolName,
      result,
      ...(payload.error || payload.result?.isError ? { isError: true } : {}),
    } as T;
  }
  return value.toolName ? ({ ...value, toolName } as T) : part;
}

const TOOL_NAME_PREFIX = `mcp__${CLAUDE_CODE_MCP_SERVER_NAME}__`;

function prefixToolName(name: string): string {
  return `${TOOL_NAME_PREFIX}${name}`;
}

function unprefixToolName(name: string): string {
  return name.startsWith(TOOL_NAME_PREFIX)
    ? name.slice(TOOL_NAME_PREFIX.length)
    : name;
}

// The MCP bridge causes the Claude Code CLI to surface tool calls as
// `mcp__inboxzero__<name>`. Inbox Zero callers (stop conditions, UI part
// renderers, validators) match on the original tool names, so the prefix is
// stripped from every `toolName` field in both the non-streaming and
// streaming response paths before it reaches the AI SDK consumer.
function wrapWithUnprefixedToolNames(model: LanguageModelV4): LanguageModelV4 {
  const wrapped = {
    specificationVersion: model.specificationVersion,
    provider: model.provider,
    modelId: model.modelId,
    supportedUrls: model.supportedUrls,
    async doGenerate(...args: unknown[]) {
      const doGenerate = getModelMethod(
        model,
        "doGenerate",
        Provider.CLAUDE_CODE,
      );
      const result = (await doGenerate(...args)) as {
        content?: unknown[];
      } & Record<string, unknown>;
      return {
        ...result,
        ...(Array.isArray(result.content)
          ? { content: result.content.map(unprefixPart) }
          : {}),
      };
    },
    async doStream(...args: unknown[]) {
      const doStream = getModelMethod(model, "doStream", Provider.CLAUDE_CODE);
      const result = (await doStream(...args)) as {
        stream: ReadableStream<unknown>;
      } & Record<string, unknown>;
      const stream = result.stream.pipeThrough(
        new TransformStream({
          transform(chunk, controller) {
            controller.enqueue(unprefixPart(chunk));
          },
        }),
      );
      return { ...result, stream };
    },
  };
  return wrapped as unknown as LanguageModelV4;
}

function unprefixPart(part: unknown): unknown {
  if (!part || typeof part !== "object") return part;
  const record = part as Record<string, unknown>;
  if (typeof record.toolName !== "string") return part;
  return { ...record, toolName: unprefixToolName(record.toolName) };
}

async function loadCliLanguageModel({
  provider,
  modelName,
}: {
  provider: CliProvider;
  modelName: string;
}): Promise<LanguageModelV4> {
  switch (provider) {
    case Provider.CODEX_CLI:
      return createCodexCliLanguageModel(modelName);
    case Provider.CLAUDE_CODE:
      return createClaudeCodeLanguageModel(modelName);
    default:
      throw new SafeError(`Unsupported CLI LLM provider: ${provider}`);
  }
}

async function createCodexCliLanguageModel(modelName: string) {
  const module = await importOptionalProviderPackage(
    "ai-sdk-provider-codex-cli",
    Provider.CODEX_CLI,
  );
  const codexExec = getFactory(module, "codexExec", Provider.CODEX_CLI);

  return codexExec(modelName, {
    allowNpx: env.CODEX_CLI_ALLOW_NPX,
    skipGitRepoCheck: true,
    approvalMode: "never",
    sandboxMode: "read-only",
    ...(env.CODEX_CLI_PATH ? { codexPath: env.CODEX_CLI_PATH } : {}),
    logger: false,
  });
}

async function createClaudeCodeLanguageModel(modelName: string) {
  const module = await importOptionalProviderPackage(
    CLAUDE_CODE_PACKAGE,
    Provider.CLAUDE_CODE,
  );
  const claudeCode = getFactory(module, "claudeCode", Provider.CLAUDE_CODE);

  return claudeCode(modelName, {
    settingSources: [],
    allowedTools: [],
    permissionMode: "default",
    sandbox: { enabled: true },
  });
}

async function importOptionalProviderPackage(
  packageName: string,
  provider: CliProvider,
) {
  try {
    return await runtimeImport(packageName);
  } catch (error) {
    const message = isMissingOptionalPackageError(error, packageName)
      ? `CLI LLM provider "${provider}" requires optional package "${packageName}". Install it in apps/web and pin an exact version before enabling this provider.`
      : `CLI LLM provider "${provider}" failed to load optional package "${packageName}". Check the installed package version and peer dependencies.`;
    const safeError = new SafeError(message);
    (safeError as Error & { cause?: unknown }).cause = error;
    throw safeError;
  }
}

function getFactory(
  module: CliProviderModule,
  exportName: string,
  provider: CliProvider,
): CliModelFactory {
  const factory = module[exportName];

  if (typeof factory !== "function") {
    throw new SafeError(
      `CLI LLM provider "${provider}" package does not export "${exportName}". Check the installed package version.`,
    );
  }

  return factory as CliModelFactory;
}

function getModelMethod(
  model: LanguageModelV4,
  methodName: "doGenerate" | "doStream",
  provider: CliProvider,
) {
  const method = model[methodName];

  if (typeof method !== "function") {
    throw new SafeError(
      `CLI LLM provider "${provider}" returned a model without ${methodName}. Check the installed package version.`,
    );
  }

  return method.bind(model) as (...args: unknown[]) => unknown;
}

function isMissingOptionalPackageError(error: unknown, packageName: string) {
  if (!(error instanceof Error)) return false;

  const code = (error as Error & { code?: string }).code;
  return code === "ERR_MODULE_NOT_FOUND" && error.message.includes(packageName);
}
