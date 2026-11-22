/**
 * GIAI ĐOẠN 4 - KỸ SƯ 1: QUẢN LÝ BOOKMARK (GIỚI HẠN 50 BÀI/CLIENT) & ĐỒ THỊ TRÍCH DẪN (GOM 1 SUBREQUEST)
 */
import { normalizeOpenAlexWork } from "./openalex.js";
import { upsertPapersBatch, formatPaperRow, recordDailyUsage } from "./db_service.js";
import { isValidPaperId } from "./ai_service.js";

const MAX_BOOKMARKS_PER_CLIENT = 50;

// 1. Kiểm tra định dạng header X-Client-Id hợp lệ (chuỗi 8-64 ký tự)
export function validateClientId(request) {
  const clientId = (request.headers.get("X-Client-Id") || "").trim();
  if (!clientId || !/^[a-zA-Z0-9_-]{8,64}$/.test(clientId)) {
    return null;
  }
  return clientId;
}

// 2. Lấy danh sách Bookmark của người dùng (JOIN trực tiếp với bảng papers)
export async function listBookmarks(db, clientId) {
  const rows = await db
    .prepare(
      `SELECT p.*, b.note, b.created_at AS bookmarked_at
       FROM bookmarks b
       JOIN papers p ON b.paper_id = p.paper_id
       WHERE b.client_id = ?1
       ORDER BY b.created_at DESC
       LIMIT 50`
    )
    .bind(clientId)
    .all();

  return (rows.results || []).map((r) => ({
    ...formatPaperRow(r),
    note: r.note || "",
    bookmarked_at: r.bookmarked_at,
  }));
}

// 3. Thêm hoặc cập nhật ghi chú Bookmark (Có chặn trần 50 bài/client để chống tràn D1)
export async function saveBookmark(db, clientId, paperId, note = "") {
  if (!isValidPaperId(paperId)) {
    throw new Error("invalid_paper_id");
  }

  const cleanNote = String(note || "").replace(/[\u0000-\u001F]/g, " ").trim().slice(0, 500);
  const nowSec = Math.floor(Date.now() / 1000);

  const [paperCheck, existingCheck, countCheck] = await db.batch([
    db.prepare("SELECT paper_id FROM papers WHERE paper_id = ?1").bind(paperId),
    db.prepare("SELECT 1 AS existed FROM bookmarks WHERE client_id = ?1 AND paper_id = ?2").bind(clientId, paperId),
    db.prepare("SELECT COUNT(*) AS cnt FROM bookmarks WHERE client_id = ?1").bind(clientId),
  ]);

  if (!paperCheck.results?.[0]) {
    throw new Error("paper_not_found");
  }

  const alreadyBookmarked = Boolean(existingCheck.results?.[0]?.existed);
  const currentCount = countCheck.results?.[0]?.cnt || 0;

  if (!alreadyBookmarked && currentCount >= MAX_BOOKMARKS_PER_CLIENT) {
    throw new Error("bookmark_limit_reached");
  }

  await db
    .prepare(
      `INSERT INTO bookmarks (client_id, paper_id, note, created_at)
       VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT(client_id, paper_id) DO UPDATE SET note = excluded.note`
    )
    .bind(clientId, paperId, cleanNote, nowSec)
    .run();

  return { client_id: clientId, paper_id: paperId, note: cleanNote, saved: true };
}

// 4. Xóa Bookmark
export async function removeBookmark(db, clientId, paperId) {
  if (!isValidPaperId(paperId)) {
    throw new Error("invalid_paper_id");
  }
  await db
    .prepare("DELETE FROM bookmarks WHERE client_id = ?1 AND paper_id = ?2")
    .bind(clientId, paperId)
    .run();
  return { deleted: true, paper_id: paperId };
}

// 5. Lấy dữ liệu Đồ thị Trích dẫn (Gom tối đa 15 referenced_works vào 1 subrequest duy nhất + Cache 30 ngày)
export async function getPaperCitationGraph(env, ctx, paperId) {
  if (!isValidPaperId(paperId)) {
    throw new Error("invalid_paper_id");
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const cached = await env.DB.prepare(
    "SELECT graph_json, created_at, ttl_sec FROM graph_cache WHERE paper_id = ?1"
  )
    .bind(paperId)
    .first();

  if (cached && nowSec - cached.created_at < cached.ttl_sec) {
    ctx.waitUntil(recordDailyUsage(env.DB, { hits: 1, rowsRead: 1 }));
    return { cache_status: "HIT", graph: JSON.parse(cached.graph_json) };
  }

  const rootRow = await env.DB.prepare("SELECT * FROM papers WHERE paper_id = ?1").bind(paperId).first();
  if (!rootRow) {
    throw new Error("paper_not_found");
  }

  const rootPaper = formatPaperRow(rootRow);
  const refIds = (rootPaper.referenced_works || []).filter((id) => isValidPaperId(id)).slice(0, 15);

  const nodes = [
    {
      data: {
        id: rootPaper.paper_id,
        label: `${rootPaper.title.slice(0, 42)}... (${rootPaper.year || "N/A"})`,
        full_title: rootPaper.title,
        year: rootPaper.year,
        cited_by: rootPaper.cited_by,
        role: "root",
      },
    },
  ];
  const edges = [];

  if (refIds.length > 0) {
    const params = new URLSearchParams({
      filter: `openalex:${refIds.join("|")}`,
      "per-page": String(refIds.length),
      select:
        "id,title,display_name,abstract_inverted_index,publication_year,cited_by_count,doi,primary_location,biblio,authorships,referenced_works,type",
    });
    if (env.OPENALEX_API_KEY) params.set("api_key", env.OPENALEX_API_KEY);

    const oaRes = await fetch(`https://api.openalex.org/works?${params.toString()}`, {
      headers: { "User-Agent": "CloudScholar-StudentProject/2.0", Accept: "application/json" },
    });

    if (oaRes.ok) {
      const oaData = await oaRes.json();
      const normalizedRefs = (oaData.results || []).map(normalizeOpenAlexWork);
      await upsertPapersBatch(env.DB, normalizedRefs);

      for (const ref of normalizedRefs) {
        nodes.push({
          data: {
            id: ref.paper_id,
            label: `${ref.title.slice(0, 36)}... (${ref.year || "N/A"})`,
            full_title: ref.title,
            year: ref.year,
            cited_by: ref.cited_by,
            role: "reference",
          },
        });
        edges.push({
          data: {
            id: `${rootPaper.paper_id}->${ref.paper_id}`,
            source: rootPaper.paper_id,
            target: ref.paper_id,
          },
        });
      }
    }
  }

  const graphPayload = { root_id: paperId, nodes, edges };
  const ttl30Days = 30 * 86400;

  await env.DB.prepare(
    `INSERT INTO graph_cache (paper_id, graph_json, created_at, ttl_sec)
     VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT(paper_id) DO UPDATE SET
       graph_json = excluded.graph_json, created_at = excluded.created_at`
  )
    .bind(paperId, JSON.stringify(graphPayload), nowSec, ttl30Days)
    .run();

  ctx.waitUntil(recordDailyUsage(env.DB, { oaCalls: refIds.length > 0 ? 1 : 0, misses: 1, rowsWritten: 1 }));

  return { cache_status: "MISS", graph: graphPayload };
}