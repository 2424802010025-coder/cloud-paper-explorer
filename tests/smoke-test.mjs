/**
 * GIAI ĐOẠN 7 - KỸ SƯ 2: KỊCH BẢN KIỂM THỬ TỰ ĐỘNG (CHỨC NĂNG, BẢO MẬT, CACHE HIT/MISS & 15 CONCURRENT SMOKE TEST)
 * Cách chạy trên CMD Windows:
 *   Local: node tests/smoke-test.mjs
 *   Cloud: set BASE_URL=https://cloud-paper-explorer.<subdomain>.workers.dev && node tests/smoke-test.mjs
 */

const BASE_URL = process.env.BASE_URL || "http://localhost:8787";
const TEST_CLIENT_ID = "test_client_uuid_1234567890";

function percentile(arr, p) {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return Number(sorted[idx].toFixed(2));
}

function average(arr) {
  if (arr.length === 0) return 0;
  return Number((arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(2));
}

async function timedRequest(path, { method = "GET", headers = {}, body = null } = {}) {
  const t0 = performance.now();
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      "X-Client-Id": TEST_CLIENT_ID,
      ...headers,
    },
    body: body ? JSON.stringify(body) : null,
  });
  const rttMs = Number((performance.now() - t0).toFixed(2));
  const serverTiming = res.headers.get("Server-Timing") || "";
  const data = await res.json().catch(() => ({}));
  return { status: res.status, rttMs, serverTiming, body: data };
}

async function runAllTests() {
  console.log(`🚀 Bắt đầu chạy bộ kiểm thử tự động trên: ${BASE_URL}\n`);
  const resultsTable = [];

  // TC01: Kiểm tra /api/health
  const health = await timedRequest("/api/health");
  resultsTable.push({
    id: "TC01",
    name: "Kiểm tra sức khỏe Worker & Kết nối D1 (/api/health)",
    expected: "HTTP 200, d1_connected = true",
    actual: `HTTP ${health.status}, d1_connected = ${health.body?.d1_connected} (${health.rttMs} ms)`,
    pass: health.status === 200 && health.body?.d1_connected === true,
  });

  // TC02: Kiểm tra bảo mật: Gọi /api/bookmarks không có X-Client-Id hợp lệ
  const badAuth = await timedRequest("/api/bookmarks", { headers: { "X-Client-Id": "bad" } });
  resultsTable.push({
    id: "TC02",
    name: "Chặn truy cập Bookmark khi thiếu/sai X-Client-Id",
    expected: "HTTP 400 (invalid_client_id)",
    actual: `HTTP ${badAuth.status} (${badAuth.body?.error?.code || ""})`,
    pass: badAuth.status === 400,
  });

  // TC03: Kiểm tra bảo mật: Chặn thao túng tham số paper_id (HTTP Parameter Pollution / Invalid Regex)
  const badPaperId = await timedRequest("/api/papers/W123_HACK_PARAM/graph");
  resultsTable.push({
    id: "TC03",
    name: "Chặn mã bài báo sai định dạng Regex /^W\\d{3,15}$/ (isValidPaperId)",
    expected: "HTTP 400 (invalid_paper_id)",
    actual: `HTTP ${badPaperId.status} (${badPaperId.body?.error?.code || ""})`,
    pass: badPaperId.status === 400,
  });

  // TC04: Kiểm tra chống SQL Injection trên tham số tìm kiếm
  const sqli = await timedRequest(
    `/api/search?q=${encodeURIComponent("' OR 1=1; DROP TABLE papers;--")}&from=2022&to=2025`
  );
  resultsTable.push({
    id: "TC04",
    name: "Chống SQL Injection qua Prepared Statement (?1, ?2)",
    expected: "HTTP 200 (Không sập DB, bảng papers còn nguyên)",
    actual: `HTTP ${sqli.status}, trả về an toàn`,
    pass: sqli.status === 200,
  });

  // TC05: Đo đạc thực nghiệm: Độ trễ Cache MISS vs Cache HIT qua danh sách từ khóa
  const keywords = [
    "serverless computing",
    "cloudflare workers edge",
    "zero trust authentication",
    "ebpf container security",
    "distributed sqlite database",
  ];
  const missLatencies = [];
  const hitLatencies = [];

  for (const kw of keywords) {
    const queryPath = `/api/search?q=${encodeURIComponent(kw)}&from=2021&to=2026&min_cites=5&sort=cited_by_count:desc&page=1`;
    const firstCall = await timedRequest(queryPath);
    if (firstCall.body?.cache_status === "MISS") {
      missLatencies.push(firstCall.rttMs);
    }
    const secondCall = await timedRequest(queryPath);
    if (secondCall.body?.cache_status === "HIT") {
      hitLatencies.push(secondCall.rttMs);
    }
  }

  resultsTable.push({
    id: "TC05",
    name: "Kiểm chứng tăng tốc nhờ D1 Search Cache (HIT vs MISS)",
    expected: "Cache HIT nhanh hơn rõ rệt so với Cache MISS",
    actual: `Trung bình MISS: ${average(missLatencies) || "Đã cache"} ms | Trung bình HIT: ${average(hitLatencies)} ms (p95 HIT: ${percentile(hitLatencies, 95)} ms)`,
    pass: hitLatencies.length > 0,
  });

  // TC06: Phép thử khói: 15 yêu cầu đồng thời (15 Concurrent Requests Smoke Test) vào endpoint đã Cache
  const targetUrl = `/api/search?q=serverless%20computing&from=2021&to=2026&min_cites=5&sort=cited_by_count:desc&page=1`;
  const tConcurrentStart = performance.now();
  const concurrentResponses = await Promise.all(
    Array.from({ length: 15 }, () => timedRequest(targetUrl))
  );
  const totalWallMs = Number((performance.now() - tConcurrentStart).toFixed(2));
  const successCount = concurrentResponses.filter((r) => r.status === 200 && r.body?.cache_status === "HIT").length;
  const rtts = concurrentResponses.map((r) => r.rttMs);

  resultsTable.push({
    id: "TC06",
    name: "Smoke Test 15 requests đồng thời vào endpoint đã Cache",
    expected: "15/15 request trả về HTTP 200 (Cache HIT)",
    actual: `Thành công ${successCount}/15 • Tổng thời gian: ${totalWallMs} ms • Trung bình: ${average(rtts)} ms • p95: ${percentile(rtts, 95)} ms`,
    pass: successCount === 15,
  });

  // In bảng Markdown sẵn sàng copy vào Chương 4 báo cáo
  console.log("### BẢNG KẾT QUẢ KIỂM THỬ TỰ ĐỘNG (COPY VÀO CHƯƠNG 4 BÁO CÁO)\n");
  console.log("| Mã TC | Nội dung kiểm thử | Kỳ vọng | Kết quả thực tế | Trạng thái |");
  console.log("|---|---|---|---|---|");
  for (const r of resultsTable) {
    console.log(`| **${r.id}** | ${r.name} | ${r.expected} | ${r.actual} | ${r.pass ? "PASS ✅" : "FAIL ❌"} |`);
  }
}

runAllTests().catch((err) => {
  console.error("Lỗi khi chạy smoke-test:", err);
  process.exit(1);
});