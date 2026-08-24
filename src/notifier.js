/**
 * notifier.js v5
 * per-guild 通知チェック・送信
 */
const { EmbedBuilder } = require("discord.js");
const { getMonthEvents, getEvent, formatEvent } = require("./calendar");
const { loadNotices, markNoticeFired, deleteNoticesForEvent, addPendingDelete, takeDuePendingDeletes } = require("./storage");
const { getLang, pick } = require("./i18n");

/** Google Calendar の「その予定は存在しない」応答かどうか */
function isEventNotFound(err) {
  const code = err?.code || err?.status || err?.response?.status;
  return code === 404 || code === 410;
}

/**
 * @param {Client} client
 * @param {string} guildId
 * @param {{ calendarId, notifyChannelId, channelId }} config
 * @param {Array|null} horizonEvents 呼び出し側が取得済みの今月＋来月の予定（省略時はここで取得）
 */
async function checkAndFireNotices(client, guildId, config, horizonEvents = null) {
  const lang = getLang(config);
  const notices = loadNotices(guildId);
  if (Object.keys(notices).length === 0) return;

  const now  = new Date();
  const year = now.getFullYear();

  let allEvents = horizonEvents;
  if (!allEvents) {
    const thisMonth = await getMonthEvents(config.calendarId, year, now.getMonth() + 1).catch(() => []);
    const nextMonth = await getMonthEvents(config.calendarId, year, now.getMonth() + 2).catch(() => []);
    allEvents = [...thisMonth, ...nextMonth];
  }
  const eventMap  = Object.fromEntries(allEvents.map(e => [e.id, e]));

  const hasNotifyChannel = !!config.notifyChannelId;
  const channelId = config.notifyChannelId || config.channelId;
  const channel   = await client.channels.fetch(channelId).catch(() => null);
  if (!channel) return;

  // 通知チャンネルあり → 7日、なし（カレンダーチャンネル）→ 1日
  const deleteAfterMs = hasNotifyChannel
    ? 7 * 24 * 60 * 60 * 1000
    : 24 * 60 * 60 * 1000;

  for (const [eventId, settings] of Object.entries(notices)) {
    const event = eventMap[eventId];
    if (!event) continue;

    const startMs = new Date(event.start.dateTime || event.start.date).getTime();

    const groups = new Map(); // minutesBefore → index[]
    for (let i = 0; i < settings.length; i++) {
      const s = settings[i];
      if (s.firedAt) continue;
      const notifyAt = startMs - s.minutesBefore * 60 * 1000;
      if (now.getTime() < notifyAt) continue;
      if (!groups.has(s.minutesBefore)) groups.set(s.minutesBefore, []);
      groups.get(s.minutesBefore).push(i);
    }

    const f = formatEvent(event, lang);
    for (const [minutesBefore, indices] of groups) {
      const hoursText = minutesBefore >= 60
        ? (lang === "en" ? `${minutesBefore / 60}h before` : `${minutesBefore / 60}時間前`)
        : (lang === "en" ? `${minutesBefore}m before` : `${minutesBefore}分前`);

      const mentions = indices.map(i => {
        const s = settings[i];
        if (s.roleId === "@everyone" || s.roleId === "@here") return s.roleId;
        return s.targetType === "user" ? `<@${s.roleId}>` : `<@&${s.roleId}>`;
      }).join(" ");

      // 削除予定時刻の計算とフッター文字列
      const deleteAt    = new Date(now.getTime() + deleteAfterMs);
      const mm          = String(deleteAt.getMonth() + 1).padStart(2, "0");
      const dd          = String(deleteAt.getDate()).padStart(2, "0");
      const hh          = String(deleteAt.getHours()).padStart(2, "0");
      const mi          = String(deleteAt.getMinutes()).padStart(2, "0");
      const footerText  = hasNotifyChannel
        ? pick(lang, `🗑️ あと7日で削除（${mm}/${dd} ${hh}:${mi}）`, `🗑️ Auto-delete in 7 days (${mm}/${dd} ${hh}:${mi})`)
        : pick(lang, `🗑️ あと24時間で削除（${mm}/${dd} ${hh}:${mi}）`, `🗑️ Auto-delete in 24h (${mm}/${dd} ${hh}:${mi})`);

      const embed = new EmbedBuilder()
        .setColor(0xfee75c)
        .setTitle(pick(lang, `⏰ 予定のお知らせ（${hoursText}）`, `⏰ Event Reminder (${hoursText})`))
        .setDescription(
          `**${f.title}**\n` +
          (lang === "en" ? `📅 ${f.w} ${f.d}  \`${f.timeStr}\`` : `📅 ${f.d}日(${f.w})　\`${f.timeStr}\``) +
          (f.desc ? `\n📝 ${f.desc.replace(/^\n　/, "")}` : "")
        )
        .setFooter({ text: footerText })
        .setTimestamp();

      try {
        const msg = await channel.send({ content: mentions, embeds: [embed] });
        // setTimeout は再起動で失われるため、削除予定を state に永続化して cron で回収する
        addPendingDelete(guildId, { channelId: msg.channelId, messageId: msg.id, deleteAt: now.getTime() + deleteAfterMs });
        for (const i of indices) markNoticeFired(guildId, eventId, i);
        console.log(`[Notify][${guildId}] 送信: ${f.title} → ${mentions} (${hoursText})`);
      } catch (err) {
        console.error(`[Notify][${guildId}] 送信失敗: ${err.message}`);
      }
    }
  }

  // 開始から24時間経過した予定の通知設定を掃除する
  for (const eventId of Object.keys(notices)) {
    const event = eventMap[eventId];
    if (event) {
      const startMs = new Date(event.start.dateTime || event.start.date).getTime();
      if (now.getTime() > startMs + 24 * 60 * 60 * 1000) {
        deleteNoticesForEvent(guildId, eventId);
        console.log(`[Notify][${guildId}] 期限切れ通知削除: ${eventId}`);
      }
      continue;
    }
    // 今月・来月の範囲外（＝再来月以降の予定）を「削除された」と誤判定しないよう、直接問い合わせる
    let remote = null;
    try {
      remote = await getEvent(config.calendarId, eventId);
    } catch (err) {
      if (isEventNotFound(err)) {
        deleteNoticesForEvent(guildId, eventId);
        console.log(`[Notify][${guildId}] 予定が存在しないため通知削除: ${eventId}`);
      }
      // 一時的な API エラーのときは設定を残す
      continue;
    }
    if (!remote || remote.status === "cancelled") {
      deleteNoticesForEvent(guildId, eventId);
      console.log(`[Notify][${guildId}] 予定が取り消されたため通知削除: ${eventId}`);
    }
  }
}

/** 予約削除キューを処理する（cron 実行ごとに呼ばれる） */
async function sweepPendingDeletes(client, guildId) {
  for (const entry of takeDuePendingDeletes(guildId)) {
    try {
      const channel = await client.channels.fetch(entry.channelId);
      const msg     = await channel.messages.fetch(entry.messageId);
      await msg.delete();
      console.log(`[Notify][${guildId}] 通知メッセージを自動削除: ${entry.messageId}`);
    } catch {
      // すでに削除済み・チャンネル消失などは無視する
    }
  }
}

module.exports = { checkAndFireNotices, sweepPendingDeletes };
