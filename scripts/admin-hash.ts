import { hashPassword } from "../src/lib/auth/password";

/**
 * 打印 ADMIN_PASSWORD 的 scrypt 哈希（JSON），便于部署时核对。
 * 用法：`ADMIN_PASSWORD=xxx pnpm admin:hash`
 */
const password = process.env.ADMIN_PASSWORD;
if (!password) {
  console.error("缺少环境变量 ADMIN_PASSWORD");
  process.exit(1);
}

console.log(JSON.stringify(hashPassword(password), null, 2));
