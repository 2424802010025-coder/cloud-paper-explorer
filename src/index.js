/**
 * GIAI ĐOẠN 1 - KỸ SƯ 1: BỘ ĐỊNH TUYẾN API & HỢP ĐỒNG DỮ LIỆU MẪU (API CONTRACT)
 */

function jsonResponse(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
      ...extraHeaders,
    },
  });
}

function errorResponse(code, message, status = 400, extraHeaders = {}) {
  return jsonResponse({ error: { code, message } }, status, extraHeaders);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // 1. Đường dẫn không phải /api/* -> trả file giao diện tĩnh trong ./public
    if (!path.startsWith("/api/")) {
      return env.ASSETS.fetch(request);
    }

    try {
      // 2. Kiểm tra sức khỏe Worker và kết nối thật tới Cloudflare D1
      if (path === "/api/health" && method === "GET") {
        const t0 = performance.now();
        const dbCheck = await env.DB.prepare(
          "SELECT COUNT(*) AS table_count FROM sqlite_master WHERE type='table'"
        ).first();
        const d1Dur = (performance.now() - t0).toFixed(2);

        return jsonResponse(
          {
            status: "ok",
            timestamp: new Date().toISOString(),
            d1_connected: true,
            tables_initialized: dbCheck?.table_count || 0,
            prompt_version: env.PROMPT_VERSION,
          },
          200,
          { "Server-Timing": `d1_health;dur=${d1Dur}` }
        );
      }

      // 3. Mock API Contract: GET /api/search
      if (path === "/api/search" && method === "GET") {
        const q = url.searchParams.get("q") || "cloud computing";
        return jsonResponse(
          {
            query: q,
            page: Number(url.searchParams.get("page") || 1),
            total: 2,
            cache_status: "MOCK_CONTRACT",
            items: [
              {
                paper_id: "W2741809807",
                title: "Serverless Computing: Current Trends and Open Problems",
                abstract:
                  "Serverless computing has emerged as a new cloud execution model. We propose an analytical latency model for edge isolates. Experimental results demonstrate a 68% reduction in cold start overhead compared to container runtimes.",
                year: 2025,
                cited_by: 142,
                doi: "https://doi.org/10.1109/CLOUD.2025.00012",
                venue: "IEEE Transactions on Cloud Computing",
                authors: ["Ioana Baldini", "Paul Castro", "Kerry Chang"],
                freshness: {
                  label: "Mới nổi",
                  code: "emerging",
                  cites_per_year: 71.0,
                },
              },
              {
                paper_id: "W3124567890",
                title: "Edge Database Replication Strategies on Distributed SQLite",
                abstract:
                  "Global edge applications suffer from database read latency when storage is centralized. We introduce a two-tier caching protocol combining edge SQLite and gateway memory. Evaluation across 5 regions shows 4.2x throughput improvement.",
                year: 2021,
                cited_by: 310,
                doi: "https://doi.org/10.1145/3447548.3467001",
                venue: "ACM SIGMOD International Conference",
                authors: ["Michael Stonebraker", "Andy Pavlo"],
                freshness: {
                  label: "Nền tảng",
                  code: "foundational",
                  cites_per_year: 51.6,
                },
              },
            ],
          },
          200,
          { "Server-Timing": "mock_search;dur=1.2" }
        );
      }

      // 4. Mock API Contract: GET/POST /api/papers/:id/analysis
      const analysisMatch = path.match(/^\/api\/papers\/([^/]+)\/analysis$/);
      if (analysisMatch && (method === "GET" || method === "POST")) {
        const paperId = analysisMatch[1];
        return jsonResponse(
          {
            paper_id: paperId,
            prompt_version: env.PROMPT_VERSION,
            model: env.PRIMARY_AI_MODEL,
            ai_generated: true,
            disclaimer: "Nội dung tóm tắt và gợi ý đề tài do AI sinh tự động, cần đối chiếu văn bản gốc.",
            sentences: [
              {
                index: 0,
                text: "Serverless computing has emerged as a new cloud execution model.",
                label: "background",
              },
              {
                index: 1,
                text: "We propose an analytical latency model for edge isolates.",
                label: "method",
              },
              {
                index: 2,
                text: "Experimental results demonstrate a 68% reduction in cold start overhead compared to container runtimes.",
                label: "result",
              },
            ],
            vi_summary: {
              background: "Điện toán không máy chủ (Serverless) đang trở thành mô hình thực thi đám mây thế hệ mới.",
              method: "Nhóm tác giả đề xuất mô hình toán học phân tích độ trễ cho các tiến trình cô lập (Isolate) tại biên.",
              result: "Thực nghiệm cho thấy giảm 68% độ trễ khởi động lạnh (Cold Start) so với kiến trúc Container.",
            },
            ideas: [
              "Áp dụng mô hình cô lập V8 Isolate vào hệ thống tra cứu bài báo học thuật trên hạ tầng Cloudflare Edge.",
            ],
          },
          200,
          { "Server-Timing": "mock_ai;dur=5.4" }
        );
      }

      // 5. Mock API Contract: GET /api/stats
      if (path === "/api/stats" && method === "GET") {
        return jsonResponse({
          day: new Date().toISOString().slice(0, 10),
          ai_calls_today: 3,
          daily_ai_budget: Number(env.DAILY_AI_BUDGET || 50),
          ai_budget_remaining: Number(env.DAILY_AI_BUDGET || 50) - 3,
          oa_calls_today: 12,
          cache_hits: 45,
          cache_misses: 12,
          cache_hit_ratio: 0.789,
          d1_rows_read: 230,
          d1_rows_written: 38,
        });
      }

      return errorResponse("not_found", `Không tìm thấy đường dẫn API: ${method} ${path}`, 404);
    } catch (err) {
      return errorResponse("internal_error", err.message || "Lỗi hệ thống nội bộ", 500);
    }
  },
};