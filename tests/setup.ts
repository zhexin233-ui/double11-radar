import os from "node:os";
import path from "node:path";

/**
 * 测试环境变量。
 *
 * 默认测试密钥为 32 字节全 7（与 tests/helpers/db.ts 的 testKey(7) 一致），
 * 这样不带显式 key 的配置读写也能在测试中工作。
 */
process.env.DATA_DIR = process.env.DATA_DIR ?? path.join(os.tmpdir(), "xianbao-env");
process.env.APP_ENCRYPTION_KEY =
  process.env.APP_ENCRYPTION_KEY ?? Buffer.alloc(32, 7).toString("base64");
process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? "test-password";
