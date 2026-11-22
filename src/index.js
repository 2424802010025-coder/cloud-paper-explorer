/**
 * GIAI ĐOẠN 6 (HOÀN CHỈNH BACKEND) - KỸ SƯ 1:
 * OPENALEX + CACHE D1 + WORKERS AI + BOOKMARKS + GRAPH + 8-LAYER SECURITY + W3C SERVER-TIMING
 */
import { searchOpenAlex, normalizeOpenAlexWork } from "./openalex.js";
import { upsertPapersBatch, formatPaperRow, recordDailyUsage, getTodayKey } from "./db_service.js";
import { isValidPaperId, analyzePaperWithFallback } from "./ai_service.js";
import {
  validateClientId,
  listBookmarks,
  saveBookmark,
  removeBookmark,
  getPaperCitationGraph,
} from "./features_service.js";
import {
  getClientIp,
  checkEdgeRateLimit,
  verifyAndConsumeAiBudget,
} from "./security_finops.js";
import { ServerTimingTracker } from "./timing.js";

function jsonResponse(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "strict-origin-when-cross-origin",
      ...extraHeaders,
    },
  });
}

function errorResponse(code, message, status = 400, extraHeaders = {}) {
  return jsonResponse({ error: { code, message } }, status, extraHeaders);
}

// 1. Tìm kiếm bài báo thật + Cache phân tầng TTL + Đo W3C Server-Timing
async function handleSearchRequest(url, env, ctx, timing) {
  const q = (url.searchParams.get("q") || "").trim().replace(/\s+/g, " ").toLowerCase();
  const fromYear = url.searchParams.get("from") || "2020";
  const toYear = url.searchParams.get("to") || "2026";
  const minCites = url.searchParams.get("min_cites") || "0";
  const sort = url.searchParams.get("sort") || "relevance_score:desc";
  const page = Math.max(1, Number(url.searchParams.get("page") || 1));

  const cacheKey = `q=${q}|from=${fromYear}|to=${toYear}|cites=${minCites}|sort=${sort}|p=${page}`;
  const nowSec = Math.floor(Date.now() / 1000);

  const cached = await timing.measure("d1_cache", "D1 Cache Lookup", () =>
    env.DB.prepare("SELECT paper_ids, total, created_at, ttl_sec FROM search_cache WHERE cache_key = ?1")
      .bind(cacheKey)
      .first()
  );

  if (cached && nowSec - cached.created_at < cached.ttl_sec) {
    const paperIds = JSON.parse(cached.paper_ids || "[]");
    let items = [];

    if (paperIds.length > 0) {
      const placeholders = paperIds.map((_, i) => `?${i + 1}`).join(",");
      const rows = await timing.measure("d1_papers", "D1 Papers Read", () =>
        env.DB.prepare(`SELECT * FROM papers WHERE paper_id IN (${placeholders})`)
          .bind(...paperIds)
          .all()
      );
      const mapById = new Map((rows.results || []).map((r) => [r.paper_id, formatPaperRow(r)]));
      items = paperIds.map((id) => mapById.get(id)).filter(Boolean);
    }

    ctx.waitUntil(recordDailyUsage(env.DB, { hits: 1, rowsRead: paperIds.length + 1 }));

    return {
      query: q,
      page,
      total: cached.total,
      cache_status: "HIT",
      ttl_sec: cached.ttl_sec,
      items,
    };
  }

  const oaData = await timing.measure("oa_fetch", "OpenAlex API Fetch", () =>
    searchOpenAlex({ q, fromYear, toYear, minCites, sort, page, apiKey: env.OPENALEX_API_KEY })
  );

  const normalized = (oaData.results || []).map(normalizeOpenAlexWork);
  const paperIds = normalized.map((p) => p.paper_id);
  const total = oaData.meta?.count || normalized.length;

  const currentYear = new Date().getUTCFullYear();
  const ttlSec = Number(toYear) < currentYear ? 7 * 86400 : 6 * 3600;

  const writeStats = await timing.measure("d1_write", "D1 Batch Upsert & Cache", async () => {
    const { rowsRead, rowsWritten } = await upsertPapersBatch(env.DB, normalized);
    const cacheWriteRes = await env.DB.prepare(
      `INSERT INTO search_cache (cache_key, paper_ids, total, created_at, ttl_sec)
       VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT(cache_key) DO UPDATE SET
         paper_ids = excluded.paper_ids, total = excluded.total,
         created_at = excluded.created_at, ttl_sec = excluded.ttl_sec`
    )
      .bind(cacheKey, JSON.stringify(paperIds), total, nowSec, ttlSec)
      .run();
    return { rowsRead, rowsWritten: rowsWritten + (cacheWriteRes.meta?.rows_written || 1) };
  });

  ctx.waitUntil(
    recordDailyUsage(env.DB, {
      oaCalls: 1,
      misses: 1,
      rowsRead: writeStats.rowsRead + 1,
      rowsWritten: writeStats.rowsWritten,
    })
  );

  return {
    query: q,
    page,
    total,
    cache_status: "MISS",
    ttl_sec: ttlSec,
    items: normalized.map(formatPaperRow),
  };
}

// 2. Phân tích AI thật qua AI Gateway + Bảo vệ Ngân sách Kép + Đo W3C Server-Timing
async function handleAnalysisRequest(paperId, method, clientIp, env, ctx, timing) {
  if (!isValidPaperId(paperId)) {
    return errorResponse("invalid_paper_id", "Mã bài báo không hợp lệ (phải có dạng W kèm chữ số).", 400);
  }

  const promptVersion = env.PROMPT_VERSION || "v1";
  const existing = await timing.measure("d1_ai_cache", "D1 Analysis Cache", () =>
    env.DB.prepare(
      "SELECT model, result_json, neurons_used, created_at FROM analyses WHERE paper_id = ?1 AND prompt_version = ?2"
    )
      .bind(paperId, promptVersion)
      .first()
  );

  if (existing) {
    const parsed = JSON.parse(existing.result_json);
    ctx.waitUntil(recordDailyUsage(env.DB, { hits: 1, rowsRead: 1 }));
    return jsonResponse(
      {
        paper_id: paperId,
        prompt_version: promptVersion,
        model: existing.model,
        cache_status: "HIT",
        ai_generated: true,
        disclaimer: "Nội dung tóm tắt và gợi ý đề tài do AI sinh tự động, cần đối chiếu văn bản gốc.",
        ...parsed,
      },
      200,
      { "Server-Timing": timing.toHeaderString() }
    );
  }

  if (method === "GET") {
    return errorResponse("analysis_not_found", "Bài báo này chưa có bản phân tích AI trong Cache.", 404);
  }

  const rl = await checkEdgeRateLimit(env.AI_RATE_LIMITER, `ai:${clientIp}`);
  if (!rl.allowed) {
    return errorResponse("rate_limited", "Bạn gọi phân tích AI quá nhanh (tối đa 5 lần/phút). Vui lòng thử lại sau.", 429);
  }

  const paper = await env.DB.prepare("SELECT paper_id, title, abstract FROM papers WHERE paper_id = ?1")
    .bind(paperId)
    .first();

  if (!paper) {
    return errorResponse("paper_not_found", `Không tìm thấy bài báo ${paperId} trong D1.`, 404);
  }
  if (!paper.abstract || paper.abstract.trim().length < 20) {
    return errorResponse("abstract_empty", "Bài báo này không có nội dung Abstract để phân tích.", 422);
  }

  const budgetCheck = await verifyAndConsumeAiBudget(env, clientIp);
  if (!budgetCheck.allowed) {
    return errorResponse(budgetCheck.code, budgetCheck.message, 429);
  }

  let aiOut;
  try {
    aiOut = await timing.measure("ai_infer", "Workers AI Inference", () =>
      analyzePaperWithFallback(env, paper)
    );
  } catch (err) {
    return errorResponse(err.code || "ai_bad_output", `Phân tích AI thất bại: ${err.detail || err.message}`, 502);
  }

  const nowSec = Math.floor(Date.now() / 1000);
  await timing.measure("d1_write", "D1 Save Analysis", () =>
    env.DB.prepare(
      `INSERT INTO analyses (paper_id, prompt_version, model, result_json, neurons_used, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)
       ON CONFLICT(paper_id, prompt_version) DO UPDATE SET
         model = excluded.model, result_json = excluded.result_json,
         neurons_used = excluded.neurons_used, created_at = excluded.created_at`
    )
      .bind(paperId, promptVersion, aiOut.model, JSON.stringify(aiOut.result), aiOut.neurons_used, nowSec)
      .run()
  );

  ctx.waitUntil(recordDailyUsage(env.DB, { aiCalls: 0, misses: 1, rowsRead: 4, rowsWritten: 3 }));

  return jsonResponse(
    {
      paper_id: paperId,
      prompt_version: promptVersion,
      model: aiOut.model,
      fallback_triggered: aiOut.fallback_triggered,
      neurons_used: aiOut.neurons_used,
      cache_status: "MISS",
      ai_generated: true,
      disclaimer: "Nội dung tóm tắt và gợi ý đề tài do AI sinh tự động, cần đối chiếu văn bản gốc.",
      ...aiOut.result,
    },
    200,
    { "Server-Timing": timing.toHeaderString() }
  );
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    if (!path.startsWith("/api/")) {
      return env.ASSETS.fetch(request);
    }

    const timing = new ServerTimingTracker();
    const clientIp = getClientIp(request);

    try {
      // 1. Health Check
      if (path === "/api/health" && method === "GET") {
        const dbCheck = await timing.measure("d1_health", "D1 Health Query", () =>
          env.DB.prepare("SELECT COUNT(*) AS table_count FROM sqlite_master WHERE type='table'").first()
        );
        return jsonResponse(
          {
            status: "ok",
            timestamp: new Date().toISOString(),
            d1_connected: true,
            tables_initialized: dbCheck?.table_count || 0,
            prompt_version: env.PROMPT_VERSION,
          },
          200,
          { "Server-Timing": timing.toHeaderString() }
        );
      }

      // 2. Search API
      if (path === "/api/search" && method === "GET") {
        const rl = await checkEdgeRateLimit(env.SEARCH_RATE_LIMITER, `search:${clientIp}`);
        if (!rl.allowed) {
          return errorResponse("rate_limited", "Bạn tìm kiếm quá nhanh (tối đa 30 lần/phút). Vui lòng thử lại sau.", 429);
        }
        const payload = await handleSearchRequest(url, env, ctx, timing);
        return jsonResponse(payload, 200, { "Server-Timing": timing.toHeaderString() });
      }

      // 3. Paper Detail API
      const paperDetailMatch = path.match(/^\/api\/papers\/([^/]+)$/);
      if (paperDetailMatch && method === "GET") {
        const paperId = paperDetailMatch[1];
        if (!isValidPaperId(paperId)) return errorResponse("invalid_paper_id", "Mã bài báo không hợp lệ.", 400);
        const row = await timing.measure("d1_paper", "D1 Paper Lookup", () =>
          env.DB.prepare("SELECT * FROM papers WHERE paper_id = ?1").bind(paperId).first()
        );
        if (!row) return errorResponse("paper_not_found", `Không tìm thấy bài báo ${paperId}`, 404);
        return jsonResponse(formatPaperRow(row), 200, { "Server-Timing": timing.toHeaderString() });
      }

      // 4. AI Analysis API
      const analysisMatch = path.match(/^\/api\/papers\/([^/]+)\/analysis$/);
      if (analysisMatch && (method === "GET" || method === "POST")) {
        return await handleAnalysisRequest(analysisMatch[1], method, clientIp, env, ctx, timing);
      }

      // 5. Citation Graph API
      const graphMatch = path.match(/^\/api\/papers\/([^/]+)\/graph$/);
      if (graphMatch && method === "GET") {
        const rl = await checkEdgeRateLimit(env.SEARCH_RATE_LIMITER, `graph:${clientIp}`);
        if (!rl.allowed) {
          return errorResponse("rate_limited", "Bạn gọi tải đồ thị quá nhanh. Vui lòng thử lại sau.", 429);
        }
        try {
          const result = await timing.measure("graph_build", "Citation Graph", () =>
            getPaperCitationGraph(env, ctx, graphMatch[1])
          );
          return jsonResponse(result, 200, { "Server-Timing": timing.toHeaderString() });
        } catch (err) {
          if (err.message === "invalid_paper_id") return errorResponse("invalid_paper_id", "Mã bài báo không hợp lệ.", 400);
          if (err.message === "paper_not_found") return errorResponse("paper_not_found", "Không tìm thấy bài báo gốc trong D1.", 404);
          throw err;
        }
      }

      // 6. Cite Metadata API
      if (path === "/api/cite" && method === "GET") {
        const rawIds = (url.searchParams.get("ids") || "").split(",").map((s) => s.trim());
        const validIds = [...new Set(rawIds.filter(isValidPaperId))].slice(0, 50);
        if (validIds.length === 0) {
          return errorResponse("invalid_ids", "Vui lòng truyền ít nhất 1 mã bài báo hợp lệ (?ids=W...).", 400);
        }
        const placeholders = validIds.map((_, i) => `?${i + 1}`).join(",");
        const rows = await timing.measure("d1_cite", "D1 Cite Lookup", () =>
          env.DB.prepare(`SELECT * FROM papers WHERE paper_id IN (${placeholders})`)
            .bind(...validIds)
            .all()
        );
        return jsonResponse(
          { count: (rows.results || []).length, items: (rows.results || []).map(formatPaperRow) },
          200,
          { "Server-Timing": timing.toHeaderString() }
        );
      }

      // 7. Bookmarks API
      if (path === "/api/bookmarks" && method === "GET") {
        const clientId = validateClientId(request);
        if (!clientId) return errorResponse("invalid_client_id", "Thiếu hoặc sai định dạng header X-Client-Id.", 400);
        const items = await timing.measure("d1_bookmarks", "D1 List Bookmarks", () =>
          listBookmarks(env.DB, clientId)
        );
        return jsonResponse({ count: items.length, items }, 200, { "Server-Timing": timing.toHeaderString() });
      }

      const bookmarkMatch = path.match(/^\/api\/bookmarks\/([^/]+)$/);
      if (bookmarkMatch && (method === "PUT" || method === "DELETE")) {
        const rl = await checkEdgeRateLimit(env.AI_RATE_LIMITER, `bm:${clientIp}`);
        if (!rl.allowed) {
          return errorResponse("rate_limited", "Bạn thao tác Bookmark quá nhanh (tối đa 5 lần/phút).", 429);
        }
        const clientId = validateClientId(request);
        if (!clientId) return errorResponse("invalid_client_id", "Thiếu hoặc sai định dạng header X-Client-Id.", 400);
        const paperId = bookmarkMatch[1];

        try {
          if (method === "PUT") {
            const body = await request.json().catch(() => ({}));
            const saved = await saveBookmark(env.DB, clientId, paperId, body.note || "");
            return jsonResponse(saved, 200, { "Server-Timing": timing.toHeaderString() });
          } else {
            const removed = await removeBookmark(env.DB, clientId, paperId);
            return jsonResponse(removed, 200, { "Server-Timing": timing.toHeaderString() });
          }
        } catch (err) {
          if (err.message === "invalid_paper_id") return errorResponse("invalid_paper_id", "Mã bài báo không hợp lệ.", 400);
          if (err.message === "paper_not_found") return errorResponse("paper_not_found", "Bài báo chưa tồn tại trong D1.", 404);
          if (err.message === "bookmark_limit_reached") {
            return errorResponse("bookmark_limit_reached", "Mỗi trình duyệt chỉ được lưu tối đa 50 bài báo yêu thích.", 429);
          }
          throw err;
        }
      }

      // 8. Stats FinOps API
      if (path === "/api/stats" && method === "GET") {
        const day = getTodayKey();
        const dailyBudget = Number(env.DAILY_AI_BUDGET || 50);
        const [usageRes, countPapersRes, countAnalysesRes] = await timing.measure("d1_stats", "D1 Stats Batch", () =>
          env.DB.batch([
            env.DB.prepare("SELECT * FROM usage_daily WHERE day = ?1").bind(day),
            env.DB.prepare("SELECT COUNT(*) AS total_papers FROM papers"),
            env.DB.prepare("SELECT COUNT(*) AS total_analyses FROM analyses"),
          ])
        );
        const u = usageRes.results?.[0] || {
          ai_calls: 0, oa_calls: 0, cache_hits: 0, cache_misses: 0, d1_rows_read: 0, d1_rows_written: 0,
        };
        const totalReqs = (u.cache_hits || 0) + (u.cache_misses || 0);
        return jsonResponse(
          {
            day,
            ai_calls_today: u.ai_calls || 0,
            daily_ai_budget: dailyBudget,
            ai_budget_remaining: Math.max(0, dailyBudget - (u.ai_calls || 0)),
            per_ip_daily_limit: Number(env.PER_IP_DAILY_AI_LIMIT || 5),
            oa_calls_today: u.oa_calls || 0,
            cache_hits: u.cache_hits || 0,
            cache_misses: u.cache_misses || 0,
            cache_hit_ratio: totalReqs > 0 ? Number(((u.cache_hits || 0) / totalReqs).toFixed(3)) : 0,
            d1_rows_read: u.d1_rows_read || 0,
            d1_rows_written: u.d1_rows_written || 0,
            stored_papers_count: countPapersRes.results?.[0]?.total_papers || 0,
            stored_analyses_count: countAnalysesRes.results?.[0]?.total_analyses || 0,
          },
          200,
          { "Server-Timing": timing.toHeaderString() }
        );
      }

      return errorResponse("not_found", `Không tìm thấy đường dẫn API: ${method} ${path}`, 404);
    } catch (err) {
      return errorResponse("internal_error", err.message || "Lỗi hệ thống nội bộ", 500);
    }
  },
};