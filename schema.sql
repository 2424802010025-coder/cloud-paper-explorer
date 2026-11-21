PRAGMA foreign_keys = ON;

-- Bảng 1: Lưu trữ thông tin bài báo khoa học lấy từ OpenAlex
CREATE TABLE IF NOT EXISTS papers (
    paper_id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    abstract TEXT,
    year INTEGER,
    cited_by INTEGER DEFAULT 0,
    doi TEXT,
    venue TEXT,
    venue_type TEXT,
    work_type TEXT,
    volume TEXT,
    issue TEXT,
    first_page TEXT,
    last_page TEXT,
    authors_json TEXT,
    refs_json TEXT,
    url TEXT,
    fetched_at INTEGER NOT NULL
);

-- Bảng 2: Lưu Cache kết quả tìm kiếm
CREATE TABLE IF NOT EXISTS search_cache (
    cache_key TEXT PRIMARY KEY,
    paper_ids TEXT NOT NULL,
    total INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    ttl_sec INTEGER NOT NULL
);

-- Bảng 3: Lưu kết quả phân tích AI (Khóa chính kép gồm paper_id và prompt_version)
CREATE TABLE IF NOT EXISTS analyses (
    paper_id TEXT NOT NULL,
    prompt_version TEXT NOT NULL,
    model TEXT NOT NULL,
    result_json TEXT NOT NULL,
    neurons_used INTEGER DEFAULT 0,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (paper_id, prompt_version),
    FOREIGN KEY (paper_id) REFERENCES papers(paper_id) ON DELETE CASCADE
);

-- Bảng 4: Lưu Cache đồ thị trích dẫn (TTL 30 ngày)
CREATE TABLE IF NOT EXISTS graph_cache (
    paper_id TEXT PRIMARY KEY,
    graph_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    ttl_sec INTEGER NOT NULL,
    FOREIGN KEY (paper_id) REFERENCES papers(paper_id) ON DELETE CASCADE
);

-- Bảng 5: Lưu danh sách bài báo yêu thích (Bookmark) theo mã định danh trình duyệt client_id
CREATE TABLE IF NOT EXISTS bookmarks (
    client_id TEXT NOT NULL,
    paper_id TEXT NOT NULL,
    note TEXT DEFAULT '',
    created_at INTEGER NOT NULL,
    PRIMARY KEY (client_id, paper_id),
    FOREIGN KEY (paper_id) REFERENCES papers(paper_id) ON DELETE CASCADE
);

-- Bảng 6: Sổ cái thống kê mức sử dụng tài nguyên mỗi ngày (FinOps Ledger)
CREATE TABLE IF NOT EXISTS usage_daily (
    day TEXT PRIMARY KEY,
    ai_calls INTEGER DEFAULT 0,
    oa_calls INTEGER DEFAULT 0,
    cache_hits INTEGER DEFAULT 0,
    cache_misses INTEGER DEFAULT 0,
    d1_rows_read INTEGER DEFAULT 0,
    d1_rows_written INTEGER DEFAULT 0
);

-- Bảng 7: Chặn hạn mức gọi AI theo từng địa chỉ IP mỗi ngày (lưu mã băm SHA-256 của IP)
CREATE TABLE IF NOT EXISTS ip_daily_usage (
    day TEXT NOT NULL,
    ip_hash TEXT NOT NULL,
    ai_calls INTEGER DEFAULT 0,
    PRIMARY KEY (day, ip_hash)
);