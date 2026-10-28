// Demo co dan chuyen (tieng Anh) de quay video: chay that tren Walrus mainnet + LLM that.
// Bo nho (handover, case log, team knowledge, ...) ghi vao namespace MOI "<prefix>-demo-<gio>"
// de khong lan du lieu cu; kho tai lieu dung chung "<prefix>:kb" (nap 1 lan bang kbIndex.js).
//   docker compose run --rm l1-assistant node src/kbIndex.js   (1 lan)
//   docker compose run --rm l1-assistant node src/demo.js
const base = process.env.NAMESPACE_PREFIX || "l1demo";
const runId = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");
process.env.NAMESPACE_PREFIX = `${base}-demo-${runId}`;
process.env.KB_NAMESPACE ||= `${base}:kb`;
// Dung la nguoi duoc duyet day bot trong demo (mac dinh chi lead).
process.env.KB_APPROVERS = `${process.env.KB_APPROVERS || "Ha"},Dung`;

// An log noi bo ("[memory] ...", "[recall] ...") cho man hinh demo gon; loi that van in o say().
for (const k of ["log", "warn", "error"]) {
  const orig = console[k].bind(console);
  console[k] = (...a) => (/^\[[\w-]+\]/.test(String(a[0])) ? undefined : orig(...a));
}

const { bootstrap } = await import("./bootstrap.js");
const { assistant, memory, cfg, ask } = await bootstrap({ needZalo: false });

const C = { dim: "\x1b[2m", bold: "\x1b[1m", cyan: "\x1b[36m", yellow: "\x1b[33m", green: "\x1b[32m", magenta: "\x1b[35m", reset: "\x1b[0m" };
const users = { An: "u-an", Binh: "u-binh", Chi: "u-chi", Dung: "u-dung" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Nghi giua cac cau: nguoi xem kip doc + khong vuot gioi han relayer (60 request co trong so/phut
// moi delegate key; moi cau hoi tra 5-7 kho cung luc).
const PAUSE = Number(process.env.DEMO_PAUSE_MS || 8000);

// Bo markup Zalo ({green}, \*, #) cho de doc tren terminal.
const clean = (s) =>
  String(s)
    .replace(/\{\/?\w+\}/g, "")
    .replace(/\\([\\*_`~#>])/g, "$1")
    .replace(/\*\*/g, "")
    .replace(/^#\s*/gm, "")
    .replace(/^_(.*)_$/gm, "$1");

function scene(n, title, note) {
  console.log(`\n${C.yellow}${"━".repeat(72)}\n▶ ${n}. ${title}${C.reset}`);
  if (note) console.log(`${C.dim}${note}${C.reset}`);
}

// Phu de tieng Anh cho nguoi xem: bot van tra loi tieng Viet nhu khi team dung that.
async function translate(text) {
  try {
    return await ask({
      system: "Translate this Vietnamese support-chatbot message into natural English. Keep line breaks, numbering, emojis, codes (SR-1042, OUT-0007...), names and product names exactly. Output only the translation.",
      prompt: text,
    });
  } catch {
    return "";
  }
}
const sub = (en) => console.log(`\x1b[3;37m   🇬🇧 ${String(en).trim().replace(/\n/g, "\n      ")}${C.reset}`);

async function say(name, chat, text, en) {
  console.log(`\n${C.cyan}${C.bold}👤 ${name}${C.reset}${C.dim} [${chat}]${C.reset} ${text}`);
  if (en) sub(en);
  for (let attempt = 1; ; attempt++) {
    const t = Date.now();
    try {
      // Phong chat rieng cho moi lan chay (khong dinh doan chat cua lan demo truoc trong state/).
      const replies = await assistant.handle({ chatId: `demo-${runId}-${chat}`, userId: users[name], userName: name, text });
      const secs = ((Date.now() - t) / 1000).toFixed(1);
      for (const r of replies) {
        if (typeof r !== "string") continue;
        console.log(`${C.green}🤖 (${secs}s)${C.reset}\n${clean(r)}`);
        const en = await translate(clean(r));
        if (en) sub(en);
      }
      break;
    } catch (err) {
      // Relayer gioi han toc do (429): cho het cua so roi thu lai 1 lan.
      const wait = err.status === 429 && attempt === 1 ? (err.retryAfterSeconds || 60) : 0;
      if (!wait) {
        console.log(`❌ error (${((Date.now() - t) / 1000).toFixed(1)}s): ${err.message}`);
        break;
      }
      console.log(`${C.magenta}   ⏳ Walrus relayer rate limit, retrying in ${wait}s...${C.reset}`);
      await sleep(wait * 1000);
    }
  }
  await sleep(PAUSE);
}

async function waitIndexed() {
  const t = Date.now();
  process.stdout.write(`${C.magenta}   ⏳ Walrus Memory: embedding + SEAL encryption + upload to Walrus mainnet...${C.reset}`);
  await memory.flush();
  console.log(`${C.magenta} done (${((Date.now() - t) / 1000).toFixed(0)}s)${C.reset}`);
}

console.log(`${C.bold}L1 Assistant — Walrus Memory demo${C.reset}`);
console.log(`${C.dim}Fictional data (FieldGo app, Sunrise Beverages). LLM: ${cfg.llm.model}. Memory namespace: ${cfg.namespacePrefix}, docs: ${process.env.KB_NAMESPACE}${C.reset}`);
console.log(`${C.dim}Team: An, Binh (morning shift) · Chi, Dung (afternoon shift). The team works in Vietnamese, so does the bot — English subtitles (🇬🇧) added for this video.${C.reset}`);

scene(1, "Answering from runbooks stored in Walrus Memory", "An asks how to handle a GPS check-in error. The runbook chunks were indexed into Walrus; the bot recalls the right one and cites it.");
await say("An", "group", "SR báo check-in ngoài phạm vi GPS thì xử lý sao, có cần chuyển L2 không?", "A sales rep says check-in fails as \"outside GPS range\". How do I handle it, do I need to escalate to L2?");

scene(2, "Not documented → a teammate teaches it in plain chat", "No runbook covers Bluetooth printers, so the bot says so instead of inventing steps. Dung replies normally (no command, no quoting); the bot recognises it as teaching and links it to An's pending question.");
await say("An", "group", "Máy in Bluetooth không in được hoá đơn thì xử lý sao?", "The Bluetooth printer won't print invoices. How do I handle that?");
await say("Dung", "group", "Cái đó bảo SR tắt Bluetooth bật lại, vào cài đặt FieldGo quên thiết bị rồi ghép đôi lại máy in. Vẫn không in được thì chuyển L2 NovaSoft kèm model máy in.", "That one: tell the rep to turn Bluetooth off and on, go to FieldGo settings, forget the device and pair the printer again. If it still won't print, escalate to L2 NovaSoft with the printer model.");
await waitIndexed();

scene(3, "Another person, another chat, later → the bot remembers who taught it", "Chi (afternoon shift) asks in her direct chat, different wording. The answer comes from the memory Dung created, credited with name and time.");
await say("Chi", "dm-chi", "SR không in hoá đơn qua máy in bluetooth được, làm sao giờ?", "A rep can't print invoices on the bluetooth printer, what do I do?");

scene(4, "A rep calls back, a different agent picks up", "An logs a call for rep SR-1042. Later Binh answers SR-1042's call-back and asks for the history — stored per customer code.");
await say("An", "group", "log: SR-1042 gọi, đơn ở OUT-0007 không vào DistributorHub, báo Outlet not mapped, đã chuyển DistributorHub team, hẹn phản hồi thứ 3", "log: SR-1042 called, order at OUT-0007 not reaching DistributorHub, error 'Outlet not mapped', sent to DistributorHub team, promised a reply on Tuesday");
await waitIndexed();
await say("Binh", "dm-binh", "SR-1042 gọi lại, có lịch sử gì không?", "SR-1042 is calling back, any history?");

scene(5, "Shift handover", "Binh hands over before leaving. Dung (afternoon shift) asks what is pending.");
await say("Binh", "group", "bàn giao: CS-0924-003 đang chờ L2 NovaSoft, đã hứa gọi lại SR-1077 lúc 16:00", "handover: CS-0924-003 waiting on L2 NovaSoft, promised to call SR-1077 back at 16:00");
await waitIndexed();
await say("Dung", "group", "ca trước bàn giao gì vậy?", "What did the previous shift hand over?");

scene(6, "Spotting a widespread incident across agents", "Three different reps report the same error to different agents within an hour. Only shared memory can see the pattern.");
await say("Binh", "group", "log: SR-1077 báo đơn không đẩy sang DistributorHub, treo ở trạng thái Đang gửi", "log: SR-1077 reports orders not pushed to DistributorHub, stuck in 'Sending'");
await waitIndexed();
await say("Chi", "group", "log: SR-2031 báo đơn không vào DistributorHub, kẹt ở Đang gửi", "log: SR-2031 reports orders not reaching DistributorHub, stuck in 'Sending'");

console.log(`\n${C.yellow}${"━".repeat(72)}${C.reset}\n${C.bold}Done.${C.reset} Every memory above is SEAL-encrypted and stored on Walrus mainnet under ${cfg.namespacePrefix}:*`);
console.log("Code: https://github.com/neweraXX/walrus-l1-assistant");
process.exit(0);
