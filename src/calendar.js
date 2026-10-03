/**
 * calendar.js
 * Google Calendar API の薄いラッパーと、日付・時刻の解釈ユーティリティ。
 * 日時はすべて JST（Asia/Tokyo）前提。index.js で process.env.TZ を固定している。
 */
const { google } = require("googleapis");

const TZ = "Asia/Tokyo";

// ── 認証 ────────────────────────────────────────────────
// 以前は API 呼び出しのたびに JWT を作り直していたため、毎回アクセストークンの取得
// （Google への追加の往復）が発生し、ボタン操作の応答が遅くなっていた。
// クライアントを使い回せば、トークンは期限が切れたときだけ自動更新される。
let calendarClient = null;

function getCalendar() {
  if (calendarClient) return calendarClient;
  const email = process.env.GOOGLE_CLIENT_EMAIL;
  const key   = process.env.GOOGLE_PRIVATE_KEY;
  if (!email || !key) {
    throw new Error("GOOGLE_CLIENT_EMAIL / GOOGLE_PRIVATE_KEY が設定されていません");
  }
  const auth = new google.auth.JWT({
    email,
    key: key.replace(/\\n/g, "\n"),
    scopes: ["https://www.googleapis.com/auth/calendar"],
  });
  calendarClient = google.calendar({ version: "v3", auth, timeout: 15000 });
  return calendarClient;
}

// ── 取得系 ──────────────────────────────────────────────
// 1か月あたりに取得する上限（安全弁）。予定が多い月でも取りこぼさないようページングする
const MAX_EVENTS_PER_MONTH = 1000;

async function getMonthEvents(calendarId, year, month) {
  const calendar = getCalendar();
  // 月末 23:59:59 ではなく翌月 1 日 0:00 を上限（排他）にする
  const timeMin  = new Date(year, month - 1, 1).toISOString();
  const timeMax  = new Date(year, month, 1).toISOString();
  const items    = [];
  let pageToken;
  do {
    const res = await calendar.events.list({
      calendarId, timeMin, timeMax, singleEvents: true, orderBy: "startTime", maxResults: 250, pageToken,
    });
    items.push(...(res.data.items || []));
    pageToken = res.data.nextPageToken;
  } while (pageToken && items.length < MAX_EVENTS_PER_MONTH);
  return items.filter(e => e.status !== "cancelled");
}

async function getEvent(calendarId, eventId) {
  const res = await getCalendar().events.get({ calendarId, eventId });
  return res.data;
}

async function deleteEvent(calendarId, eventId) {
  await getCalendar().events.delete({ calendarId, eventId });
}

// ── 入力の正規化・検証 ─────────────────────────────────
function toHalfWidth(str) {
  return String(str ?? "")
    .replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[：]/g, ":")
    .replace(/[／]/g, "/")
    .replace(/[－ー−]/g, "-")
    .trim();
}

function pad2(n) { return String(n).padStart(2, "0"); }

function ymd(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

/**
 * 日付入力を YYYY-MM-DD に正規化する。不正なら null。
 * 受け付ける形式: 2026-05-20 / 2026/5/20 / 20260520 / 5/20（今年）
 */
function normalizeDate(input, now = new Date()) {
  const s = toHalfWidth(input);
  let y, m, d;
  let mt;
  if ((mt = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/))) [, y, m, d] = mt;
  else if ((mt = s.match(/^(\d{4})(\d{2})(\d{2})$/))) [, y, m, d] = mt;
  else if ((mt = s.match(/^(\d{1,2})[-/.](\d{1,2})$/))) { y = now.getFullYear(); [, m, d] = mt; }
  else return null;
  y = Number(y); m = Number(m); d = Number(d);
  const date = new Date(y, m - 1, d);
  if (date.getFullYear() !== y || date.getMonth() !== m - 1 || date.getDate() !== d) return null;
  return ymd(date);
}

/**
 * 時刻入力を HH:MM に正規化する。空なら ""、不正なら null。
 * 24 時以降（翌日扱い）は 47:59 まで受け付ける。
 * 受け付ける形式: 21:00 / 2100 / 900 / 21 / 21時 / 21時30分
 */
function normalizeTime(input) {
  const s = toHalfWidth(input).replace(/時/g, ":").replace(/分/g, "");
  if (!s) return "";
  let h, m;
  let mt;
  if ((mt = s.match(/^(\d{1,2}):(\d{0,2})$/))) { h = Number(mt[1]); m = Number(mt[2] || 0); }
  else if ((mt = s.match(/^(\d{3,4})$/))) { const p = mt[1].padStart(4, "0"); h = Number(p.slice(0, 2)); m = Number(p.slice(2)); }
  else if ((mt = s.match(/^(\d{1,2})$/))) { h = Number(mt[1]); m = 0; }
  else return null;
  if (h > 47 || m > 59) return null;
  return `${pad2(h)}:${pad2(m)}`;
}

function timeToMinutes(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

// 24時以上の時刻入力対応 (27:00 = 翌3時 等)
function resolveDateTime(dateStr, totalMinutes) {
  const [y, mo, d] = dateStr.split("-").map(Number);
  const date = new Date(y, mo - 1, d, 0, totalMinutes);
  return `${ymd(date)}T${pad2(date.getHours())}:${pad2(date.getMinutes())}:00+09:00`;
}

function addDays(dateStr, days) {
  const [y, mo, d] = dateStr.split("-").map(Number);
  return ymd(new Date(y, mo - 1, d + days));
}

/**
 * 入力から start/end を組み立てる。
 * - 終日: end は「翌日」（Google の終日予定は end が排他のため。同日だと範囲が空になる）
 * - 終了時刻が開始より前なら翌日とみなす（21:00〜01:00 → 翌 1:00）
 * - 終了時刻なしは開始と同時刻
 */
function buildTimes({ dateStr, startTime, endTime }) {
  if (!startTime) {
    return { start: { date: dateStr }, end: { date: addDays(dateStr, 1) } };
  }
  const s = timeToMinutes(startTime);
  let e = endTime ? timeToMinutes(endTime) : s;
  if (e < s) e += 24 * 60;
  return {
    start: { dateTime: resolveDateTime(dateStr, s), timeZone: TZ },
    end:   { dateTime: resolveDateTime(dateStr, e), timeZone: TZ },
  };
}

// ── 更新系 ──────────────────────────────────────────────
async function addEvent(calendarId, { title, dateStr, startTime, endTime, description }) {
  const res = await getCalendar().events.insert({
    calendarId,
    requestBody: { summary: title, description: description || "", ...buildTimes({ dateStr, startTime, endTime }) },
  });
  return res.data;
}

/**
 * 既存の予定を更新する。
 * patch だと start/end がマージされ、「時刻あり → 終日」に変えたときに dateTime と date が
 * 両方残ってエラーになるため、取得 → 置き換え → update で丸ごと差し替える
 * （場所や参加者など、Bot が扱わない項目はそのまま保持される）。
 */
async function updateEvent(calendarId, eventId, { title, dateStr, startTime, endTime, description }) {
  const current = await getEvent(calendarId, eventId);
  const { start, end } = buildTimes({ dateStr, startTime, endTime });
  const res = await getCalendar().events.update({
    calendarId,
    eventId,
    requestBody: { ...current, summary: title, description: description || "", start, end },
  });
  return res.data;
}

// ── 表示・判定 ─────────────────────────────────────────
/** 予定の開始時刻（終日予定は JST のその日の 0:00） */
function eventStart(event) {
  if (event.start?.dateTime) return new Date(event.start.dateTime);
  const [y, m, d] = String(event.start?.date || "").split("-").map(Number);
  return new Date(y, m - 1, d);
}

function eventStartMs(event) {
  return eventStart(event).getTime();
}

function isAllDay(event) {
  return !event.start?.dateTime;
}

function hashString(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) { h = (h << 5) - h + str.charCodeAt(i); h |= 0; }
  return h.toString(16);
}

function hashEvents(events) {
  return hashString(events.map(e => `${e.id}:${e.updated}`).join("|"));
}

function hhmm(date) {
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

function formatEvent(event, lang = "ja") {
  const date     = eventStart(event);
  const weekdays = lang === "en"
    ? ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
    : ["日", "月", "火", "水", "木", "金", "土"];
  const d = date.getDate();
  const w = weekdays[date.getDay()];
  let timeStr = lang === "en" ? "All day" : "終日";
  if (event.start?.dateTime) {
    timeStr = hhmm(date);
    if (event.end?.dateTime) {
      const end = new Date(event.end.dateTime);
      if (end.getTime() > date.getTime()) {
        const dayDiff = Math.round((new Date(end.getFullYear(), end.getMonth(), end.getDate()) - new Date(date.getFullYear(), date.getMonth(), date.getDate())) / 86400000);
        const endLabel = dayDiff > 0 ? (lang === "en" ? `${hhmm(end)}(+${dayDiff}d)` : `翌${dayDiff > 1 ? `${dayDiff}日` : ""}${hhmm(end)}`) : hhmm(end);
        timeStr += `${lang === "en" ? "-" : "〜"}${endLabel}`;
      }
    }
  }
  const desc = event.description ? `\n　${event.description}` : "";
  return { d, w, timeStr, title: event.summary || (lang === "en" ? "(Untitled)" : "(無題)"), desc, id: event.id };
}

/** 編集モーダルの初期値（翌日にまたがる終了時刻は 25:00 形式で返す） */
function toFormValues(event) {
  const start = eventStart(event);
  const dateStr = ymd(start);
  if (!event.start?.dateTime) return { dateStr, startTime: "", endTime: "" };
  const startTime = hhmm(start);
  let endTime = "";
  if (event.end?.dateTime) {
    const end = new Date(event.end.dateTime);
    const minutes = Math.round((end - new Date(start.getFullYear(), start.getMonth(), start.getDate())) / 60000);
    if (minutes > timeToMinutes(startTime) && minutes < 48 * 60) endTime = `${pad2(Math.floor(minutes / 60))}:${pad2(minutes % 60)}`;
  }
  return { dateStr, startTime, endTime };
}

module.exports = {
  getMonthEvents, addEvent, updateEvent, getEvent, deleteEvent,
  hashEvents, hashString, formatEvent, toFormValues,
  normalizeDate, normalizeTime, buildTimes,
  eventStart, eventStartMs, isAllDay,
};
