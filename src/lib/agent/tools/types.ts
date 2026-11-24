export interface OpenAiToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ToolExecutionOutcome {
  ok: boolean;
  /**
   * 仅当外部服务超时、断连、401/403/429/5xx 或协议损坏时为 true。
   * 业务无结果、参数不合法等必须为 false，避免误触发熔断。
   */
  infrastructureFailure: boolean;
  content: string;
  error?: string;
}

export interface RegisteredTool {
  pluginId: string;
  pluginName: string;
  functionName: string;
  definition: OpenAiToolDefinition;
  execute: (args: Record<string, unknown>) => Promise<ToolExecutionOutcome>;
}
