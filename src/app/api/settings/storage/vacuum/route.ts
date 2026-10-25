import { handleRoute, ok, requireSameOrigin } from "@/lib/http/json";
import { requireAuth } from "@/lib/http/server";
import { vacuumDatabase } from "@/lib/service/storage";

export const POST = handleRoute(async (req) => {
  requireSameOrigin(req);
  const db = requireAuth(req);
  const result = vacuumDatabase(db);
  return ok(result);
});
