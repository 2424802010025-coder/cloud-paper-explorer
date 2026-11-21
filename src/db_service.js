/**
 * GIAI ĐOẠN 2 - KỸ SƯ 1: DỊCH VỤ CƠ SỞ DỮ LIỆU D1, CACHE PHÂN TẦNG & UPSERT BATCHING
 */
import { computeFreshness } from "./openalex.js";

// 1. Lấy chuỗi ngày hiện tại theo múi giờ UTC (YYYY-MM-DD)
export function getTodayKey() {
  return new Date().toISOString().slice(0, 10);
}

// 2. Cộng dồn thống kê FinOps vào bảng usage_daily
export async function recordDailyUsage(
  db,
  { aiCalls = 0, oaCalls = 0, hits = 0, misses = 0, rowsRead = 0, rowsWritten = 0 }
) {
  const day = getTodayKey();
  await db
    .prepare(
      `INSERT INTO usage_daily (day, ai_calls, oa_calls, cache_hits, cache_misses, d1_rows_read, d1_rows_written)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
       ON CONFLICT(day) DO UPDATE SET
         ai_calls = ai_calls + excluded.ai_calls,
         oa_calls = oa_calls + excluded.oa_calls,
         cache_hits = cache_hits + excluded.cache_hits,
         cache_misses = cache_misses + excluded.cache_misses,
         d1_rows_read = d1_rows_read + excluded.d1_rows_read,
         d1_rows_written = d1_rows_written + excluded.d1_rows_written`
    )
    .bind(day, aiCalls, oaCalls, hits, misses, rowsRead, rowsWritten)
    .run();
}

// 3. Chuyển đổi 1 dòng dữ liệu từ bảng papers thành đối tượng chuẩn trả về cho Frontend
export function formatPaperRow(row) {
  let authors = [];
  let refs = [];
  try {
    authors = JSON.parse(row.authors_json || "[]");
    refs = JSON.parse(row.refs_json || "[]");
  } catch (_) {}

  return {
    paper_id: row.paper_id,
    title: row.title,
    abstract: row.abstract,
    has_abstract: Boolean(row.abstract && row.abstract.trim().length > 20),
    year: row.year,
    cited_by: row.cited_by,
    doi: row.doi,
    venue: row.venue,
    venue_type: row.venue_type,
    work_type: row.work_type,
    volume: row.volume,
    issue: row.issue,
    first_page: row.first_page,
    last_page: row.last_page,
    authors,
    referenced_works: refs,
    url: row.url,
    freshness: computeFreshness(row.year, row.cited_by),
  };
}

// 4. Lưu hàng loạt bài báo bằng DB.batch() và ON CONFLICT DO UPDATE (Bảo toàn khóa ngoại CASCADE)
export async function upsertPapersBatch(db, normalizedPapers) {
  if (!normalizedPapers || normalizedPapers.length === 0) {
    return { rowsRead: 0, rowsWritten: 0 };
  }

  const stmt = db.prepare(
    `INSERT INTO papers (
       paper_id, title, abstract, year, cited_by, doi, venue, venue_type,
       work_type, volume, issue, first_page, last_page, authors_json, refs_json, url, fetched_at
     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)
     ON CONFLICT(paper_id) DO UPDATE SET
       cited_by = excluded.cited_by,
       abstract = COALESCE(excluded.abstract, papers.abstract),
       fetched_at = excluded.fetched_at
     WHERE excluded.cited_by != papers.cited_by OR (papers.abstract IS NULL AND excluded.abstract IS NOT NULL)`
  );

  const batchStatements = normalizedPapers.map((p) =>
    stmt.bind(
      p.paper_id,
      p.title,
      p.abstract,
      p.year,
      p.cited_by,
      p.doi,
      p.venue,
      p.venue_type,
      p.work_type,
      p.volume,
      p.issue,
      p.first_page,
      p.last_page,
      p.authors_json,
      p.refs_json,
      p.url,
      p.fetched_at
    )
  );

  const results = await db.batch(batchStatements);
  let rowsRead = 0;
  let rowsWritten = 0;
  for (const r of results) {
    rowsRead += r.meta?.rows_read || 0;
    rowsWritten += r.meta?.rows_written || 0;
  }
  return { rowsRead, rowsWritten };
}