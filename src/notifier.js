/**
 * notifier.js
 * per-guild 通知チェック・送信
 */
const { EmbedBuilder, RESTJSONErrorCodes } = require("discord.js");
const { getEvent, formatEvent, eventStartMs, isAllDay } = require("./calendar");
const { loadNotices, markNoticesFired, deleteNoticesForEvent, addPendingDelete, takeDuePendingDeletes } = require("./storage");
const { getLang, pick } = require("./i18n");

const HOUR = 60 * 60 * 1000;
// 終日予定の通知は当日 9:00 を基準にする（0:00 基準だと「1時間前」が前日 23:00 になるため。従来互換）
const ALL_DAY_BASE_OFFSET_MS = 9 * HOUR;
// 予定開始からこの時間を過ぎた通知設定は掃除する
const NOTICE_EXPIRE_AFTER_MS = 24 * HOUR;
// 自動削除に失敗し続けたメッセージを諦めるまでの回数
const MAX_DELETE_ATTEMPTS = 5;

/** Google Calendar の「その予定は存在しない」応答かどうか */
function isEventNotFound(err) {
  const code = err?.code || err?.status || err?.response?.status;
  return code === 404 || code === 410;
}

function noticeBaseMs(event) {
  return eventStartMs(event) + (isAllDay(event) ? ALL_DAY_BASE_OFFSET_MS : 0);
}

/** この開始時刻に対して既に送ったか（予定が移動されたら firedFor が変わるので再送される） */
function alreadyFired(notice, startKey) {
  if (!notice.firedAt) return false;
  if (!notice.firedFor) return true; // 旧データ（firedFor なし）は送信済み扱い
  return notice.firedFor === startKey;
}

function mentionOf(n) {
  if (n.roleId === "@everyone" || n.roleId === "@here") return n.roleId;
  return n.targetType === "user" ? `<@${n.roleId}>` : `<@&${n.roleId}>`;
}

function timingLabel(minutesBefore, lang) {
  return minutesBefore >= 60
    ? (lang === "en" ? `${minutesBefore / 60}h before` : `${minutesBefore / 60}時間前`)
    : (lang === "en" ? `${minutesBefore}m before` : `${minutesBefore}分前`);
}

/**
 * @param {Client} client
 * @param {string} guildId
 * @param {{ calendarId, notifyChannelId, channelId }} config
 * @param {Array} horizonEvents 呼び出し側が取得済みの今月＋来月の予定
 */
async function checkAndFireNotices(client, guildId, config, horizonEvents) {
  const lang = getLang(config);
  const notices = loadNotices(guildId);
  if (Object.keys(notices).length === 0) return;

  const now      = Date.now();
  const eventMap = new Map((horizonEvents || []).map(e => [e.id, e]));

  const hasNotifyChannel = !!config.notifyChannelId;
  const channelId = config.notifyChannelId || config.channelId;
  const channel   = await client.channels.fetch(channelId).catch(() => null);
  if (!channel?.isTextBased?.()) {
    console.error(`[Notify][${guildId}] 通知チャンネルにアクセスできません: ${channelId}`);
    return;
  }

  // 通知チャンネルあり → 7日、なし（カレンダーチャンネル）→ 1日
  const deleteAfterMs = hasNotifyChannel ? 7 * 24 * HOUR : 24 * HOUR;

  for (const [eventId, settings] of Object.entries(notices)) {
    const event = eventMap.get(eventId);
    if (!event) continue;

    const startMs  = eventStartMs(event);
    const baseMs   = noticeBaseMs(event);
    const startKey = event.start.dateTime || event.start.date;

    // 時刻ありの予定が既に始まっていたら、遅れて「◯分前」を送っても意味がないので送らずに済ませる
    // （Bot 停止中に通知時刻を過ぎた場合や、直前に通知を追加した場合）
    const started = !isAllDay(event) && now >= startMs;

    const groups = new Map(); // minutesBefore → notice[]
    const skipped = [];
    for (const s of settings) {
      if (alreadyFired(s, startKey)) continue;
      if (now < baseMs - s.minutesBefore * 60 * 1000) continue;
      if (started) { skipped.push(s); continue; }
      if (!groups.has(s.minutesBefore)) groups.set(s.minutesBefore, []);
      groups.get(s.minutesBefore).push(s);
    }
    if (skipped.length > 0) markNoticesFired(guildId, eventId, skipped, startKey);

    const f = formatEvent(event, lang);
    for (const [minutesBefore, group] of groups) {
      const hoursText = timingLabel(minutesBefore, lang);
      const mentions  = group.map(mentionOf).join(" ");

      const deleteAt   = new Date(now + deleteAfterMs);
      const pad        = (n) => String(n).padStart(2, "0");
      const stamp      = `${pad(deleteAt.getMonth() + 1)}/${pad(deleteAt.getDate())} ${pad(deleteAt.getHours())}:${pad(deleteAt.getMinutes())}`;
      const footerText = hasNotifyChannel
        ? pick(lang, `🗑️ あと7日で削除（${stamp}）`, `🗑️ Auto-delete in 7 days (${stamp})`)
        : pick(lang, `🗑️ あと24時間で削除（${stamp}）`, `🗑️ Auto-delete in 24h (${stamp})`);

      const descText = f.desc ? f.desc.replace(/^\n　/, "") : "";
      const embed = new EmbedBuilder()
        .setColor(0xfee75c)
        .setTitle(pick(lang, `⏰ 予定のお知らせ（${hoursText}）`, `⏰ Event Reminder (${hoursText})`))
        .setDescription(
          `**${f.title}**\n` +
          (lang === "en" ? `📅 ${f.w} ${f.d}  \`${f.timeStr}\`` : `📅 ${f.d}日(${f.w})　\`${f.timeStr}\``) +
          (descText ? `\n📝 ${descText.slice(0, 3500)}` : "")
        )
        .setFooter({ text: footerText })
        .setTimestamp();

      try {
        const msg = await channel.send({ content: mentions, embeds: [embed] });
        // 送信直後に印を付ける（先に削除キューへ積むと、そこで失敗したときに二重送信になる）
        markNoticesFired(guildId, eventId, group, startKey);
        addPendingDelete(guildId, { channelId: msg.channelId, messageId: msg.id, deleteAt: now + deleteAfterMs });
        console.log(`[Notify][${guildId}] 送信: ${f.title} → ${mentions} (${hoursText})`);
      } catch (err) {
        console.error(`[Notify][${guildId}] 送信失敗: ${err.message}`);
      }
    }
  }

  // 開始から24時間経過した予定・削除された予定の通知設定を掃除する
  for (const eventId of Object.keys(notices)) {
    let event = eventMap.get(eventId);
    if (!event) {
      // 今月・来月の範囲外（先月の予定や再来月以降の予定）は直接問い合わせる
      try {
        event = await getEvent(config.calendarId, eventId);
      } catch (err) {
        if (isEventNotFound(err)) {
          deleteNoticesForEvent(guildId, eventId);
          console.log(`[Notify][${guildId}] 予定が存在しないため通知削除: ${eventId}`);
        }
        // 一時的な API エラーのときは設定を残す
        continue;
      }
      if (!event || event.status === "cancelled") {
        deleteNoticesForEvent(guildId, eventId);
        console.log(`[Notify][${guildId}] 予定が取り消されたため通知削除: ${eventId}`);
        continue;
      }
    }
    // 以前は「今月・来月に含まれる予定」しか期限切れ判定しておらず、
    // 先月の予定の通知設定が永遠に残り、毎回 API を叩き続けていた
    if (now > eventStartMs(event) + NOTICE_EXPIRE_AFTER_MS) {
      deleteNoticesForEvent(guildId, eventId);
      console.log(`[Notify][${guildId}] 期限切れ通知削除: ${eventId}`);
    }
  }
}

/** 予約削除キューを処理する（同期ごとに呼ばれる） */
async function sweepPendingDeletes(client, guildId) {
  const GONE = new Set([
    RESTJSONErrorCodes.UnknownMessage,
    RESTJSONErrorCodes.UnknownChannel,
    RESTJSONErrorCodes.MissingAccess,
    RESTJSONErrorCodes.MissingPermissions,
  ]);
  for (const entry of takeDuePendingDeletes(guildId)) {
    try {
      const channel = await client.channels.fetch(entry.channelId);
      await channel.messages.delete(entry.messageId);
      console.log(`[Notify][${guildId}] 通知メッセージを自動削除: ${entry.messageId}`);
    } catch (err) {
      // 既に消えている・権限がない場合は諦める。一時的な失敗（レート制限・通信断）は後で再試行する
      const attempts = (entry.attempts || 0) + 1;
      if (!GONE.has(err?.code) && attempts < MAX_DELETE_ATTEMPTS) {
        addPendingDelete(guildId, { ...entry, attempts, deleteAt: Date.now() + 10 * 60 * 1000 });
      }
    }
  }
}

module.exports = { checkAndFireNotices, sweepPendingDeletes, mentionOf, timingLabel };
