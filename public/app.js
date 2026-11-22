/**
 * GIAI ĐOẠN 4 - KỸ SƯ 2: HOÀN THIỆN SPA CLOUDSCHOLAR
 * - GĐ1: client_id (localStorage), chống DOM/URI XSS, FinOps & Server-Timing
 * - GĐ2: Tìm kiếm, lọc năm, huy hiệu Cache HIT/MISS, phân trang, khóa AI khi thiếu Abstract
 * - GĐ3: Phân tích Workers AI (GET cache trước, POST khi bấm), lọc nhãn câu & cảnh báo ai_generated
 * - GĐ4: Xuất BibTeX/IEEE, quản lý Bookmark + ghi chú & Đồ thị trích dẫn Cytoscape.js
 */

let currentPapers = [];
let savedBookmarks = [];
let currentPage = 1;
let currentTotal = 0;

// ==================== 1. BẢO MẬT & ĐỊNH DANH CLIENT ====================

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
    const err = new Error(data?.error?.message || `Lỗi HTTP ${response.status}`);
    err.status = response.status;
    throw err;
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

// ==================== 2. XUẤT TRÍCH DẪN BIBTEX & IEEE ====================

function formatBibTeX(paper) {
  const firstAuthorLast = ((paper.authors?.[0] || "author").split(" ").pop() || "paper")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
  const firstWord = (paper.title || "work")
    .split(/\s+/)[0]
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
  const citeKey = `${firstAuthorLast}${paper.year || "2026"}${firstWord}`;
  const authorStr = (paper.authors || ["Unknown Author"]).join(" and ");

  const lines = [
    `@article{${citeKey},`,
    `  author = {${authorStr}},`,
    `  title = {${paper.title || ""}},`,
    `  journal = {${paper.venue || "OpenAlex Repository"}},`,
    `  year = {${paper.year || "2026"}},`,
  ];
  if (paper.volume) lines.push(`  volume = {${paper.volume}},`);
  if (paper.issue) lines.push(`  number = {${paper.issue}},`);
  if (paper.first_page) {
    const pages = paper.last_page ? `${paper.first_page}--${paper.last_page}` : paper.first_page;
    lines.push(`  pages = {${pages}},`);
  }
  if (paper.doi) lines.push(`  doi = {${paper.doi}},`);
  lines.push(`}`);
  return lines.join("\n");
}

function formatIEEE(paper, index = 1) {
  const authors = (paper.authors || ["Unknown Author"]).join(", ");
  const venue = paper.venue ? ` ${paper.venue},` : "";
  const vol = paper.volume ? ` vol. ${paper.volume},` : "";
  const no = paper.issue ? ` no. ${paper.issue},` : "";
  const pages = paper.first_page
    ? ` pp. ${paper.first_page}${paper.last_page ? "-" + paper.last_page : ""},`
    : "";
  const year = paper.year ? ` ${paper.year}` : "";
  const doi = paper.doi ? `, doi: ${paper.doi.replace("https://doi.org/", "")}.` : ".";

  return `[${index}] ${authors}, "${paper.title},"${venue}${vol}${no}${pages}${year}${doi}`;
}

function downloadTextFile(filename, content) {
  const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

async function copyText(text, feedbackEl, successMsg) {
  try {
    await navigator.clipboard.writeText(text);
    if (feedbackEl) {
      feedbackEl.textContent = successMsg;
      setTimeout(() => {
        feedbackEl.textContent = "";
      }, 2500);
    }
  } catch (_) {
    alert("Trình duyệt chặn copy tự động. Bạn có thể tải file .bib hoặc copy thủ công.");
  }
}

// ==================== 3. TÌM KIẾM & PHÂN TRANG ====================

async function executeSearch(page = 1) {
  const q = document.getElementById("q-input").value.trim();
  const fromYear = Number(document.getElementById("from-year").value || 2020);
  const toYear = Number(document.getElementById("to-year").value || 2026);
  const minCites = Number(document.getElementById("min-cites").value || 0);
  const sort = document.getElementById("sort-select").value;

  const listEl = document.getElementById("results-list");
  const metaEl = document.getElementById("search-meta");

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
        const absBadge = hasAbs ? "" : `<span class="no-abstract-tag">Không có Abstract</span>`;

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

    listEl.querySelectorAll(".paper-card").forEach((card) => {
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

// ==================== 4. PHÂN TÍCH WORKERS AI & TÔ MÀU ABSTRACT ====================

function renderAnalysisResult(aiData, activeFilter = "all") {
  const abstractBox = document.getElementById("abstract-box");
  const outBox = document.getElementById("ai-output-box");

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

  abstractBox.querySelectorAll(".legend-item").forEach((btn) => {
    btn.addEventListener("click", () => {
      renderAnalysisResult(aiData, btn.dataset.filter);
    });
  });

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
    // 404 (chưa có trong cache) -> giữ nguyên nút cho người dùng tự bấm
  }
}

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
    btn.textContent = "✨ Phân tích & Tô màu Abstract";
    if (err.status === 429) {
      outBox.innerHTML = `
        <div style="padding: 0.85rem; background: #fff7ed; border: 1px solid #fdba74; color: #9a3412; border-radius: 6px;">
          ⚠️ <strong>Đã chạm giới hạn bảo vệ ngân sách Đám mây (HTTP 429):</strong> ${escapeHtml(err.message)}<br/>
          <small>Cơ chế chống lạm dụng (Rate Limit / Free Tier Guard) đang hoạt động để bảo vệ hạn mức Workers AI. Các chức năng tra cứu, đọc Cache D1, Bookmark và xuất BibTeX/IEEE vẫn hoạt động bình thường.</small>
        </div>
      `;
    } else {
      outBox.innerHTML = `
        <div style="padding: 0.75rem; background: #fef2f2; border: 1px solid #fecaca; color: #b91c1c; border-radius: 6px;">
          ❌ Không thể chạy phân tích AI: ${escapeHtml(err.message)}
        </div>
      `;
    }
  }
}

// ==================== 5. ĐỒ THỊ TRÍCH DẪN CYTOSCAPE.JS ====================

async function renderCitationGraph(paperId) {
  const section = document.getElementById("graph-section");
  const container = document.getElementById("cy-graph-container");
  if (!container) return;
  if (section) section.style.display = "block";

  container.innerHTML = "<p style='padding:1rem;'>⏳ Đang dựng đồ thị trích dẫn từ OpenAlex & D1 Cache...</p>";

  try {
    if (!window.cytoscape) {
      await new Promise((resolve, reject) => {
        const script = document.createElement("script");
        script.src = "https://cdnjs.cloudflare.com/ajax/libs/cytoscape/3.30.2/cytoscape.min.js";
        script.onload = resolve;
        script.onerror = () => reject(new Error("Không tải được thư viện Cytoscape.js"));
        document.head.appendChild(script);
      });
    }

    const res = await apiFetch(`/api/papers/${encodeURIComponent(paperId)}/graph`);
    const { nodes, edges } = res.graph || { nodes: [], edges: [] };

    if (nodes.length <= 1) {
      container.innerHTML =
        "<p style='padding:1rem; color:#475569;'>Bài báo này không công bố danh sách tài liệu tham khảo (referenced_works) trên OpenAlex.</p>";
      return;
    }

    container.innerHTML = "";
    const cy = window.cytoscape({
      container,
      elements: [...nodes, ...edges],
      style: [
        {
          selector: "node",
          style: {
            label: "data(label)",
            "font-size": "10px",
            "text-wrap": "wrap",
            "text-max-width": "110px",
            "background-color": "#38bdf8",
            color: "#0f172a",
            width: 28,
            height: 28,
          },
        },
        {
          selector: 'node[role = "root"]',
          style: {
            "background-color": "#0284c7",
            width: 40,
            height: 40,
            "font-weight": "bold",
          },
        },
        {
          selector: "edge",
          style: {
            width: 1.5,
            "line-color": "#94a3b8",
            "target-arrow-color": "#94a3b8",
            "target-arrow-shape": "triangle",
            "curve-style": "bezier",
          },
        },
      ],
      layout: {
        name: "concentric",
        concentric: (node) => (node.data("role") === "root" ? 2 : 1),
        levelWidth: () => 1,
        padding: 25,
      },
    });

    cy.on("tap", "node", (evt) => {
      const d = evt.target.data();
      const infoEl = document.getElementById("graph-node-info");
      if (infoEl) {
        infoEl.innerHTML = `<strong>[${escapeHtml(d.id)}]</strong> ${escapeHtml(d.full_title)} (${escapeHtml(d.year || "N/A")} • ${Number(d.cited_by || 0)} trích dẫn)`;
      }
    });
  } catch (err) {
    container.innerHTML = `<p style="padding:1rem; color:#dc2626;">Lỗi tải đồ thị: ${escapeHtml(err.message)}</p>`;
  }
}

// ==================== 6. QUẢN LÝ BOOKMARK & CHUYỂN TAB ====================

async function refreshBookmarks() {
  try {
    const res = await apiFetch("/api/bookmarks");
    savedBookmarks = res.items || [];
    const countEl = document.getElementById("bookmark-count");
    if (countEl) countEl.textContent = String(savedBookmarks.length);
    renderBookmarksTab();
  } catch (err) {
    console.warn("Lỗi tải danh sách Bookmark:", err.message);
  }
}

async function toggleBookmark(paperId, noteText = "") {
  const exists = savedBookmarks.some((bookmark) => bookmark.paper_id === paperId);

  try {
    if (exists) {
      await apiFetch(`/api/bookmarks/${encodeURIComponent(paperId)}`, { method: "DELETE" });
    } else {
      await apiFetch("/api/bookmarks", {
        method: "POST",
        body: JSON.stringify({ paper_id: paperId, note: noteText }),
      });
    }

    await refreshBookmarks();
  } catch (err) {
    alert(`Không thể cập nhật Bookmark: ${err.message}`);
  }
}

function renderBookmarksTab() {
  const listEl = document.getElementById("bookmarks-list");
  if (!listEl) return;

  if (savedBookmarks.length === 0) {
    listEl.innerHTML = '<p>Chưa có bài báo nào trong danh sách Bookmark.</p>';
    return;
  }

  listEl.innerHTML = savedBookmarks
    .map((item) => {
      const paper = item.paper || item;
      const note = item.note ? escapeHtml(item.note) : "";
      return `
        <article class="paper-card bookmark-card" data-id="${escapeHtml(paper.paper_id)}">
          <div style="display:flex; justify-content:space-between; align-items:center; gap:0.5rem;">
            <h3 style="margin:0; font-size:1rem;">${escapeHtml(paper.title)}</h3>
            <button type="button" class="btn-outline btn-remove-bookmark" data-paper-id="${escapeHtml(paper.paper_id)}">Bỏ lưu</button>
          </div>
          <p style="font-size:0.84rem; color:#475569;">${escapeHtml(paper.authors?.join(", ") || "Chưa rõ tác giả")}</p>
          ${note ? `<p class="bookmark-note">Ghi chú: ${note}</p>` : ""}
        </article>
      `;
    })
    .join("");

  listEl.querySelectorAll(".bookmark-card").forEach((card) => {
    card.addEventListener("click", (event) => {
      if (!event.target.closest(".btn-remove-bookmark")) {
        showPaperDetail(card.dataset.id);
      }
    });
  });

  listEl.querySelectorAll(".btn-remove-bookmark").forEach((button) => {
    button.addEventListener("click", () => toggleBookmark(button.dataset.paperId));
  });
}

async function showPaperDetail(paperId) {
  const panel = document.getElementById("detail-panel");
  if (!panel) return;

  panel.innerHTML = '<div class="empty-state">Đang tải chi tiết bài báo...</div>';

  try {
    let paper = currentPapers.find((item) => item.paper_id === paperId);
    if (!paper) {
      paper = await apiFetch(`/api/papers/${encodeURIComponent(paperId)}`);
    }

    const isBookmarked = savedBookmarks.some((bookmark) =>
      (bookmark.paper_id || bookmark.paper?.paper_id) === paperId
    );
    const hasAbstract = Boolean(paper.abstract && paper.abstract.trim().length >= 20);

    panel.innerHTML = `
      <article class="paper-detail">
        <h2>${escapeHtml(paper.title)}</h2>
        <p><strong>Tác giả:</strong> ${escapeHtml((paper.authors || []).join(", ") || "Chưa rõ")}</p>
        <p><strong>Nguồn:</strong> ${escapeHtml(paper.venue || "OpenAlex")} • <strong>Năm:</strong> ${escapeHtml(paper.year || "N/A")}</p>
        ${paper.doi ? `<p><strong>DOI:</strong> <a href="${safeExternalUrl(paper.doi)}" target="_blank" rel="noopener noreferrer">${escapeHtml(paper.doi)}</a></p>` : ""}
        ${paper.url ? `<p><a href="${safeExternalUrl(paper.url)}" target="_blank" rel="noopener noreferrer">Mở trên OpenAlex</a></p>` : ""}

        <div class="action-row">
          <button type="button" id="btn-toggle-bookmark" class="btn-outline">${isBookmarked ? "★ Đã lưu" : "☆ Lưu bài báo"}</button>
          <button type="button" id="btn-copy-bib" class="btn-outline">Copy BibTeX</button>
          <button type="button" id="btn-copy-ieee" class="btn-outline">Copy IEEE</button>
        </div>

        <section>
          <h3>Abstract</h3>
          <div id="abstract-box">${escapeHtml(paper.abstract || "Bài báo này không có Abstract.")}</div>
        </section>

        <section>
          <button type="button" id="btn-run-ai" class="btn-primary" ${hasAbstract ? "" : "disabled"}>✨ Phân tích & Tô màu Abstract</button>
          <div id="ai-output-box"></div>
        </section>

        <section id="graph-section">
          <h3>Đồ thị trích dẫn</h3>
          <div id="cy-graph-container"></div>
        </section>
      </article>
    `;

    document.getElementById("btn-toggle-bookmark")?.addEventListener("click", () => {
      const existing = savedBookmarks.find((bookmark) =>
        (bookmark.paper_id || bookmark.paper?.paper_id) === paperId
      );
      const note = existing?.note || "";
      toggleBookmark(paperId, note);
    });

    document.getElementById("btn-copy-bib")?.addEventListener("click", () => {
      copyText(formatBibTeX(paper), null, "Đã copy BibTeX");
    });

    document.getElementById("btn-copy-ieee")?.addEventListener("click", () => {
      copyText(formatIEEE(paper), null, "Đã copy IEEE");
    });

    document.getElementById("btn-run-ai")?.addEventListener("click", () => runAiAnalysis(paper));

    checkExistingAnalysis(paperId);
    renderCitationGraph(paperId);
  } catch (err) {
    panel.innerHTML = `<div class="empty-state" style="color:#dc2626;">Không tải được chi tiết: ${escapeHtml(err.message)}</div>`;
  }
}

function switchTab(tabId) {
  document.querySelectorAll(".tab-btn").forEach((button) => {
    button.classList.toggle("active", button.dataset.tab === tabId);
  });
  document.querySelectorAll("main > section.left-panel").forEach((section) => {
    section.style.display = section.id === tabId ? "block" : "none";
  });
}

document.querySelectorAll(".tab-btn").forEach((button) => {
  button.addEventListener("click", () => switchTab(button.dataset.tab));
});

const searchForm = document.getElementById("search-form");
if (searchForm) {
  searchForm.addEventListener("submit", (event) => {
    event.preventDefault();
    executeSearch(1);
  });
}

const exportBibButton = document.getElementById("btn-export-all-bib");
if (exportBibButton) {
  exportBibButton.addEventListener("click", () => {
    const papers = savedBookmarks.map((item) => item.paper || item);
    if (papers.length === 0) {
      alert("Chưa có bài báo nào để xuất.");
      return;
    }
    downloadTextFile("cloudscholar-bookmarks.bib", papers.map(formatBibTeX).join("\n\n"));
  });
}

const exportIeeeButton = document.getElementById("btn-export-all-ieee");
if (exportIeeeButton) {
  exportIeeeButton.addEventListener("click", () => {
    const papers = savedBookmarks.map((item) => item.paper || item);
    if (papers.length === 0) {
      alert("Chưa có bài báo nào để copy.");
      return;
    }
    const text = papers.map((paper, index) => formatIEEE(paper, index + 1)).join("\n");
    copyText(text, null, "Đã copy danh sách IEEE");
  });
}

refreshBookmarks();
executeSearch(1);
// ==================== 9. SỔ CÁI TÀI NGUYÊN ĐÁM MÂY (FINOPS LEDGER) ====================

async function renderFinOpsDashboardModal() {
  const detailEl = document.getElementById("detail-panel");
  detailEl.innerHTML = "<p>⏳ Đang tải sổ cái tài nguyên đám mây (Cloud FinOps Ledger)...</p>";

  try {
    const s = await apiFetch("/api/stats");
    const hitPct = ((s.cache_hit_ratio || 0) * 100).toFixed(1);
    const d1ReadPct = (((s.d1_rows_read || 0) / 5000000) * 100).toFixed(4);
    const d1WritePct = (((s.d1_rows_written || 0) / 100000) * 100).toFixed(3);
    const aiBudgetPct = (((s.ai_calls_today || 0) / (s.daily_ai_budget || 50)) * 100).toFixed(1);

    detailEl.innerHTML = `
      <h2>📊 Sổ cái Quản trị Tài nguyên Đám mây (Cloud FinOps Ledger)</h2>
      <p style="font-size:0.86rem; color:#475569; margin-bottom:1rem;">
        Ngày ghi nhận (UTC): <strong>${escapeHtml(s.day)}</strong> • Tự động giám sát hạn mức gói Cloudflare Free Tier
      </p>

      <div style="display:grid; grid-template-columns:1fr 1fr; gap:0.75rem; margin-bottom:1rem;">
        <div class="paper-card" style="cursor:default;">
          <small>⚡ Tỷ lệ trúng bộ nhớ đệm (D1 Cache Hit Ratio)</small>
          <h3 style="font-size:1.4rem; color:#15803d;">${hitPct}%</h3>
          <small>${s.cache_hits} HIT / ${s.cache_misses} MISS (Tiết kiệm ${s.cache_hits} lượt gọi ngoài)</small>
        </div>
        <div class="paper-card" style="cursor:default;">
          <small>🤖 Ngân sách Phân tích AI trong ngày</small>
          <h3 style="font-size:1.4rem; color:#0284c7;">${s.ai_calls_today} / ${s.daily_ai_budget} lượt (${aiBudgetPct}%)</h3>
          <small>Giới hạn mỗi IP: tối đa ${s.per_ip_daily_limit || 5} bài/ngày</small>
        </div>
      </div>

      <table style="width:100%; border-collapse:collapse; font-size:0.86rem;">
        <thead>
          <tr style="background:#f1f5f9; text-align:left;">
            <th style="padding:0.55rem; border:1px solid #e2e8f0;">Tài nguyên Đám mây</th>
            <th style="padding:0.55rem; border:1px solid #e2e8f0;">Đã dùng hôm nay</th>
            <th style="padding:0.55rem; border:1px solid #e2e8f0;">Trần Free Tier / Ngày</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td style="padding:0.55rem; border:1px solid #e2e8f0;">Cloudflare D1 Rows Read</td>
            <td style="padding:0.55rem; border:1px solid #e2e8f0;"><strong>${(s.d1_rows_read || 0).toLocaleString("vi-VN")}</strong> dòng</td>
            <td style="padding:0.55rem; border:1px solid #e2e8f0;">5.000.000 dòng (${d1ReadPct}%)</td>
          </tr>
          <tr>
            <td style="padding:0.55rem; border:1px solid #e2e8f0;">Cloudflare D1 Rows Written</td>
            <td style="padding:0.55rem; border:1px solid #e2e8f0;"><strong>${(s.d1_rows_written || 0).toLocaleString("vi-VN")}</strong> dòng</td>
            <td style="padding:0.55rem; border:1px solid #e2e8f0;">100.000 dòng (${d1WritePct}%)</td>
          </tr>
          <tr>
            <td style="padding:0.55rem; border:1px solid #e2e8f0;">OpenAlex API Subrequests</td>
            <td style="padding:0.55rem; border:1px solid #e2e8f0;"><strong>${s.oa_calls_today || 0}</strong> lượt gọi</td>
            <td style="padding:0.55rem; border:1px solid #e2e8f0;">~$1.00 / ngày (Free API Key)</td>
          </tr>
          <tr>
            <td style="padding:0.55rem; border:1px solid #e2e8f0;">Tổng dữ liệu đã lưu trữ trong D1</td>
            <td style="padding:0.55rem; border:1px solid #e2e8f0;"><strong>${s.stored_papers_count || 0}</strong> bài báo / <strong>${s.stored_analyses_count || 0}</strong> bản AI</td>
            <td style="padding:0.55rem; border:1px solid #e2e8f0;">5 GB dung lượng lưu trữ</td>
          </tr>
        </tbody>
      </table>
    `;
  } catch (err) {
    detailEl.innerHTML = `<p style="color:#dc2626;">Không thể tải sổ cái FinOps: ${escapeHtml(err.message)}</p>`;
  }
}

const finopsBar = document.getElementById("finops-bar");
if (finopsBar) {
  finopsBar.style.cursor = "pointer";
  finopsBar.title = "Bấm để xem chi tiết Sổ cái Tài nguyên Đám mây (FinOps Ledger)";
  finopsBar.addEventListener("click", renderFinOpsDashboardModal);
}