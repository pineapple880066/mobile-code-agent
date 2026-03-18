import path from "node:path";

/**
 * 解析端口号
 * @param value - 环境变量中的端口值
 * @param fallback - 如果解析失败使用的默认值
 * @returns 有效的端口号
 */
function parsePort(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * 返回第一个非空字符串
 * @param values - 要检查的字符串数组
 * @returns 第一个非空字符串，或空字符串
 */
function firstNonBlank(...values: Array<string | undefined>): string {
  for (const value of values) {
    if (value?.trim()) {
      return value.trim();
    }
  }

  return "";
}

/**
 * LLM 聊天配置
 */
export type ChatConfig = {
  apiKey: string;      // API 密钥
  baseUrl: string;     // API 基础 URL
  model: string;       // 模型名称
};

/**
 * 向量嵌入配置（可选，未配置时为 null）
 */
export type EmbeddingConfig = {
  apiKey: string;      // API 密钥
  baseUrl: string;     // API 基础 URL
  model: string;       // 模型名称
} | null;

/**
 * 服务器配置
 */
export type ServerConfig = {
  host: string;              // 监听地址
  port: number;              // 服务器端口
  workspaceRoot: string;     // 工作区根目录
  authToken: string | null;  // 认证令牌（可选）
};

/**
 * 解析工作区根目录
 * @param defaultRoot - 默认根目录，默认为当前工作目录
 * @returns 解析后的绝对路径
 */
export function resolveWorkspaceRoot(defaultRoot = process.cwd()): string {
  return path.resolve(process.env.CODE_AGENT_WORKSPACE?.trim() || defaultRoot);
}

/**
 * 解析 LLM 聊天配置
 * 支持多种环境变量命名 convention，按优先级查找：
 * - CHAT_API_KEY / CODE_AGENT_API_KEY / MINIMAX_API_KEY / OPENAI_API_KEY
 * - CHAT_BASE_URL / CODE_AGENT_BASE_URL / OPENAI_BASE_URL
 * - CHAT_MODEL / CODE_AGENT_MODEL / OPENAI_MODEL
 * @returns 聊天配置对象
 * @throws 如果缺少 API key 则抛出错误
 */
export function resolveChatConfig(): ChatConfig {
  const apiKey = firstNonBlank(
    process.env.CHAT_API_KEY,
    process.env.CODE_AGENT_API_KEY,
    process.env.MINIMAX_API_KEY,
    process.env.OPENAI_API_KEY,
  );

  if (!apiKey.trim()) {
    throw new Error(
      "Missing chat API key. Set CHAT_API_KEY, MINIMAX_API_KEY, CODE_AGENT_API_KEY, or OPENAI_API_KEY.",
    );
  }

  return {
    apiKey,
    baseUrl: firstNonBlank(
      process.env.CHAT_BASE_URL,
      process.env.CODE_AGENT_BASE_URL,
      process.env.OPENAI_BASE_URL,
      "https://api.minimaxi.com/v1",
    ).replace(/\/+$/, ""),
    model: firstNonBlank(
      process.env.CHAT_MODEL,
      process.env.CODE_AGENT_MODEL,
      process.env.OPENAI_MODEL,
      "MiniMax-M2.5",
    ),
  };
}

/**
 * 解析向量嵌入配置
 * 需要 EMBEDDING_MODEL、EMBEDDING_API_KEY、EMBEDDING_BASE_URL 全部配置才会启用
 * @returns 嵌入配置对象，如果环境变量不完整则返回 null
 */
export function resolveEmbeddingConfig(): EmbeddingConfig {
  const model = process.env.EMBEDDING_MODEL?.trim();
  const apiKey = process.env.EMBEDDING_API_KEY?.trim();
  const baseUrl = process.env.EMBEDDING_BASE_URL?.trim();

  if (!model || !apiKey || !baseUrl) {
    return null;
  }

  return {
    apiKey,
    baseUrl: baseUrl.replace(/\/+$/, ""),
    model,
  };
}

/**
 * 解析服务器配置
 * @param workspaceRoot - 工作区根目录，默认通过 resolveWorkspaceRoot() 自动解析
 * @returns 服务器配置对象
 */
export function resolveServerConfig(workspaceRoot = resolveWorkspaceRoot()): ServerConfig {
  return {
    host: firstNonBlank(process.env.CODE_AGENT_HOST, process.env.HOST, "127.0.0.1"),
    port: parsePort(process.env.CODE_AGENT_PORT, 3000),
    workspaceRoot: path.resolve(workspaceRoot),
    authToken: process.env.CODE_AGENT_AUTH_TOKEN?.trim() || null,
  };
}
