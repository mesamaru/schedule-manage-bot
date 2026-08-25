/**
 * embed.js v4
 */
const {
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder,
  RoleSelectMenuBuilder, UserSelectMenuBuilder,
} = require("discord.js");
const { appVersion } = require("./version");
const { formatEvent } = require("./calendar");
const { getNoticesForEvent } = require("./storage");
const { pick } = require("./i18n");

// 通知時間の简易表示ラベル
function minutesToShort(m, lang = "ja") {
  if (m < 60) return lang === "en" ? `${m}m` : `${m}分`;
  const h = m / 60;
  return Number.isInteger(h) ? `${h}h` : `${h.toFixed(1)}h`;
}

// イベントの通知設定をコンパクトな文字列に変換
function buildNoticeSummary(guildId, eventId, lang = "ja") {
  const notices = getNoticesForEvent(guildId, eventId);
  if (!notices || notices.length === 0) return "";
  const parts = notices.map(n => {
    const mention = n.roleId === "@everyone" || n.roleId === "@here"
      ? n.roleId
      : n.targetType === "user" ? `<@${n.roleId}>` : `<@&${n.roleId}>`;
    return `${mention}/${minutesToShort(n.minutesBefore, lang)}`;
  });
  return "🔔" + parts.join(" ");
}

function buildCalendarEmbed(guildId, events, year, month, lang = "ja") {
  const now        = new Date();
  const isThisMonth = now.getFullYear() === year && now.getMonth() + 1 === month;
  const todayDate  = now.getDate();
  const monthNames = lang === "en"
    ? ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
    : ["1月","2月","3月","4月","5月","6月","7月","8月","9月","10月","11月","12月"];
  const label      = isThisMonth
    ? pick(lang, "今月", "This month")
    : (now.getFullYear() === year && month === now.getMonth() + 2)
      ? pick(lang, "来月", "Next month")
      : (lang === "en" ? String(year) : `${year}年`);

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(lang === "en" ? `📅  ${monthNames[month-1]} ${year}  ${label}` : `📅  ${year}年 ${monthNames[month-1]}　${label}`)
    .setTimestamp();

  if (events.length === 0) {
    embed.setDescription(pick(lang, "この月の予定はありません。", "No events in this month."));
    return embed;
  }

  // 開始時刻順にソート
  const sorted = [...events].sort((a, b) => {
    const ta = new Date(a.start.dateTime || a.start.date).getTime();
    const tb = new Date(b.start.dateTime || b.start.date).getTime();
    return ta - tb;
  });

  const lines = [];
  let lastDay = null;
  let lastDayEventCount = 0;
  for (const event of sorted) {
    const f       = formatEvent(event, lang);
    const isToday = isThisMonth && f.d === todayDate;
    const dot     = (f.w === "日" || f.w === "Sun") ? "🔴" : (f.w === "土" || f.w === "Sat") ? "🔵" : "▫️";
    const todayMark = isToday ? (lang === "en" ? " 📍Today" : " 📍今日") : "";

    // 日付ヘッダーは日付が変わったときのみ出力
    if (f.d !== lastDay) {
      if (lastDay !== null) lines.push("");
      lines.push(`${dot} **${f.d}** ${f.w}${todayMark}`);
      lastDay = f.d;
      lastDayEventCount = 0;
    }

    // 同じ日の2件目以降は空行で区切る
    if (lastDayEventCount > 0) lines.push("");
    lastDayEventCount++;

    const noticeStr   = buildNoticeSummary(guildId, event.id, lang);
    const noticeCount = getNoticesForEvent(guildId, event.id).length;
    lines.push(`　\`${f.timeStr}\`　${f.title}${noticeStr && noticeCount <= 1 ? "　" + noticeStr : ""}`);
    if (f.desc) lines.push(`　${f.desc.replace(/^\n　/, "")}`);
    if (noticeStr && noticeCount > 1) lines.push(`　${noticeStr}`);
  }
  lines.push("");

  const desc = lines.join("\n");
  embed.setDescription(desc.length > 4000 ? desc.substring(0, 3990) + (lang === "en" ? "\n...(truncated)" : "\n…（省略）") : desc);
  return embed;
}

function buildCalendarButtons(year, month, lang = "ja", options = {}) {
  const { showEdit = false, disabled = false } = options;
  const prev = month === 1  ? { y: year-1, m: 12 } : { y: year, m: month-1 };
  const next = month === 12 ? { y: year+1, m: 1  } : { y: year, m: month+1 };
  const components = [
    new ButtonBuilder().setCustomId(`btn_prev_${prev.y}_${prev.m}`).setLabel(lang === "en" ? `◀ ${prev.m}` : `◀ ${prev.m}月`).setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`btn_next_${next.y}_${next.m}`).setLabel(lang === "en" ? `${next.m} ▶` : `${next.m}月 ▶`).setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("btn_refresh").setLabel(pick(lang, "🔄 更新", "🔄 Refresh")).setStyle(ButtonStyle.Primary),
  ];
  if (showEdit) {
    components.push(
      new ButtonBuilder().setCustomId(`btn_edit_select_${year}_${month}`).setLabel(pick(lang, "✏️ 編集", "✏️ Edit")).setStyle(ButtonStyle.Secondary),
    );
  }
  // 停止中はボタンを消さずに無効化する。消すと customId が失われ、
  // 再起動時に「自分が管理しているメッセージ」を見分けられなくなる（＝重複投稿の原因になる）
  if (disabled) components.forEach(b => b.setDisabled(true));
  return new ActionRowBuilder().addComponents(...components);
}

/**
 * @param {Array} events        今月の予定（件数・残り件数の集計に使う）
 * @param {Array} upcomingSource 「直近の予定」を探す母集団（既定は今月のみ／通常は今月＋来月）
 */
function buildStatusEmbed(guildId, events, lastUpdated, botRoleName, online = true, lang = "ja", upcomingSource = events) {
  const now        = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const isUpcoming = e => (e.start.dateTime ? new Date(e.start.dateTime) > now : new Date(e.start.date) >= todayStart);
  const bySoonest  = (a, b) => new Date(a.start.dateTime || a.start.date) - new Date(b.start.dateTime || b.start.date);
  const upcoming   = events.filter(isUpcoming).sort(bySoonest);
  // 月末に「直近」が「なし」にならないよう、翌月の予定も含めた母集団から先頭を取る
  const next       = [...upcomingSource].filter(isUpcoming).sort(bySoonest)[0];
  let nextStr = pick(lang, "なし", "None");
  if (next) {
    const f         = formatEvent(next, lang);
    const noticeStr = buildNoticeSummary(guildId, next.id, lang);
    const desc      = f.desc ? f.desc.replace(/^\n　/, "") : "";
    const baseInfo  = `${f.d}日(${f.w}) ${f.title}　\`${f.timeStr}\``;
    const indent    = "　　　　 "; // ⏭️ 直近　 の幅に合わせたインデント

    const nextLines = [baseInfo];
    if (desc)      nextLines.push(`${indent}${desc}`);
    if (noticeStr) nextLines.push(`${indent}${noticeStr}`);

    nextStr = nextLines.join("\n");
  }
  const jst = d => new Date(d).toLocaleString(lang === "en" ? "en-US" : "ja-JP", { timeZone:"Asia/Tokyo", month:"numeric", day:"numeric", hour:"2-digit", minute:"2-digit", second:"2-digit" });

  return new EmbedBuilder()
    .setColor(online ? 0x2b2d31 : 0x747f8d)
    .setDescription(
      `${online ? pick(lang, "🟢 **Bot稼働中**", "🟢 **Bot Online**") : pick(lang, "🔴 **Bot停止中**", "🔴 **Bot Offline**")}\n` +
      `${pick(lang, "📆 今月", "📆 This month")}  **${events.length}${pick(lang, "件", "") }**  ${pick(lang, "残り", "Remaining")} **${upcoming.length}${pick(lang, "件", "") }**\n` +
      `${pick(lang, "⏭️ 直近", "⏭️ Next")}  ${nextStr}\n` +
      `${pick(lang, "🔃 最終同期", "🔃 Last sync")}  ${lastUpdated ? jst(lastUpdated) : pick(lang, "未取得", "Not synced")}\n` +
      `${pick(lang, "🔐 操作権限", "🔐 Permission")}  \`${botRoleName || "CalendarOperator"}\` ${pick(lang, "ロール保持者・管理者", "role holders and administrators")}\n` +
      `${pick(lang, "🧩 バージョン", "🧩 Version")}  \`v${appVersion}\``
    );
}

function buildActionButtons(lang = "ja", options = {}) {
  const { disabled = false } = options;
  const components = [
    new ButtonBuilder().setCustomId("btn_add").setLabel(pick(lang, "➕ 予定を追加", "➕ Add Event")).setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("btn_edit_select").setLabel(pick(lang, "✏️ 編集", "✏️ Edit")).setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("btn_delete_select").setLabel(pick(lang, "🗑️ 削除", "🗑️ Delete")).setStyle(ButtonStyle.Danger),
  ];
  // 停止中もボタン自体は残す（理由は buildCalendarButtons を参照）
  if (disabled) components.forEach(b => b.setDisabled(true));
  return new ActionRowBuilder().addComponents(...components);
}

function buildSelectMenu(events, customId, placeholder, lang = "ja") {
  if (events.length === 0) return null;
  const options = events.slice(0, 25).map(e => {
    const f = formatEvent(e, lang);
    return {
      label: (lang === "en" ? `${f.w} ${f.d} ${f.title}` : `${f.d}日(${f.w}) ${f.title}`).substring(0, 100),
      description: (f.timeStr + (f.desc ? "　" + f.desc.replace(/\n　/,"") : "")).substring(0, 100),
      value: e.id,
    };
  });
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId(customId).setPlaceholder(placeholder).addOptions(options)
  );
}

/**
 * 通知設定 - ロール選択ステップ
 * @returns {ActionRowBuilder[]} [roleSelectRow, specialRolesAndSkipRow]
 */
function buildRoleSelectForNotify(eventId, lang = "ja") {
  const roleRow = new ActionRowBuilder().addComponents(
    new RoleSelectMenuBuilder()
      .setCustomId(`select_notify_role_${eventId}`)
      .setPlaceholder(pick(lang, "🔔 通知するロールを選択", "🔔 Select a role to notify"))
      .setMinValues(1)
      .setMaxValues(1)
  );
  const userRow = new ActionRowBuilder().addComponents(
    new UserSelectMenuBuilder()
      .setCustomId(`select_notify_user_${eventId}`)
      .setPlaceholder(pick(lang, "👤 個人に通知するユーザーを選択", "👤 Select a user to notify"))
      .setMinValues(1)
      .setMaxValues(1)
  );
  const specialRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`btn_notify_everyone_${eventId}`).setLabel("@everyone").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`btn_notify_here_${eventId}`).setLabel("@here").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`btn_notify_skip_${eventId}`).setLabel(pick(lang, "スキップ（通知なし）", "Skip (No notification)")).setStyle(ButtonStyle.Danger),
  );
  return [roleRow, userRow, specialRow];
}

/**
 * 通知設定 - 時間選択ステップ
 * @returns {ActionRowBuilder[]} [時間ボタン行1, 時間ボタン行2]
 */
function buildNotifyTimeButtons(eventId, targetId, targetType = "role", lang = "ja") {
  // ユーザーは btn_notify_u_ プレフィックス、ロールは btn_notify_t_
  const p = targetType === "user" ? "btn_notify_u" : "btn_notify_t";
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`${p}_${eventId}_${targetId}_10`).setLabel(lang === "en" ? "10m" : "10分前").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`${p}_${eventId}_${targetId}_30`).setLabel(lang === "en" ? "30m" : "30分前").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`${p}_${eventId}_${targetId}_60`).setLabel(lang === "en" ? "1h" : "1時間前").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`${p}_${eventId}_${targetId}_180`).setLabel(lang === "en" ? "3h" : "3時間前").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`${p}_${eventId}_${targetId}_360`).setLabel(lang === "en" ? "6h" : "6時間前").setStyle(ButtonStyle.Secondary),
  );
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`${p}_${eventId}_${targetId}_720`).setLabel(lang === "en" ? "12h" : "12時間前").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`${p}_${eventId}_${targetId}_1440`).setLabel(lang === "en" ? "24h" : "24時間前").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`${p}_${eventId}_${targetId}_2880`).setLabel(lang === "en" ? "48h" : "48時間前").setStyle(ButtonStyle.Secondary),
  );
  return [row1, row2];
}

function buildNoticeManageComponents(guildId, eventId, lang = "ja") {
  const notices = getNoticesForEvent(guildId, eventId);
  const lines = [pick(lang, "📋 **現在の通知設定**", "📋 **Current notification settings**")];
  if (notices.length === 0) {
    lines.push(pick(lang, "　設定なし", "  None"));
  } else {
    notices.forEach((n, i) => {
      const mention = n.roleId === "@everyone" || n.roleId === "@here"
        ? n.roleId : n.targetType === "user" ? `<@${n.roleId}>` : `<@&${n.roleId}>`;
      const timeLabel = n.minutesBefore >= 60
        ? (lang === "en" ? `${n.minutesBefore / 60}h before` : `${n.minutesBefore / 60}時間前`)
        : (lang === "en" ? `${n.minutesBefore}m before` : `${n.minutesBefore}分前`);
      lines.push(`　${i + 1}. ${mention}  /  ${timeLabel}`);
    });
  }
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`btn_nmgr_add_${eventId}`).setLabel(pick(lang, "➕ 追加", "➕ Add")).setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`btn_nmgr_del_${eventId}`).setLabel(pick(lang, "🗑️ 削除", "🗑️ Delete")).setStyle(ButtonStyle.Danger).setDisabled(notices.length === 0),
    new ButtonBuilder().setCustomId(`btn_nmgr_done_${eventId}`).setLabel(pick(lang, "✅ 完了", "✅ Done")).setStyle(ButtonStyle.Primary),
  );
  return { content: lines.join("\n"), components: [row] };
}

module.exports = {
  buildCalendarEmbed, buildCalendarButtons,
  buildStatusEmbed, buildActionButtons, buildSelectMenu,
  buildRoleSelectForNotify, buildNotifyTimeButtons,
  buildNoticeManageComponents,
};
