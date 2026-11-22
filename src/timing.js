/**
 * GIAI ĐOẠN 6 - KỸ SƯ 1: BỘ ĐO ĐỘ TRỄ CHI TIẾT W3C SERVER-TIMING
 */

export class ServerTimingTracker {
  constructor() {
    this.marks = new Map();
    this.metrics = [];
    this.requestStart = performance.now();
  }

  start(name) {
    this.marks.set(name, performance.now());
  }

  end(name, description = "") {
    const t0 = this.marks.get(name);
    if (t0 === undefined) return 0;
    const dur = Math.max(0.01, performance.now() - t0);
    this.metrics.push({
      name,
      dur: dur.toFixed(2),
      desc: description,
    });
    this.marks.delete(name);
    return dur;
  }

  // Đo trực tiếp một hàm bất đồng bộ (async function)
  async measure(name, description, asyncFn) {
    this.start(name);
    try {
      return await asyncFn();
    } finally {
      this.end(name, description);
    }
  }

  toHeaderString() {
    const totalDur = Math.max(0.01, performance.now() - this.requestStart).toFixed(2);
    const items = [
      ...this.metrics.map((m) =>
        m.desc ? `${m.name};desc="${m.desc}";dur=${m.dur}` : `${m.name};dur=${m.dur}`
      ),
      `total_worker;desc="Total Edge Execution";dur=${totalDur}`,
    ];
    return items.join(", ");
  }
}