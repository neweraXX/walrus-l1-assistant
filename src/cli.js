// Test bot tren terminal, khong can Zalo. Doi vai nguoi dung bang: /as <ten>
//   docker compose run --rm l1-assistant node src/cli.js An
import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { bootstrap } from "./bootstrap.js";

const { assistant, knowledge } = await bootstrap({ needZalo: false });
let name = process.argv[2] || "An";
const rl = readline.createInterface({ input: stdin, output: stdout });

console.log(`L1 Assistant CLI (${knowledge.fileCount} file tai lieu). Dang dong vai "${name}".`);
console.log('Go /help de xem lenh, "/as Chi" de doi nguoi, Ctrl+C de thoat.\n');

while (true) {
  const line = (await rl.question(`${name}> `)).trim();
  if (!line) continue;
  const as = line.match(/^\/as\s+(.+)$/i);
  if (as) {
    name = as[1].trim();
    console.log(`(gio dong vai "${name}")\n`);
    continue;
  }
  try {
    const replies = await assistant.handle({ chatId: "cli-group", userId: `cli-${name.toLowerCase()}`, userName: name, text: line });
    for (const r of replies) console.log(`\nbot> ${r}\n`);
  } catch (err) {
    console.error(`\nLOI: ${err.message}\n`);
  }
}
