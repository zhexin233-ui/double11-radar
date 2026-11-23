import { z } from "zod";

/**
 * 服务端环境变量读取与校验。
 *
 * 该模块只允许在服务端（Node.js runtime）使用。不要在模块顶层执行 `loadEnv()`，
 * 否则测试无法在 import 之后注入 process.env；请始终调用函数获得结果。
 */

/** 已解析并校验通过的应用环境。 */
export interface AppEnv {
  /** 持久化目录。 */
  dataDir: string;
  /** AES-256-GCM 使用的 32 字节密钥。 */
  encryptionKey: Buffer;
  /** 管理员明文密码（来自部署配置，仅用于生成/校验哈希）。 */
  adminPassword: string;
  /** Cookie 是否加 Secure。 */
  cookieSecure: boolean;
  /** 线报酷 API 基地址。 */
  xianbaoApiBase: string;
}

const RawEnvSchema = z.object({
  DATA_DIR: z.string().optional(),
  APP_ENCRYPTION_KEY: z.string().optional(),
  ADMIN_PASSWORD: z.string().optional(),
  COOKIE_SECURE: z.string().optional(),
  XIANBAO_API_BASE: z.string().optional(),
});

/** 允许注入的环境来源，默认 process.env。 */
export type EnvSource = Record<string, string | undefined>;

/** Jev 专用 HTTP CONNECT 代理；空值表示直连，非法配置必须阻止请求。 */
export function getJevProxyUrl(source: EnvSource = process.env): string | undefined {
  const value = source.JEV_PROXY_URL?.trim();
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
      throw new Error();
    }
    return url.href;
  } catch {
    throw new Error("JEV_PROXY_URL 必须是无认证信息的 HTTP 或 HTTPS 代理地址");
  }
}

const DEFAULT_DATA_DIR = "/data";
const DEFAULT_XIANBAO_API_BASE = "https://new.xianbao.fun";

function isTruthy(value: string | undefined): boolean {
  if (!value) return false;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

/**
 * 解析 base64 字符串为 Buffer，并强制要求解码后正好 32 字节。
 * `Buffer.from(x, 'base64')` 对非法输入很宽容，这里先做正则与长度双重校验。
 */
export function decodeEncryptionKey(raw: string): Buffer {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new Error("环境变量 APP_ENCRYPTION_KEY 不能为空");
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(trimmed)) {
    throw new Error("环境变量 APP_ENCRYPTION_KEY 必须是合法的 base64 字符串");
  }
  const key = Buffer.from(trimmed, "base64");
  if (key.length !== 32) {
    throw new Error(
      `环境变量 APP_ENCRYPTION_KEY 解码后必须为 32 字节（当前 ${key.length} 字节），可用 \`openssl rand -base64 32\` 生成`,
    );
  }
  return key;
}

/**
 * 读取并校验环境变量。缺失或非法时抛出中文错误，调用方应记录后退出。
 */
export function loadEnv(source: EnvSource = process.env): AppEnv {
  const parsed = RawEnvSchema.safeParse(source);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new Error(`环境变量格式不合法：${detail}`);
  }
  const raw = parsed.data;

  const dataDir = raw.DATA_DIR?.trim() || DEFAULT_DATA_DIR;

  const adminPassword = raw.ADMIN_PASSWORD;
  if (adminPassword === undefined || adminPassword.length === 0) {
    throw new Error("缺少必需环境变量 ADMIN_PASSWORD（管理员登录密码）");
  }

  const rawKey = raw.APP_ENCRYPTION_KEY;
  if (rawKey === undefined || rawKey.trim().length === 0) {
    throw new Error(
      "缺少必需环境变量 APP_ENCRYPTION_KEY（32 字节 base64 密钥，可用 `openssl rand -base64 32` 生成）",
    );
  }
  const encryptionKey = decodeEncryptionKey(rawKey);

  return {
    dataDir,
    encryptionKey,
    adminPassword,
    cookieSecure: isTruthy(raw.COOKIE_SECURE),
    xianbaoApiBase: raw.XIANBAO_API_BASE?.trim() || DEFAULT_XIANBAO_API_BASE,
  };
}
