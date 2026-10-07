import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { Provider } from "./config";

describe("createCliLanguageModel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  afterEach(() => {
    vi.doUnmock("@/env");
    vi.doUnmock("ai-sdk-provider-codex-cli");
    vi.doUnmock("ai-sdk-provider-claude-code");
  });

  it("bridges AI SDK tools to Claude Code through MCP", async () => {
    const doGenerate = vi.fn().mockResolvedValue({
      content: [
        {
          type: "tool-call",
          toolName: "mcp__inboxzero__searchInbox",
          input: { query: "hello" },
        },
      ],
    });
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue({
          type: "tool-call",
          toolName: "mcp__inboxzero__createRule",
          input: { label: "later" },
        });
        controller.close();
      },
    });
    const doStream = vi.fn().mockResolvedValue({ stream });
    const innerModel = {
      specificationVersion: "v4",
      provider: "claude-code",
      modelId: "sonnet",
      supportedUrls: {},
      doGenerate,
      doStream,
    };
    const claudeCode = vi.fn(() => innerModel);
    const mcpServer = { type: "mcp-server" };
    const createAiSdkMcpServer = vi.fn(() => mcpServer);
    const searchInbox = {
      description: "Search inbox",
      inputSchema: {},
      execute: vi.fn(),
    };
    const createRule = {
      description: "Create rule",
      inputSchema: {},
      execute: vi.fn(),
    };

    const { createClaudeCodeLanguageModelWithBridgedTools } =
      await loadCliProviderModule({
        claudeModule: { claudeCode, createAiSdkMcpServer },
      });

    const model = (await createClaudeCodeLanguageModelWithBridgedTools({
      modelName: "sonnet",
      tools: { searchInbox, createRule },
    })) as any;

    await expect(model.doGenerate("generate-request")).resolves.toEqual({
      content: [
        {
          type: "tool-call",
          toolName: "searchInbox",
          input: { query: "hello" },
        },
      ],
    });
    const streamResult = await model.doStream("stream-request");
    const reader = streamResult.stream.getReader();
    await expect(reader.read()).resolves.toEqual({
      done: false,
      value: {
        type: "tool-call",
        toolName: "createRule",
        input: { label: "later" },
      },
    });
  });

  it("rejects invalid MCP arguments before invoking an application tool", async () => {
    const executions: string[] = [];
    let invoke: (input: unknown) => Promise<unknown>;
    const stop = vi.fn();
    const { createCodexLanguageModelWithBridgedTools } =
      await loadCliProviderModule({
        codexModule: {
          createLocalMcpServer: async ({
            tools,
          }: {
            tools: { execute: (input: unknown) => Promise<unknown> }[];
          }) => {
            invoke = tools[0].execute;
            return { config: {}, stop };
          },
          createCodexAppServer: () =>
            fakeAppServer({
              async doGenerate() {
                await expect(invoke({ query: 42 })).rejects.toThrow();
                const result = await invoke({ query: "  invoices  " });
                return {
                  content: [{ type: "text", text: JSON.stringify(result) }],
                };
              },
            }),
        },
      });
    const model = await createCodexLanguageModelWithBridgedTools({
      modelName: "gpt-6-sol",
      tools: {
        searchInbox: {
          inputSchema: z.object({ query: z.string().trim() }),
          execute: async ({ query }: { query: string }) => {
            executions.push(query);
            return { matchedThreadIds: ["invoice-thread"] };
          },
        },
      },
    });

    const result = await model.doGenerate({ prompt: [] });
    expect(executions).toEqual(["invoices"]);
    expect(result.content).toEqual([
      { type: "text", text: '{"matchedThreadIds":["invoice-thread"]}' },
    ]);
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("preserves application tool arguments and outputs in streamed MCP events", async () => {
    const stop = vi.fn();
    const nativeParts = [
      { type: "tool-input-start", id: "call", toolName: "searchInbox" },
      {
        type: "tool-input-delta",
        id: "call",
        delta:
          '{"server":"inboxzero","tool":"searchInbox","arguments":{"query":"invoice"}}',
      },
      {
        type: "tool-call",
        toolCallId: "call",
        toolName: "searchInbox",
        input:
          '{"server":"inboxzero","tool":"searchInbox","arguments":{"query":"invoice"}}',
        providerExecuted: true,
      },
      {
        type: "tool-result",
        toolCallId: "call",
        toolName: "searchInbox",
        result: {
          server: "inboxzero",
          result: {
            content: [
              { type: "text", text: '{"threads":[{"id":"invoice-1"}]}' },
            ],
          },
        },
      },
    ];
    const { createCodexLanguageModelWithBridgedTools } =
      await loadCliProviderModule({
        codexModule: {
          createLocalMcpServer: async () => ({ config: {}, stop }),
          createCodexAppServer: () =>
            fakeAppServer({
              async doStream() {
                return {
                  stream: new ReadableStream({
                    start(controller) {
                      for (const part of nativeParts) controller.enqueue(part);
                      controller.close();
                    },
                  }),
                };
              },
            }),
        },
      });
    const model = await createCodexLanguageModelWithBridgedTools({
      modelName: "gpt-6-sol",
      tools: {
        searchInbox: {
          inputSchema: z.object({ query: z.string() }),
          execute: async () => ({}),
        },
      },
    });
    const { stream } = await model.doStream({ prompt: [] });
    const parts = [];
    for await (const part of stream) parts.push(part);

    expect(parts[1]).toMatchObject({ delta: '{"query":"invoice"}' });
    expect(parts[2]).toMatchObject({
      toolName: "searchInbox",
      input: '{"query":"invoice"}',
      providerExecuted: true,
    });
    expect(parts[3]).toMatchObject({
      toolName: "searchInbox",
      result: { threads: [{ id: "invoice-1" }] },
    });
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("aborts Codex and closes the MCP server when a consumer cancels", async () => {
    const stop = vi.fn();
    let signal: AbortSignal;
    const { createCodexLanguageModelWithBridgedTools } =
      await loadCliProviderModule({
        codexModule: {
          createLocalMcpServer: async () => ({ config: {}, stop }),
          createCodexAppServer: () =>
            fakeAppServer({
              async doStream(options: { abortSignal: AbortSignal }) {
                signal = options.abortSignal;
                return { stream: new ReadableStream() };
              },
            }),
        },
      });
    const model = await createCodexLanguageModelWithBridgedTools({
      modelName: "gpt-6-sol",
      tools: {
        searchInbox: {
          inputSchema: z.object({}),
          execute: async () => ({}),
        },
      },
    });
    const { stream } = await model.doStream({ prompt: [] });
    await stream.cancel("consumer disconnected");
    expect(signal!.aborted).toBe(true);
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("approves only tool-call elicitations from the account-scoped MCP server", async () => {
    type Elicitation = {
      params: {
        serverName: string;
        _meta?: { codex_approval_kind?: string };
      };
    };
    let approve: (request: Elicitation) => Promise<{ action: string }>;
    const { createCodexLanguageModelWithBridgedTools } =
      await loadCliProviderModule({
        codexModule: {
          createLocalMcpServer: async () => ({ config: {}, stop: vi.fn() }),
          createCodexAppServer: ({
            defaultSettings,
          }: {
            defaultSettings: {
              serverRequests: { onMcpElicitation: typeof approve };
            };
          }) => {
            approve = defaultSettings.serverRequests.onMcpElicitation;
            return fakeAppServer({
              async doGenerate() {
                await expect(
                  approve({
                    params: {
                      serverName: "inboxzero",
                      _meta: { codex_approval_kind: "mcp_tool_call" },
                    },
                  }),
                ).resolves.toMatchObject({ action: "accept" });
                await expect(
                  approve({
                    params: {
                      serverName: "other-server",
                      _meta: { codex_approval_kind: "mcp_tool_call" },
                    },
                  }),
                ).resolves.toMatchObject({ action: "decline" });
                await expect(
                  approve({
                    params: { serverName: "inboxzero" },
                  }),
                ).resolves.toMatchObject({ action: "decline" });
                return { content: [] };
              },
            });
          },
        },
      });
    const model = await createCodexLanguageModelWithBridgedTools({
      modelName: "gpt-6-sol",
      tools: {
        searchInbox: {
          inputSchema: z.object({}),
          execute: async () => ({}),
        },
      },
    });
    await model.doGenerate({ prompt: [] });
  });

  it("surfaces a clear error when the provider package is missing its factory export", async () => {
    const { createCliLanguageModel } = await loadCliProviderModule({
      codexModule: { codexExec: undefined },
    });

    const model = createCliLanguageModel({
      provider: Provider.CODEX_CLI,
      modelName: "gpt-5.3-codex",
    }) as any;

    await expect(model.doGenerate("generate-request")).rejects.toThrow(
      'CLI LLM provider "codex-cli" package does not export "codexExec". Check the installed package version.',
    );
  });

  it("surfaces a clear error when the loaded model is missing a required method", async () => {
    const codexExec = vi.fn(() => ({
      doGenerate: vi.fn(),
    }));

    const { createCliLanguageModel } = await loadCliProviderModule({
      codexModule: { codexExec },
    });

    const model = createCliLanguageModel({
      provider: Provider.CODEX_CLI,
      modelName: "gpt-5.3-codex",
    }) as any;

    await expect(model.doStream("stream-request")).rejects.toThrow(
      'CLI LLM provider "codex-cli" returned a model without doStream. Check the installed package version.',
    );
  });
});

async function loadCliProviderModule({
  envOverrides,
  codexModule,
  claudeModule,
}: {
  envOverrides?: Partial<{
    CLI_LLM_ENABLED: boolean;
    CODEX_CLI_ALLOW_NPX: boolean;
    CODEX_CLI_PATH: string | undefined;
  }>;
  codexModule?: Record<string, unknown>;
  claudeModule?: Record<string, unknown>;
} = {}) {
  vi.doMock("@/env", () => ({
    env: {
      CLI_LLM_ENABLED: true,
      CODEX_CLI_ALLOW_NPX: false,
      CODEX_CLI_PATH: undefined,
      ...envOverrides,
    },
  }));

  if (codexModule) {
    vi.doMock("ai-sdk-provider-codex-cli", () => codexModule);
  }

  if (claudeModule) {
    vi.doMock("ai-sdk-provider-claude-code", () => claudeModule);
  }

  return import("./cli-provider");
}

function fakeAppServer(model: object) {
  return Object.assign(() => model, { close: vi.fn() });
}
