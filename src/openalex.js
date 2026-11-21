/**
 * GIAI ĐOẠN 2 - KỸ SƯ 1: MÔ-ĐUN KẾT NỐI OPENALEX, KHÔI PHỤC ABSTRACT & TÍNH ĐỘ MỚI
 */

// 1. Khôi phục chuỗi văn bản gốc từ đối tượng abstract_inverted_index của OpenAlex
export function reconstructAbstract(invertedIndex) {
  if (!invertedIndex || typeof invertedIndex !== "object") {
    return null;
  }

  let maxIndex = -1;
  for (const positions of Object.values(invertedIndex)) {
    if (Array.isArray(positions)) {
      for (const pos of positions) {
        if (pos > maxIndex) maxIndex = pos;
      }
    }
  }

  if (maxIndex < 0 || maxIndex > 5000) {
    return null; // Bảo vệ bộ nhớ Worker (128MB) trước dữ liệu bất thường
  }

  const words = new Array(maxIndex + 1).fill("");
  for (const [word, positions] of Object.entries(invertedIndex)) {
    if (Array.isArray(positions)) {
      for (const pos of positions) {
        if (pos >= 0 && pos <= maxIndex) {
          words[pos] = word;
        }
      }
    }
  }

  const text = words.filter(Boolean).join(" ").trim();
  return text.length > 0 ? text : null;
}

// 2. Tính nhãn độ mới (Freshness Label) dựa trên năm xuất bản và tốc độ trích dẫn/năm
export function computeFreshness(year, citedBy, currentYear = 2026) {
  const pubYear = Number(year) || currentYear;
  const cites = Number(citedBy) || 0;
  const age = Math.max(1, currentYear - pubYear + 1);
  const citesPerYear = Number((cites / age).toFixed(1));

  if (pubYear >= currentYear - 1 || (pubYear >= currentYear - 3 && citesPerYear >= 15)) {
    return {
      label: "Mới nổi",
      code: "emerging",
      cites_per_year: citesPerYear,
    };
  }

  if (cites >= 50 || citesPerYear >= 10) {
    return {
      label: "Nền tảng",
      code: "foundational",
      cites_per_year: citesPerYear,
    };
  }

  return {
    label: "Có thể đã cũ",
    code: "aging",
    cites_per_year: citesPerYear,
  };
}

// 3. Chuẩn hóa một đối tượng Work trả về từ OpenAlex sang cấu trúc 17 cột bảng papers của D1
export function normalizeOpenAlexWork(work) {
  const rawId = work.id || "";
  const paperId = rawId.replace("https://openalex.org/", "").trim();
  const abstractText = reconstructAbstract(work.abstract_inverted_index);

  const primaryLocation = work.primary_location || {};
  const source = primaryLocation.source || {};
  const biblio = work.biblio || {};

  const authors = (work.authorships || [])
    .slice(0, 10)
    .map((a) => a.author?.display_name)
    .filter(Boolean);

  const refs = (work.referenced_works || [])
    .slice(0, 25)
    .map((r) => r.replace("https://openalex.org/", ""));

  return {
    paper_id: paperId,
    title: work.title || work.display_name || "Không có tiêu đề",
    abstract: abstractText,
    year: work.publication_year || null,
    cited_by: work.cited_by_count || 0,
    doi: work.doi || null,
    venue: source.display_name || null,
    venue_type: source.type || null,
    work_type: work.type || null,
    volume: biblio.volume || null,
    issue: biblio.issue || null,
    first_page: biblio.first_page || null,
    last_page: biblio.last_page || null,
    authors_json: JSON.stringify(authors),
    refs_json: JSON.stringify(refs),
    url: primaryLocation.landing_page_url || work.doi || work.id,
    fetched_at: Math.floor(Date.now() / 1000),
  };
}

// 4. Gọi OpenAlex API có đính kèm khóa api_key và chọn lọc trường (select) để giảm băng thông
export async function searchOpenAlex({ q, fromYear, toYear, minCites, sort, page, apiKey }) {
  const filters = [];
  if (fromYear) filters.push(`from_publication_date:${fromYear}-01-01`);
  if (toYear) filters.push(`to_publication_date:${toYear}-12-31`);
  if (minCites && Number(minCites) > 0) filters.push(`cited_by_count:>${Number(minCites) - 1}`);

  const params = new URLSearchParams();
  if (q) params.set("search", q);
  if (filters.length > 0) params.set("filter", filters.join(","));

  const validSorts = ["relevance_score:desc", "cited_by_count:desc", "publication_year:desc"];
  const safeSort = validSorts.includes(sort) ? sort : "relevance_score:desc";
  if (q || safeSort !== "relevance_score:desc") {
    params.set("sort", safeSort);
  }

  params.set("page", String(page || 1));
  params.set("per-page", "10");
  params.set(
    "select",
    "id,title,display_name,abstract_inverted_index,publication_year,cited_by_count,doi,primary_location,biblio,authorships,referenced_works,type"
  );

  if (apiKey) {
    params.set("api_key", apiKey);
  }

  const endpoint = `https://api.openalex.org/works?${params.toString()}`;
  const response = await fetch(endpoint, {
    headers: {
      "User-Agent": "CloudScholar-StudentProject/2.0 (mailto:student@tdmu.edu.vn)",
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`OpenAlex API trả về lỗi HTTP ${response.status}`);
  }

  return await response.json();
}