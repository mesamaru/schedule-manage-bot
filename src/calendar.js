/**
 * calendar.js v5
 * 全関数に calendarId 引数を追加（per-guild 対応）
 */
const { google } = require("googleapis");

function getAuth() {
  return new google.auth.JWT({
    email: process.env.GOOGLE_CLIENT_EMAIL,
    key:   process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, "\n"),
    scopes: ["https://www.googleapis.com/auth/calendar"],
  });
}

// 1か月あたりに取得する上限（安全弁）。予定が多い月でも取りこぼさないようページングする
const MAX_EVENTS_PER_MONTH = 1000;

async function getMonthEvents(calendarId, year, month) {
  const auth     = getAuth();
  const calendar = google.calendar({ version: "v3", auth });
  const timeMin  = new Date(year, month - 1, 1).toISOString();
  const timeMax  = new Date(year, month, 0, 23, 59, 59).toISOString();
  const items    = [];
  let pageToken;
  do {
    const res = await calendar.events.list({
      calendarId, timeMin, timeMax, singleEvents: true, orderBy: "startTime", maxResults: 250, pageToken,
    });
    items.push(...(res.data.items || []));
    pageToken = res.data.nextPageToken;
  } while (pageToken && items.length < MAX_EVENTS_PER_MONTH);
  return items;
}

// 24時以上の時刻入力対応 (2700 = 翌3時 等)
function resolveDateTime(dateStr, timeStr) {
  const [h, m] = timeStr.split(":").map(Number);
  if (h < 24) return `${dateStr}T${timeStr}:00+09:00`;
  const extraDays = Math.floor(h / 24);
  const normalH   = h % 24;
  const [y, mo, d] = dateStr.split("-").map(Number);
  const date = new Date(y, mo - 1, d + extraDays);
  const nd = [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
  return `${nd}T${String(normalH).padStart(2, "0")}:${String(m).padStart(2, "0")}:00+09:00`;
}

async function addEvent(calendarId, { title, dateStr, startTime, endTime, description }) {
  const auth     = getAuth();
  const calendar = google.calendar({ version: "v3", auth });
  const start = startTime
    ? { dateTime: resolveDateTime(dateStr, startTime), timeZone: "Asia/Tokyo" }
    : { date: dateStr };
  const end = startTime
    ? { dateTime: resolveDateTime(dateStr, endTime || startTime), timeZone: "Asia/Tokyo" }
    : { date: dateStr };
  const res = await calendar.events.insert({
    calendarId,
    requestBody: { summary: title, description: description || "", start, end },
  });
  return res.data;
}

async function updateEvent(calendarId, eventId, { title, dateStr, startTime, endTime, description }) {
  const auth     = getAuth();
  const calendar = google.calendar({ version: "v3", auth });
  const start = startTime
    ? { dateTime: resolveDateTime(dateStr, startTime), timeZone: "Asia/Tokyo" }
    : { date: dateStr };
  const end = startTime
    ? { dateTime: resolveDateTime(dateStr, endTime || startTime), timeZone: "Asia/Tokyo" }
    : { date: dateStr };
  const res = await calendar.events.patch({
    calendarId,
    eventId,
    requestBody: { summary: title, description: description || "", start, end },
  });
  return res.data;
}

async function getEvent(calendarId, eventId) {
  const auth     = getAuth();
  const calendar = google.calendar({ version: "v3", auth });
  const res = await calendar.events.get({ calendarId, eventId });
  return res.data;
}

async function deleteEvent(calendarId, eventId) {
  const auth     = getAuth();
  const calendar = google.calendar({ version: "v3", auth });
  await calendar.events.delete({ calendarId, eventId });
}

function hashEvents(events) {
  const str = events.map(e => `${e.id}:${e.updated}`).join("|");
  let h = 0;
  for (let i = 0; i < str.length; i++) { h = (h << 5) - h + str.charCodeAt(i); h = h & h; }
  return h.toString(16);
}

function formatEvent(event, lang = "ja") {
  const start    = event.start.dateTime || event.start.date;
  const date     = new Date(start);
  const weekdays = lang === "en"
    ? ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
    : ["日","月","火","水","木","金","土"];
  const d = date.getDate();
  const w = weekdays[date.getDay()];
  let timeStr = lang === "en" ? "All day" : "終日";
  if (event.start.dateTime) {
    const h = date.getHours().toString().padStart(2,"0");
    const m = date.getMinutes().toString().padStart(2,"0");
    timeStr = `${h}:${m}`;
    if (event.end?.dateTime) {
      const end = new Date(event.end.dateTime);
      timeStr += `${lang === "en" ? "-" : "〜"}${end.getHours().toString().padStart(2,"0")}:${end.getMinutes().toString().padStart(2,"0")}`;
    }
  }
  const desc = event.description ? `\n　${event.description}` : "";
  return { d, w, timeStr, title: event.summary || (lang === "en" ? "(Untitled)" : "(無題)"), desc, id: event.id };
}

module.exports = { getMonthEvents, addEvent, updateEvent, getEvent, deleteEvent, hashEvents, formatEvent };
