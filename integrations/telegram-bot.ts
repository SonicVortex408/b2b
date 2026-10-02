/**
 * XIE Spaces Telegram bot (grammY). Same intent parser + engine as the web assistant.
 *   TELEGRAM_BOT_TOKEN=... npx tsx integrations/telegram-bot.ts
 */
import { Bot, InlineKeyboard } from "grammy";
import { parseIntent } from "@/lib/intent";
import { create, search } from "@/lib/server/host";
import { addDays, nowMinutes, parse24, todayISO } from "@/lib/time";

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) throw new Error("Set TELEGRAM_BOT_TOKEN");
const bot = new Bot(token);

bot.command("start", (c) => c.reply("Hi! Tell me what you need, e.g. \"hall for 80 people with a projector this Friday evening\"."));

bot.on("message:text", async (c) => {
  const intent = parseIntent(c.message.text.slice(0, 500), todayISO(), nowMinutes());
  if (intent.confidence < 0.8 && intent.clarifying_question) return c.reply(intent.clarifying_question);
  const opts = search(intent);
  if (!opts.length) return c.reply("Nothing free matches. Try another time.");
  const kb = new InlineKeyboard();
  opts.forEach((o, i) => kb.text(`${i + 1}. Book ${o.room}`, `b|${o.room_id}|${o.date}|${o.start_hhmm}|${intent.duration_minutes}|${intent.purpose}|${intent.min_capacity ?? 10}`).row());
  await c.reply(opts.map((o, i) => `${i + 1}. ${o.room} · L${o.floor} · ${o.capacity} seats\n   ${o.date} ${o.start}–${o.end} · ${o.why}`).join("\n"), { reply_markup: kb });
});

bot.callbackQuery(/^b\|/, async (c) => {
  const [, room, date, start, dur, purpose, ppl] = c.callbackQuery.data.split("|");
  const s = parse24(start);
  const end = s + Number(dur);
  const res = create({
    roomIds: [room],
    date: date || addDays(todayISO(), 0),
    start,
    end: `${String(Math.floor(end / 60)).padStart(2, "0")}:${String(end % 60).padStart(2, "0")}`,
    title: "Telegram booking",
    purpose: purpose as never,
    attendees: Number(ppl),
    requester: c.from.username ? `@${c.from.username}` : c.from.first_name,
    role: "student",
  });
  await c.answerCallbackQuery();
  await c.reply(res.explanation);
});

bot.start();
console.log("XIE Spaces bot running");
