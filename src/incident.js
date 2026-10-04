// Phat hien su co dien rong: moi nguoi nghe may chi thay 1 cuoc goi, nhung bot
// nho CHUNG cho ca team -> gop lai thay nhieu SR khac nhau cung bao 1 loi trong
// khung gio ngan. Chi lam duoc nho memory dung chung (team:caselog).
export function createIncidentDetector({ memory, directory, windowMinutes, minReports }) {
  let lastAlert = { key: "", count: 0, at: 0 };

  async function check({ body, codes, author }) {
    const srCodes = codes.filter((c) => c.startsWith("SR-"));
    if (!srCodes.length) return null;

    const since = Date.now() - windowMinutes * 60 * 1000;
    const reports = new Map();
    // Log hien tai chua index xong tren Walrus -> tu them vao.
    for (const sr of srCodes) reports.set(sr, { author, body, time: new Date() });

    const hits = await memory.recall(memory.ns.caselog, body, { limit: 20, maxDistance: 0.5 });
    for (const h of hits) {
      const meta = h.meta;
      if (!meta || meta.time.getTime() < since) continue;
      for (const c of meta.codes) {
        if (c.startsWith("SR-") && !reports.has(c)) reports.set(c, { author: meta.author, body: meta.body, time: meta.time });
      }
    }
    if (reports.size < minReports) return null;

    // Khong bao lai lien tuc cho cung 1 dot su co; chi bao lai khi so SR tang.
    const key = [...reports.keys()].sort()[0];
    const fresh = Date.now() - lastAlert.at > windowMinutes * 60 * 1000;
    if (!fresh && reports.size <= lastAlert.count) return null;
    lastAlert = { key, count: reports.size, at: Date.now() };

    const lines = [
      "⚠️ CÓ THỂ LÀ SỰ CỐ DIỆN RỘNG",
      `Trong ${windowMinutes} phút qua có ${reports.size} SR khác nhau báo lỗi tương tự:`,
    ];
    const byNpp = new Map();
    for (const [sr, r] of reports) {
      const info = directory.get(sr);
      const where = info ? ` (${info.npp}, ${info.route})` : "";
      const hhmm = r.time.toLocaleTimeString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh", hour: "2-digit", minute: "2-digit" });
      const body = r.body.length > 100 ? `${r.body.slice(0, 100).trimEnd()}…` : r.body;
      lines.push(`- ${sr}${where} — ${r.author} lúc ${hhmm}: ${body}`);
      if (info?.npp) byNpp.set(info.npp, (byNpp.get(info.npp) || 0) + 1);
    }
    for (const [npp, n] of byNpp) if (n > 1) lines.push(`Cùng ${npp}: ${n}/${reports.size} SR.`);
    lines.push("Gợi ý: cân nhắc nâng P1 và báo L2 ngay (xem reference/escalation-matrix.md).");
    return lines.join("\n");
  }

  return { check };
}
