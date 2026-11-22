/**
 * GIAI ĐOẠN 5 - KỸ SƯ 1: RATE LIMITING TẠI BIÊN, BĂM IP SHA-256 & KHÓA NGÂN SÁCH FINOPS
 */
import { getTodayKey } from "./db_service.js";

// 1. Lấy địa chỉ IP thực từ Header chuẩn của Cloudflare Edge
export function getClientIp(request) {
  return (
    request.headers.get("CF-Connecting-IP") ||
    request.headers.get("X-Forwarded-For")?.split(",")[0]?.trim() ||
    "127.0.0.1"
  );
}

// 2. Băm một chiều địa chỉ IP bằng SHA-256 (Web Crypto API) kèm muối theo ngày để bảo vệ quyền riêng tư
export async function hashClientIp(ip, dayKey) {
  const encoder = new TextEncoder();
  const data = encoder.encode(`cloudscholar-salt:${dayKey}:${ip}`);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

// 3. Kiểm tra Rate Limiting ngay tại RAM của Edge PoP (0 lượt đọc/ghi D1)
export async function checkEdgeRateLimit(limiterBinding, key) {
  if (!limiterBinding || typeof limiterBinding.limit !== "function") {
    return { allowed: true };
  }
  const { success } = await limiterBinding.limit({ key });
  return { allowed: Boolean(success) };
}

// 4. Kiểm tra và giữ chỗ ngân sách AI kép (Theo từng IP/ngày & Toàn hệ thống/ngày)
export async function verifyAndConsumeAiBudget(env, clientIp) {
  const day = getTodayKey();
  const ipHash = await hashClientIp(clientIp, day);
  const dailyBudget = Number(env.DAILY_AI_BUDGET || 50);
  const perIpLimit = Number(env.PER_IP_DAILY_AI_LIMIT || 5);

  const [globalRow, ipRow] = await env.DB.batch([
    env.DB.prepare("SELECT ai_calls FROM usage_daily WHERE day = ?1").bind(day),
    env.DB.prepare("SELECT ai_calls FROM ip_daily_usage WHERE day = ?1 AND ip_hash = ?2").bind(day, ipHash),
  ]);

  const currentGlobalCalls = globalRow.results?.[0]?.ai_calls || 0;
  const currentIpCalls = ipRow.results?.[0]?.ai_calls || 0;

  if (currentGlobalCalls >= dailyBudget) {
    return {
      allowed: false,
      code: "daily_budget_exceeded",
      message: `Hệ thống đã đạt trần ngân sách AI an toàn trong ngày (${dailyBudget} lượt/ngày). Bạn vẫn có thể xem các bài báo đã có trong Cache.`,
    };
  }

  if (currentIpCalls >= perIpLimit) {
    return {
      allowed: false,
      code: "ip_daily_limit_exceeded",
      message: `Mỗi địa chỉ mạng chỉ được phân tích mới tối đa ${perIpLimit} bài báo/ngày để bảo vệ tài nguyên chung.`,
    };
  }

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO ip_daily_usage (day, ip_hash, ai_calls) VALUES (?1, ?2, 1)
       ON CONFLICT(day, ip_hash) DO UPDATE SET ai_calls = ai_calls + 1`
    ).bind(day, ipHash),
    env.DB.prepare(
      `INSERT INTO usage_daily (day, ai_calls) VALUES (?1, 1)
       ON CONFLICT(day) DO UPDATE SET ai_calls = ai_calls + 1`
    ).bind(day),
  ]);

  return {
    allowed: true,
    global_used: currentGlobalCalls + 1,
    ip_used: currentIpCalls + 1,
  };
}