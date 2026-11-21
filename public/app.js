/**
 * GIAI ĐOẠN 3 - KỸ SƯ 2: CLIENT_ID, TÌM KIẾM PHÂN TRANG, CHỐNG DOM/URI XSS,
 * HIỂN THỊ TÔ MÀU ABSTRACT, LỌC NHÃN CÂU & CẢNH BÁO AI_GENERATED
 */

let currentPapers = [];
let currentPage = 1;
let currentTotal = 0;

// 1. Hàm làm sạch chuỗi HTML để chống lỗ hổng DOM XSS
function escapeHtml(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// 2. Chỉ cho phép đường dẫn https:// hoặc http:// khi gắn vào <a href="...">
function safeExternalUrl(rawUrl) {
  try {
    const parsed = new URL(String(rawUrl || ""));
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.href : "#";
  } catch (_) {
    return "#";
  }
}

// 3. Định danh người dùng không cần đăng nhập bằng UUIDv4 lưu trong localStorage
function getOrCreateClientId() {
  const storageKey = "cloudscholar_client_id";
  let clientId = localStorage.getItem(storageKey);
  if (!clientId) {
    clientId = crypto.randomUUID();
    localStorage.setItem(storageKey, clientId);
  }
  return clientId;
}

const CLIENT_ID = getOrCreateClientId();

async function apiFetch(endpoint, options = {}) {
  const t0 = performance.now();
  const headers = {
    "Content-Type": "application/json",
    "X-Client-Id": CLIENT_ID,
    ...(options.headers || {}),
  };

  const response = await fetch(endpoint, { ...options, headers });
  const roundtripMs = (performance.now() - t0).toFixed(0);
  const serverTiming = response.headers.get("Server-Timing") || `rtt;dur=${roundtripMs}`;

  const latencyEl = document.getElementById("stat-latency");
  if (latencyEl) {
    latencyEl.textContent = `Server-Timing: ${serverTiming} (Tổng: ${roundtripMs} ms)`;
  }

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data?.error?.message || `Lỗi HTTP ${response.status}`);
  }
  return data;
}

async function loadFinOpsStats() {
  try {
    const stats = await apiFetch("/api/stats");
    const hitPct = ((stats.cache_hit_ratio || 0) * 100).toFixed(1);
    document.getElementById("stat-cache").textContent = `Cache Hit: ${hitPct}%`;
    document.getElementById("stat-ai-budget").textContent =
      `Ngân sách AI hôm nay: ${stats.ai_calls_today}/${stats.daily_ai_budget}`;
  } catch (err) {
    console.warn("Chưa tải được /api/stats:", err.message);
  }
}

async function executeSearch(page = 1) {
  const q = document.getElementById("q-input").value.trim();
  const fromYear = Number(document.getElementById("from-year").value || 2020);
  const toYear = Number(document.getElementById("to-year").value || 2026);
  const minCites = Number(document.getElementById("min-cites").value || 0);
  const sort = document.getElementById("sort-select").value;

  const listEl = document.getElementById("results-list");
  const metaEl = document.getElementById("search-meta");

  // Kiểm tra hợp lệ khoảng năm ngay tại trình duyệt
  if (fromYear > toYear) {
    metaEl.innerHTML = `<span style="color:#dc2626; font-weight:600;">⚠️ Năm bắt đầu (${fromYear}) không được lớn hơn năm kết thúc (${toYear}).</span>`;
    return;
  }

  currentPage = page;
  listEl.innerHTML = "<p>⏳ Đang truy vấn dữ liệu học thuật qua Cloudflare Edge...</p>";

  try {
    const params = new URLSearchParams({
      q,
      from: String(fromYear),
      to: String(toYear),
      min_cites: String(minCites),
      sort,
      page: String(currentPage),
    });

    const data = await apiFetch(`/api/search?${params.toString()}`);
    currentPapers = data.items || [];
    currentTotal = data.total || 0;

    const isHit = data.cache_status === "HIT";
    const cacheBadge = isHit
      ? `<span class="cache-pill cache-hit">⚡ D1 Cache HIT</span>`
      : `<span class="cache-pill cache-miss">🌐 OpenAlex Fetch (MISS)</span>`;

    metaEl.innerHTML = `
      Tìm thấy <strong>${currentTotal.toLocaleString("vi-VN")}</strong> bài báo (Trang ${currentPage}) • ${cacheBadge}
    `;

    if (currentPapers.length === 0) {
      listEl.innerHTML = `
        <div class="paper-card">
          <p>Không tìm thấy bài báo nào khớp với bộ lọc hiện tại. Hãy thử giảm số trích dẫn tối thiểu hoặc mở rộng khoảng năm.</p>
        </div>
      `;
      return;
    }

    const cardsHtml = currentPapers
      .map((p) => {
        const hasAbs = Boolean(p.abstract && p.abstract.trim().length > 20);
        const absBadge = hasAbs
          ? ""
          : `<span class="no-abstract-tag">Không có Abstract</span>`;

        return `
        <article class="paper-card" data-id="${escapeHtml(p.paper_id)}">
          <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:0.4rem;">
            <div>
              <span class="badge badge-${escapeHtml(p.freshness?.code || "aging")}">
                ${escapeHtml(p.freshness?.label || "Bài báo")} (${Number(p.freshness?.cites_per_year || 0)}/năm)
              </span>
              ${absBadge}
            </div>
            <small>${escapeHtml(p.year || "N/A")} • <strong>${Number(p.cited_by || 0)}</strong> trích dẫn</small>
          </div>
          <h3 style="margin: 0.45rem 0; font-size: 1rem;">${escapeHtml(p.title)}</h3>
          <p style="font-size: 0.84rem; color: #475569;">
            <strong>Tác giả:</strong> ${escapeHtml((p.authors || []).slice(0, 4).join(", ")) || "Chưa rõ"} •
            <strong>Nguồn:</strong> ${escapeHtml(p.venue || "OpenAlex")}
          </p>
        </article>
      `;
      })
      .join("");

    const totalPages = Math.max(1, Math.ceil(currentTotal / 10));
    const paginationHtml = `
      <div class="pagination-bar">
        <button id="btn-prev-page" class="btn-outline" ${currentPage <= 1 ? "disabled" : ""}>← Trang trước</button>
        <span>Trang <strong>${currentPage}</strong> / ${totalPages.toLocaleString("vi-VN")}</span>
        <button id="btn-next-page" class="btn-outline" ${currentPage >= totalPages ? "disabled" : ""}>Trang tiếp →</button>
      </div>
    `;

    listEl.innerHTML = cardsHtml + paginationHtml;

    document.querySelectorAll(".paper-card").forEach((card) => {
      card.addEventListener("click", () => showPaperDetail(card.dataset.id));
    });

    const prevBtn = document.getElementById("btn-prev-page");
    const nextBtn = document.getElementById("btn-next-page");
    if (prevBtn) prevBtn.addEventListener("click", () => executeSearch(currentPage - 1));
    if (nextBtn) nextBtn.addEventListener("click", () => executeSearch(currentPage + 1));

    loadFinOpsStats();
  } catch (err) {
    listEl.innerHTML = `<p style="color:#dc2626;">❌ Lỗi truy vấn: ${escapeHtml(err.message)}</p>`;
  }
}

// Vẽ kết quả phân tích AI: tô màu câu theo nhãn, lọc nhãn và gắn cờ ai_generated
function renderAnalysisResult(aiData, activeFilter = "all") {
  const abstractBox = document.getElementById("abstract-box");
  const outBox = document.getElementById("ai-output-box");

  // 1. Vẽ các câu trong Abstract với màu sắc tương ứng nhãn
  const sentencesHtml = (aiData.sentences || [])
    .map((s) => {
      const dimmed = activeFilter !== "all" && s.label !== activeFilter ? "opacity: 0.25;" : "";
      return `<span class="hl-${escapeHtml(s.label)}" style="${dimmed}" title="Câu #${s.index} • Nhãn: ${escapeHtml(s.label)}">${escapeHtml(s.text)}</span>`;
    })
    .join(" ");

  abstractBox.innerHTML = `
    <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap;">
      <strong>Abstract đã phân tách ngữ nghĩa (${(aiData.sentences || []).length} câu):</strong>
      <small>Bấm vào nhãn bên dưới để lọc nhanh</small>
    </div>
    <div class="ai-legend">
      <button type="button" class="legend-item ${activeFilter === "all" ? "active" : ""}" data-filter="all">Tất cả</button>
      <button type="button" class="legend-item hl-background ${activeFilter === "background" ? "active" : ""}" data-filter="background">🔵 Bối cảnh (Background)</button>
      <button type="button" class="legend-item hl-method ${activeFilter === "method" ? "active" : ""}" data-filter="method">🟢 Phương pháp (Method)</button>
      <button type="button" class="legend-item hl-result ${activeFilter === "result" ? "active" : ""}" data-filter="result">🟡 Kết quả (Result)</button>
    </div>
    <p style="margin-top: 0.5rem; line-height: 1.9;">${sentencesHtml}</p>
  `;

  // Gắn sự kiện bấm lọc theo từng loại câu
  abstractBox.querySelectorAll(".legend-item").forEach((btn) => {
    btn.addEventListener("click", () => {
      renderAnalysisResult(aiData, btn.dataset.filter);
    });
  });

  // 2. Vẽ khung tóm tắt tiếng Việt và gợi ý đề tài kèm cờ cảnh báo ai_generated
  const fallbackNote = aiData.fallback_triggered
    ? `<span style="color:#b91c1c; font-weight:600;">(Đã kích hoạt Fallback Model)</span>`
    : "";

  const ideasHtml = (aiData.ideas || [])
    .map((idea) => `<div class="idea-chip">🟣 <strong>Gợi ý đề tài:</strong> ${escapeHtml(idea)}</div>`)
    .join("");

  outBox.innerHTML = `
    <div class="ai-summary-card">
      <div class="ai-warning-banner">
        <span>⚠️ <strong>Cờ đánh dấu (ai_generated = true):</strong> Nội dung tóm tắt tiếng Việt và gợi ý đề tài do AI sinh ra, cần kiểm chứng với văn bản gốc.</span>
        <span>Model: <code>${escapeHtml(aiData.model || "Workers AI")}</code> ${fallbackNote} • Prompt: <code>${escapeHtml(aiData.prompt_version || "v1")}</code></span>
      </div>
      <h4 style="margin-bottom: 0.5rem;">🇻🇳 Tóm tắt cấu trúc bằng tiếng Việt</h4>
      <p style="margin-bottom: 0.35rem;">🔵 <strong>Bối cảnh:</strong> ${escapeHtml(aiData.vi_summary?.background || "")}</p>
      <p style="margin-bottom: 0.35rem;">🟢 <strong>Phương pháp:</strong> ${escapeHtml(aiData.vi_summary?.method || "")}</p>
      <p style="margin-bottom: 0.5rem;">🟡 <strong>Kết quả:</strong> ${escapeHtml(aiData.vi_summary?.result || "")}</p>
      ${ideasHtml}
    </div>
  `;
}

// Tự động kiểm tra Cache phân tích (GET) khi mở chi tiết bài báo
async function checkExistingAnalysis(paperId) {
  try {
    const response = await fetch(`/api/papers/${encodeURIComponent(paperId)}/analysis`, {
      method: "GET",
      headers: { "X-Client-Id": CLIENT_ID },
    });
    if (response.ok) {
      const cachedAiData = await response.json();
      renderAnalysisResult(cachedAiData);
      const btn = document.getElementById("btn-run-ai");
      if (btn) {
        btn.textContent = "✅ Đã tải phân tích từ D1 Cache";
        btn.disabled = true;
      }
    }
  } catch (_) {
    // Nếu 404 (chưa có trong cache) thì giữ nguyên nút để người dùng chủ động bấm
  }
}

// Gọi POST /api/papers/:id/analysis khi người dùng chủ động bấm nút phân tích AI
async function runAiAnalysis(paper) {
  const btn = document.getElementById("btn-run-ai");
  const outBox = document.getElementById("ai-output-box");
  if (!btn || !outBox) return;

  btn.disabled = true;
  btn.textContent = "⏳ Đang phân tích bằng Workers AI...";
  outBox.innerHTML = `<p style="color:#475569;">⏳ Đang gửi Abstract tới Cloudflare Workers AI, vui lòng chờ vài giây...</p>`;

  try {
    const aiData = await apiFetch(`/api/papers/${encodeURIComponent(paper.paper_id)}/analysis`, {
      method: "POST",
      body: JSON.stringify({
        title: paper.title,
        abstract: paper.abstract,
      }),
    });
    renderAnalysisResult(aiData);
    btn.textContent = "✅ Đã hoàn tất phân tích AI";
    loadFinOpsStats();
  } catch (err) {
    btn.disabled = false;
    btn.textContent = "✨ Phân tích & Tô màu Abstract bằng Workers AI";
    outBox.innerHTML = `
      <div style="padding: 0.75rem; background: #fef2f2; border: 1px solid #fecaca; color: #b91c1c; border-radius: 6px;">
        ❌ Không thể chạy phân tích AI: ${escapeHtml(err.message)}
      </div>
    `;
  }
}

// Hiển thị chi tiết bài báo với safeExternalUrl, kiểm tra Cache AI và gắn nút chạy AI
async function showPaperDetail(paperId) {
  const paper = currentPapers.find((p) => p.paper_id === paperId);
  if (!paper) return;

  const hasAbs = Boolean(paper.abstract && paper.abstract.trim().length > 20);
  const safeHref = safeExternalUrl(paper.doi || paper.url);
  const detailEl = document.getElementById("detail-panel");

  detailEl.innerHTML = `
    <h2>${escapeHtml(paper.title)}</h2>
    <p style="margin: 0.5rem 0; font-size: 0.88rem; color: #475569;">
      Mã: <code>${escapeHtml(paper.paper_id)}</code> • Năm: <strong>${escapeHtml(paper.year || "N/A")}</strong> •
      Trích dẫn: <strong>${Number(paper.cited_by || 0)}</strong> •
      <a href="${escapeHtml(safeHref)}" target="_blank" rel="noopener noreferrer">Mở bài báo gốc (DOI/URL)</a>
    </p>
    <div style="margin: 1rem 0;">
      <button id="btn-run-ai" class="btn-primary" ${hasAbs ? "" : "disabled"}>
        ${hasAbs ? "✨ Phân tích & Tô màu Abstract bằng Workers AI" : "🚫 Không có Abstract để phân tích AI"}
      </button>
    </div>
    <div id="abstract-box" style="padding: 0.85rem; background: #f8fafc; border-radius: 6px; border: 1px solid #e2e8f0;">
      <strong>Abstract gốc:</strong>
      <p style="margin-top: 0.4rem;">
        ${hasAbs ? escapeHtml(paper.abstract) : "Bài báo này không công bố dữ liệu Abstract trên kho OpenAlex nên chức năng phân tích AI tự động được khóa để tiết kiệm tài nguyên."}
      </p>
    </div>
    <div id="ai-output-box" style="margin-top: 1rem;"></div>
  `;

  if (hasAbs) {
    const runBtn = document.getElementById("btn-run-ai");
    if (runBtn) {
      runBtn.addEventListener("click", () => runAiAnalysis(paper));
    }
    checkExistingAnalysis(paper.paper_id);
  }
}

// Gắn sự kiện form tìm kiếm về Trang 1 và chạy mặc định khi mở trang
document.getElementById("search-form").addEventListener("submit", (e) => {
  e.preventDefault();
  executeSearch(1);
});

loadFinOpsStats();
executeSearch(1);
