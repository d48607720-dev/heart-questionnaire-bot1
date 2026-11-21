const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { Telegraf, Markup } = require("telegraf");

const BOT_TOKEN = process.env.BOT_TOKEN;
const OWNER_ID = process.env.OWNER_ID || "7948603698";
const WEBAPP_URL = process.env.WEBAPP_URL;
const PORT = process.env.PORT || 3000;
const DATA_FILE = process.env.DATA_FILE || "/data/access.json";

if (!BOT_TOKEN || !WEBAPP_URL) {
  throw new Error("Set BOT_TOKEN and WEBAPP_URL environment variables.");
}

const bot = new Telegraf(BOT_TOKEN);
const app = express();
app.use(express.json({ limit: "30kb" }));
app.use(express.static("public"));

function readState() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, "utf8")); }
  catch { return { claimedBy: null, completed: false }; }
}
function writeState(state) {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  const temp = DATA_FILE + ".tmp";
  fs.writeFileSync(temp, JSON.stringify(state), "utf8");
  fs.renameSync(temp, DATA_FILE);
}

function verifyTelegramInitData(initData) {
  if (!initData) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return null;
  params.delete("hash");
  const dataCheckString = [...params.entries()].sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`).join("\n");
  const secretKey = crypto.createHmac("sha256", "WebAppData").update(BOT_TOKEN).digest();
  const calculated = crypto.createHmac("sha256", secretKey).update(dataCheckString).digest("hex");
  const a = Buffer.from(calculated, "hex"), b = Buffer.from(hash, "hex");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  const authDate = Number(params.get("auth_date"));
  if (!authDate || Date.now() / 1000 - authDate > 86400) return null;
  try { return JSON.parse(params.get("user") || "{}"); } catch { return null; }
}

bot.start(async (ctx) => {
  await ctx.reply(
    "Привет! Здесь небольшая анкета 💗 Открой её, если хочешь ответить на несколько вопросов.",
    Markup.inlineKeyboard([Markup.button.webApp("Открыть анкету 💌", WEBAPP_URL)])
  );
});
bot.command("help", (ctx) => ctx.reply("Нажми /start, чтобы открыть анкету."));

app.post("/api/claim", (req, res) => {
  const user = verifyTelegramInitData(req.body && req.body.initData);
  if (!user || !user.id) return res.status(401).json({ ok: false, error: "Открой анкету через Telegram." });
  const state = readState();
  const id = String(user.id);
  if (state.claimedBy && state.claimedBy !== id)
    return res.status(403).json({ ok: false, error: "Эта анкета уже закреплена за другим аккаунтом." });
  if (state.completed)
    return res.status(409).json({ ok: false, error: "Анкета уже заполнена. Повторно отправить ответы нельзя." });
  if (!state.claimedBy) { state.claimedBy = id; writeState(state); }
  return res.json({ ok: true });
});

app.post("/api/answers", async (req, res) => {
  const user = verifyTelegramInitData(req.body && req.body.initData);
  if (!user || !user.id) return res.status(401).json({ ok: false, error: "Открой анкету через Telegram." });

  const state = readState();
  if (!state.claimedBy || state.claimedBy !== String(user.id))
    return res.status(403).json({ ok: false, error: "Эта анкета закреплена за другим аккаунтом." });
  if (state.completed)
    return res.status(409).json({ ok: false, error: "Ответы уже отправлены. Повторная отправка отключена." });

  const answers = req.body && req.body.answers;
  if (!answers || typeof answers !== "object" || !Array.isArray(answers.items))
    return res.status(400).json({ ok: false, error: "Некорректные ответы." });

  const safe = (v) => String(v || "—").slice(0, 500);
  const name = [user.first_name, user.last_name].filter(Boolean).join(" ");
  const username = user.username ? `@${user.username}` : "нет username";
  const lines = ["💌 Новая анкета!", `От: ${safe(name)} (${username})`, `Telegram ID: ${user.id}`, ""];
  for (const item of answers.items) lines.push(`${safe(item.question)}\n${safe(item.answer)}\n`);
  lines.push(`Финальный ответ: ${safe(answers.finalAnswer)}`);

  try {
    state.completed = true;
    writeState(state);
    await bot.telegram.sendMessage(OWNER_ID, lines.join("\n"));
    res.json({ ok: true });
  } catch (err) {
    state.completed = false;
    writeState(state);
    console.error("Не удалось отправить ответы владельцу:", err.message);
    res.status(500).json({ ok: false, error: "Не удалось доставить ответы." });
  }
});

bot.launch();
app.listen(PORT, () => console.log(`App listening on ${PORT}`));
process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
