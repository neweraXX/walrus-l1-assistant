// Bao cao "suc khoe tri nho" cho admin (Ha), doc tu chain qua Tatum. User L1 khong thay.
//   node --env-file=.env src/ops.js            -> in bao cao
//   node --env-file=.env src/ops.js --json     -> in so lieu tho (de luu lich su / ve bieu do)
import { fileURLToPath } from "node:url";
import { createChain } from "./chain.js";

const EPOCH_DAYS = 14; // Walrus mainnet: 1 epoch ~ 2 tuan
const WARN_EPOCHS = 4; // con <= 4 epoch (~8 tuan) thi canh bao
const MIN_WAL = 0.5; // duoi muc nay thi khong du gia han / ghi tiep

function approxDate(epochsAhead, from = new Date()) {
  const d = new Date(from.getTime() + epochsAhead * EPOCH_DAYS * 86_400_000);
  return d.toLocaleDateString("vi-VN", { month: "2-digit", year: "numeric", timeZone: "Asia/Ho_Chi_Minh" });
}

export async function collectHealth({ chain, accountId }) {
  if (!chain.owner) chain.setOwner(await chain.getAccountOwner(accountId));
  const started = Date.now();
  const [epoch, blobs, balances] = [await chain.getWalrusEpoch(), await chain.listMemoryBlobs(), await chain.getBalances()];

  const byEnd = {};
  for (const b of blobs) byEnd[b.endEpoch] = (byEnd[b.endEpoch] || 0) + 1;

  // Chi doc metadata cho nhom sap het han (it) -> biet do la memory cua bot hay blob khac.
  const expiring = [];
  for (const b of blobs.filter((x) => x.endEpoch - epoch <= WARN_EPOCHS)) {
    const meta = await chain.getBlobMetadata(b.objectId);
    expiring.push({ ...b, namespace: meta.memwal_namespace || null, isMemory: Boolean(meta.memwal_job_id) });
  }

  return {
    at: new Date().toISOString(),
    owner: chain.owner,
    epoch,
    blobs: {
      total: blobs.length,
      uncertified: blobs.filter((b) => b.certifiedEpoch == null).length,
      bytes: blobs.reduce((s, b) => s + b.size, 0),
      byEndEpoch: byEnd,
      firstExpiry: Math.min(...blobs.map((b) => b.endEpoch)),
    },
    expiring,
    balances: { SUI: balances.SUI || 0, WAL: balances.WAL || 0 },
    rpc: { ...chain.stats, scanMs: Date.now() - started },
  };
}

export function formatHealth(h) {
  const memExpiring = h.expiring.filter((e) => e.isMemory);
  const otherExpiring = h.expiring.filter((e) => !e.isMemory);
  const memEnds = Object.keys(h.blobs.byEndEpoch).map(Number).filter((e) => e - h.epoch > WARN_EPOCHS);
  const nextMemEnd = memEnds.length ? Math.min(...memEnds) : null;
  const lines = [
    `🩺 Sức khoẻ trí nhớ bot (${new Date(h.at).toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" })})`,
    `• ${h.blobs.total} mục đã lưu (${(h.blobs.bytes / 1e6).toFixed(2)} MB), ${h.blobs.uncertified ? `⚠️ ${h.blobs.uncertified} mục chưa lưu xong` : "tất cả đã lưu xong ✅"}`,
  ];
  if (memExpiring.length) {
    lines.push(`• ⚠️ ${memExpiring.length} kiến thức sẽ MẤT trong ≤ ${WARN_EPOCHS * 2} tuần nếu không gia hạn:`);
    for (const e of memExpiring.slice(0, 10)) lines.push(`   - ${e.namespace} (hết hạn ≈ ${approxDate(e.endEpoch - h.epoch)})`);
  } else if (nextMemEnd) {
    lines.push(`• Kiến thức an toàn tới ≈ ${approxDate(nextMemEnd - h.epoch)} (còn ${nextMemEnd - h.epoch} kỳ ~ ${(nextMemEnd - h.epoch) * 2} tuần)`);
  }
  if (otherExpiring.length) lines.push(`• ${otherExpiring.length} dữ liệu khác (không phải kiến thức bot) sắp hết hạn — bỏ qua được`);
  lines.push(`• Ví: ${h.balances.WAL.toFixed(2)} WAL, ${h.balances.SUI.toFixed(2)} SUI${h.balances.WAL < MIN_WAL ? " ⚠️ WAL thấp, cần nạp để gia hạn/ghi tiếp" : ""}`);
  lines.push(`• Kiểm tra: ${h.rpc.calls} lượt đọc, ${h.rpc.errors} lỗi, ${(h.rpc.scanMs / 1000).toFixed(1)}s`);
  return lines.join("\n");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const chain = createChain({ apiKey: process.env.TATUM_API_KEY, rpcUrl: process.env.TATUM_SUI_RPC || undefined, owner: process.env.WALLET_ADDRESS || "" });
  const h = await collectHealth({ chain, accountId: process.env.MEMWAL_ACCOUNT_ID });
  console.log(process.argv.includes("--json") ? JSON.stringify(h, null, 2) : formatHealth(h));
}
