
function escapeHtml(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function safeExternalUrl(rawUrl) {
  try {
    const parsed = new URL(String(rawUrl || ""));
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.href : "#";
  } catch (_) {
    return "#";
  }
}

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
let currentPapers = [];

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

async function runSearch(e) {
  if (e) e.preventDefault();
  const q = document.getElementById("q-input").value.trim();
  const from = document.getElementById("from-year").value;
  const to = document.getElementById("to-year").value;
  const minCites = document.getElementById("min-cites").value;
  const sort = document.getElementById("sort-select").value;

  const listEl = document.getElementById("results-list");
  const metaEl = document.getElementById("search-meta");
  listEl.innerHTML = "<p>Đang truy vấn dữ liệu từ Cloudflare Worker...</p>";

  try {
    const params = new URLSearchParams({ q, from, to, min_cites: minCites, sort, page: "1" });
    const data = await apiFetch(`/api/search?${params.toString()}`);
    currentPapers = data.items || [];

    metaEl.textContent = `Tìm thấy ${data.total} bài báo • Trạng thái Cache: ${data.cache_status}`;
    listEl.innerHTML = currentPapers
      .map(
        (p) => `
      <article class="paper-card" data-id="${escapeHtml(p.paper_id)}">
        <div>
          <span class="badge badge-${escapeHtml(p.freshness?.code || "aging")}">${escapeHtml(p.freshness?.label || "Bài báo")}</span>
          <small>${escapeHtml(p.year || "N/A")} • ${Number(p.cited_by || 0)} trích dẫn • ${escapeHtml(p.venue || "OpenAlex")}</small>
        </div>
        <h3 style="margin: 0.4rem 0; font-size: 1rem;">${escapeHtml(p.title)}</h3>
        <p style="font-size: 0.85rem; color: #475569;">Tác giả: ${escapeHtml((p.authors || []).join(", "))}</p>
      </article>
    `
      )
      .join("");

    document.querySelectorAll(".paper-card").forEach((card) => {
      card.addEventListener("click", () => showPaperDetail(card.dataset.id));
    });
  } catch (err) {
    listEl.innerHTML = `<p style="color:#dc2626;">Lỗi tìm kiếm: ${escapeHtml(err.message)}</p>`;
  }
}

async function showPaperDetail(paperId) {
  const paper = currentPapers.find((p) => p.paper_id === paperId);
  if (!paper) return;

  const safeDoiHref = safeExternalUrl(paper.doi || paper.url);
  const detailEl = document.getElementById("detail-panel");
  detailEl.innerHTML = `
    <h2>${escapeHtml(paper.title)}</h2>
    <p style="margin: 0.5rem 0; font-size: 0.88rem; color: #475569;">
      Năm: <strong>${escapeHtml(paper.year)}</strong> • Trích dẫn: <strong>${Number(paper.cited_by || 0)}</strong> •
      <a href="${escapeHtml(safeDoiHref)}" target="_blank" rel="noopener noreferrer">Link DOI gốc</a>
    </p>
    <div style="margin: 1rem 0;">
      <button id="btn-run-ai" class="btn-primary">✨ Phân tích & Tô màu Abstract bằng Workers AI</button>
    </div>
    <div id="abstract-box" style="padding: 0.85rem; background: #f8fafc; border-radius: 6px; border: 1px solid #e2e8f0;">
      <strong>Abstract gốc:</strong>
      <p style="margin-top: 0.4rem;">${escapeHtml(paper.abstract || "Bài báo này không có dữ liệu Abstract trên OpenAlex.")}</p>
    </div>
    <div id="ai-output-box" style="margin-top: 1rem;"></div>
  `;
}

document.getElementById("search-form").addEventListener("submit", runSearch);
loadFinOpsStats();
runSearch();