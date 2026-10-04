// Chay tu dong cac kich ban trong demo-scenarios.md tren Walrus mainnet va in
// transcript (dung lam bang chung cho bai viet). Dung namespace rieng
// "<prefix>-script-<ngay>" de khong lan vao du lieu team dung that tren Zalo.
//   docker compose run --rm l1-assistant node src/demo.js
const base = process.env.NAMESPACE_PREFIX || "l1demo";
const runId = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");
process.env.NAMESPACE_PREFIX = `${base}-script-${runId}`;

const { bootstrap } = await import("./bootstrap.js");
const { assistant, memory, cfg } = await bootstrap({ needZalo: false });

const users = { An: "cli-an", Binh: "cli-binh", Chi: "cli-chi", Dung: "cli-dung" };

async function say(name, text) {
  console.log(`\n👤 ${name}: ${text}`);
  const t = Date.now();
  try {
    const replies = await assistant.handle({ chatId: "demo-group", userId: users[name], userName: name, text });
    for (const r of replies) console.log(`🤖 (${((Date.now() - t) / 1000).toFixed(1)}s) ${r}`);
  } catch (err) {
    console.log(`❌ LOI (${((Date.now() - t) / 1000).toFixed(1)}s): ${err.message}`);
  }
}

async function waitIndexed() {
  const t = Date.now();
  await memory.flush();
  console.log(`   ⏳ da index xong tren Walrus (${((Date.now() - t) / 1000).toFixed(0)}s)`);
}

function section(title) {
  console.log(`\n${"=".repeat(70)}\n${title}\n${"=".repeat(70)}`);
}

console.log(`Namespace demo: ${cfg.namespacePrefix}`);

section("1. Tra cuu tai lieu");
await say("An", "check-in báo ngoài phạm vi GPS thì xử lý sao, có cần chuyển L2 không?");

section("2. Khach goi lai, nguoi khac nghe may");
await say("An", "log: SR-1042 gọi, đơn ở OUT-0007 không vào DMS, lỗi Outlet not mapped, đã chuyển DMS team, hẹn phản hồi thứ 3");
await waitIndexed();
await say("Chi", "SR-1042 gọi lại, có lịch sử gì không?");

section("3. Ban giao ca");
await say("Binh", "bàn giao: CS-0924-003 đang chờ L2 NovaSoft, đã hứa gọi lại SR-1077 lúc 16:00");
await waitIndexed();
await say("Dung", "ca trước bàn giao gì cho tao?");

section("4. Team day bot");
// Kien thuc KHONG co trong tai lieu -> chi tra loi dung duoc neu bot nho dieu Dung day.
await say("Dung", "dạy: SR báo 'Phiên đăng nhập hết hạn' liên tục ngay sau khi đổi mật khẩu thì bảo SR đăng xuất hẳn, xoá cache app FieldGo rồi đăng nhập lại; không cần mở khoá tài khoản, không cần escalate");
await waitIndexed();
await say("An", "SR vừa đổi mật khẩu xong cứ bị báo phiên đăng nhập hết hạn, xử lý sao?");

section("5. Phat hien su co dien rong");
await say("Binh", "log: SR-1077 báo đơn không đẩy sang DMS, treo trạng thái Đang gửi");
await waitIndexed();
await say("Chi", "log: SR-2031 báo đơn không vào DMS, kẹt ở Đang gửi");

console.log("\nXong.");
process.exit(0);
