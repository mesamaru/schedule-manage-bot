const { MessageFlags, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder } = require("discord.js");
const { buildSelectMenu, buildRoleSelectForNotify, buildNotifyTimeButtons, buildNoticeManageComponents, buildCalendarEmbed, buildCalendarButtons } = require("./embed");
const { getMonthEvents, getEvent, deleteEvent, formatEvent } = require("./calendar");
const { getNoticesForEvent, addNotice, deleteNoticesForEvent, deleteNoticeEntry } = require("./storage");
const { timingLabel } = require("./notifier");
const { getLang, pick } = require("./i18n");
const { toKey, fromKey } = require("./idRegistry");

// 編集用に保持する「予定一覧」と「選択メニューのインタラクション」の有効期限。
// インタラクショントークン自体が 15 分で失効するので、それ以上は持たない
const PENDING_EDIT_TTL_MS = 15 * 60 * 1000;

function createButtonHandler({ client, loadConfig, scheduler, runtime, sharedState }) {
  const { hasPermission, currentYM, fmtCd, startCountdownDelete, sendAuditLog } = runtime;

  function getPendingEditKey(interaction) {
    return `${interaction.guildId}:${interaction.user.id}`;
  }

  function prunePendingEdits() {
    const now = Date.now();
    for (const [key, entry] of sharedState.pendingEdits) {
      if (now - entry.createdAt > PENDING_EDIT_TTL_MS) sharedState.pendingEdits.delete(key);
    }
  }

  /** 一時メッセージ（エフェメラル）で応答し、数秒後に消す。defer 済みかどうかを問わない */
  async function respondTemp(interaction, content, seconds = 5, lang = "ja", { update = false } = {}) {
    const body = { content: fmtCd(content, seconds, lang), components: [], embeds: [] };
    if (interaction.deferred || interaction.replied) await interaction.editReply(body);
    else if (update) await interaction.update(body);
    else await interaction.reply({ ...body, flags: MessageFlags.Ephemeral });
    startCountdownDelete(interaction, content, seconds, lang);
  }

  /**
   * 予定の変更後にカレンダー・ステータスを更新する。
   * 予定の変更そのものは成功しているので、ここでの失敗を「追加失敗」等として表示してはいけない
   * （以前は表示の更新に失敗しただけで「❌ 削除失敗」と上書きしていた）。
   */
  function syncAfterChange(guildId, config) {
    scheduler.sync(guildId, config, { force: true, notify: false }).catch((err) => {
      console.error(`[Sync][${guildId}] 変更後の表示更新に失敗: ${err?.message || err}`);
    });
  }

  function permissionDenied(interaction, config, lang) {
    return interaction.reply({
      content: pick(lang,
        `🔐 この操作には \`${config.operatorRoleName}\` ロールまたは管理者権限が必要です。`,
        `🔐 This action requires the \`${config.operatorRoleName}\` role or administrator permission.`),
      flags: MessageFlags.Ephemeral,
    });
  }

  /** "btn_edit_select_2026_5" のような customId から年月を取り出す（なければ今月） */
  function parseYearMonth(id, prefix) {
    if (!id.startsWith(prefix)) return currentYM();
    const [y, m] = id.slice(prefix.length).split("_").map(Number);
    if (!Number.isInteger(y) || !Number.isInteger(m) || m < 1 || m > 12) return currentYM();
    return { year: y, month: m };
  }

  /** `${prefix}${eventId}_${targetId}_${minutes}` を分解（eventId には "_" が含まれうるので右から切る） */
  function parseNotifyId(id, prefix) {
    const wp  = id.slice(prefix.length);
    const li  = wp.lastIndexOf("_");
    const min = parseInt(wp.slice(li + 1), 10);
    const r   = wp.slice(0, li);
    const si  = r.lastIndexOf("_");
    return { eventId: r.slice(0, si), targetId: r.slice(si + 1), minutes: min };
  }

  function outdated(interaction, lang, { update = false } = {}) {
    return respondTemp(interaction, pick(lang, "⚠️ この操作は期限切れです（Bot が再起動した可能性があります）。もう一度やり直してください。", "⚠️ This action has expired (the bot may have restarted). Please start over."), 8, lang, { update });
  }

  async function showNoticeManager(interaction, eventId, lang) {
    const { content, components } = buildNoticeManageComponents(interaction.guildId, eventId, lang);
    return interaction.update({ content, components });
  }

  async function handleButton(interaction) {
    const config = loadConfig(interaction.guildId);
    const lang = getLang(config);
    const id = interaction.customId;

    // ─── 誰でも使える操作 ──────────────────────────────
    if (id === "btn_refresh") {
      // 応答期限（3 秒）に間に合うよう、何よりも先に defer する
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      try {
        await scheduler.sync(interaction.guildId, config, { force: true });
        return respondTemp(interaction, pick(lang, "✅ カレンダーとステータスを更新しました！", "✅ Calendar and status updated."), 5, lang);
      } catch (err) {
        return respondTemp(interaction, pick(lang, `❌ 更新失敗: ${err.message}`, `❌ Update failed: ${err.message}`), 8, lang);
      }
    }

    if (id.startsWith("btn_prev_") || id.startsWith("btn_next_")) {
      const { year, month } = parseYearMonth(id, id.startsWith("btn_prev_") ? "btn_prev_" : "btn_next_");
      // 以前は Google から予定を取得してから defer していたため、取得が 3 秒を超えると
      // 「Unknown interaction」になっていた。先に応答枠を確保する
      const isEphemeralView = interaction.message?.flags?.has(MessageFlags.Ephemeral);
      if (isEphemeralView) await interaction.deferUpdate();
      else await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      try {
        const events  = await getMonthEvents(config.calendarId, year, month);
        const embed   = buildCalendarEmbed(interaction.guildId, events, year, month, lang);
        const buttons = buildCalendarButtons(year, month, lang, { showEdit: true });
        return interaction.editReply({ content: "", embeds: [embed], components: [buttons] });
      } catch (err) {
        return interaction.editReply({ content: pick(lang, `❌ 取得失敗: ${err.message}`, `❌ Fetch failed: ${err.message}`), embeds: [], components: [] });
      }
    }

    // ─── ここから先は操作ロール（または管理者）が必要 ─────────
    // 通知設定まわりも以前は権限チェックの前にあったため、customId さえ送れば誰でも変更できた
    if (!hasPermission(interaction, config.operatorRoleName)) {
      return permissionDenied(interaction, config, lang);
    }

    if (id === "btn_add") {
      return interaction.showModal(require("./modals").buildAddModal(new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" }), lang));
    }

    if (id === "btn_edit_select" || id.startsWith("btn_edit_select_")) {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      try {
        const { year, month } = parseYearMonth(id, "btn_edit_select_");
        const events = await getMonthEvents(config.calendarId, year, month);
        const menu   = buildSelectMenu(events, "select_edit_event", pick(lang, "編集する予定を選択", "Select event to edit"), lang);
        if (!menu) return respondTemp(interaction, pick(lang, "編集できる予定がありません。", "No events available to edit."), 5, lang);
        await interaction.editReply({ content: pick(lang, "✏️ 編集する予定を選んでください：", "✏️ Select an event to edit:"), components: [menu] });
        prunePendingEdits();
        sharedState.pendingEdits.set(getPendingEditKey(interaction), {
          interaction,
          events: new Map(events.map((event) => [event.id, event])),
          createdAt: Date.now(),
        });
        return;
      } catch (err) {
        return respondTemp(interaction, pick(lang, `❌ 取得失敗: ${err.message}`, `❌ Fetch failed: ${err.message}`), 8, lang);
      }
    }

    if (id === "btn_delete_select" || id.startsWith("btn_delete_select_")) {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      try {
        const { year, month } = parseYearMonth(id, "btn_delete_select_");
        const events = await getMonthEvents(config.calendarId, year, month);
        const menu   = buildSelectMenu(events, "select_delete_event", pick(lang, "削除する予定を選択", "Select event to delete"), lang);
        if (!menu) return respondTemp(interaction, pick(lang, "削除できる予定がありません。", "No events available to delete."), 5, lang);
        return interaction.editReply({ content: pick(lang, "🗑️ 削除する予定を選んでください：", "🗑️ Select an event to delete:"), components: [menu] });
      } catch (err) {
        return respondTemp(interaction, pick(lang, `❌ 取得失敗: ${err.message}`, `❌ Fetch failed: ${err.message}`), 8, lang);
      }
    }

    if (id.startsWith("btn_confirm_delete_")) {
      await interaction.deferUpdate();
      const eventId = fromKey(id.slice("btn_confirm_delete_".length));
      if (!eventId) return outdated(interaction, lang);
      let auditInfo = null;
      try {
        try {
          const ev = await getEvent(config.calendarId, eventId);
          const f  = formatEvent(ev, lang);
          auditInfo = { title: f.title, dateStr: (ev.start.dateTime || ev.start.date).substring(0, 10), timeStr: f.timeStr, desc: ev.description || "" };
        } catch {}
        await deleteEvent(config.calendarId, eventId);
      } catch (err) {
        return respondTemp(interaction, pick(lang, `❌ 削除失敗: ${err.message}`, `❌ Delete failed: ${err.message}`), 8, lang);
      }
      deleteNoticesForEvent(interaction.guildId, eventId);
      if (auditInfo) sendAuditLog(client, "削除", interaction, auditInfo, config);
      await respondTemp(interaction, pick(lang, "✅ 削除しました。", "✅ Deleted."), 5, lang).catch(() => {});
      syncAfterChange(interaction.guildId, config);
      return;
    }

    if (id === "btn_cancel_delete") {
      return respondTemp(interaction, pick(lang, "キャンセルしました。", "Cancelled."), 5, lang, { update: true });
    }

    // ─── 通知設定 ───────────────────────────────────────
    if (id.startsWith("btn_notify_everyone_") || id.startsWith("btn_notify_here_")) {
      const isEveryone = id.startsWith("btn_notify_everyone_");
      const target     = isEveryone ? "@everyone" : "@here";
      const eventId    = fromKey(id.slice(isEveryone ? "btn_notify_everyone_".length : "btn_notify_here_".length));
      if (!eventId) return outdated(interaction, lang, { update: true });
      return interaction.update({
        content: pick(lang, `⏰ ${target} への通知タイミングを選択してください：`, `⏰ Select notification timing for ${target}:`),
        components: buildNotifyTimeButtons(eventId, target, "role", lang),
      });
    }

    if (id.startsWith("btn_notify_u_") || id.startsWith("btn_notify_t_")) {
      const isUser = id.startsWith("btn_notify_u_");
      const parsed = parseNotifyId(id, isUser ? "btn_notify_u_" : "btn_notify_t_");
      const eventId = fromKey(parsed.eventId);
      const { targetId, minutes } = parsed;
      if (!eventId) return outdated(interaction, lang, { update: true });
      if (!targetId || !Number.isInteger(minutes) || minutes <= 0) return showNoticeManager(interaction, eventId, lang);
      const entry = isUser ? { roleId: targetId, minutesBefore: minutes, targetType: "user" } : { roleId: targetId, minutesBefore: minutes };
      addNotice(interaction.guildId, eventId, entry);
      await showNoticeManager(interaction, eventId, lang);
      syncAfterChange(interaction.guildId, config); // カレンダーの 🔔 表示を更新
      return;
    }

    if (id.startsWith("btn_notify_skip_") || id.startsWith("btn_notify_more_")) {
      const eventId = fromKey(id.slice("btn_notify_skip_".length));
      if (!eventId) return outdated(interaction, lang, { update: true });
      return showNoticeManager(interaction, eventId, lang);
    }

    if (id.startsWith("btn_notify_done_") || id.startsWith("btn_nmgr_done_")) {
      return respondTemp(interaction, pick(lang, "✅ 通知設定を完了しました！", "✅ Notification setup completed."), 5, lang, { update: true });
    }

    if (id.startsWith("btn_nmgr_add_")) {
      const eventId = fromKey(id.slice("btn_nmgr_add_".length));
      if (!eventId) return outdated(interaction, lang, { update: true });
      return interaction.update({
        content: pick(lang, "📣 通知するロールまたはユーザーを選択してください：", "📣 Select role or user to notify:"),
        components: buildRoleSelectForNotify(eventId, lang),
      });
    }

    if (id.startsWith("btn_nmgr_del_")) {
      await interaction.deferUpdate();
      const eventId = fromKey(id.slice("btn_nmgr_del_".length));
      if (!eventId) return outdated(interaction, lang);
      const notices = getNoticesForEvent(interaction.guildId, eventId).slice(0, 25);
      if (notices.length === 0) {
        const { content, components } = buildNoticeManageComponents(interaction.guildId, eventId, lang);
        return interaction.editReply({ content, components });
      }
      const options = [];
      for (let i = 0; i < notices.length; i++) {
        const n = notices[i];
        let targetName;
        if (n.roleId === "@everyone" || n.roleId === "@here") {
          targetName = n.roleId;
        } else if (n.targetType === "user") {
          const member = await interaction.guild?.members.fetch(n.roleId).catch(() => null);
          targetName = "@" + (member?.displayName || member?.user?.username || n.roleId);
        } else {
          const role = interaction.guild?.roles.cache.get(n.roleId);
          targetName = "@" + (role?.name || n.roleId);
        }
        options.push({ label: `${i + 1}. ${targetName} / ${timingLabel(n.minutesBefore, lang)}`.substring(0, 100), value: String(i) });
      }
      return interaction.editReply({
        content: pick(lang, "🗑️ 削除する通知を選択してください：", "🗑️ Select a notification to delete:"),
        components: [new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder().setCustomId(`select_nmgr_del_${toKey(eventId)}`).setPlaceholder(pick(lang, "削除する通知を選択", "Select notification to delete")).addOptions(options))],
      });
    }

    console.warn(`[Interaction][${interaction.guildId}] 未対応のボタン: ${id}`);
    return respondTemp(interaction, pick(lang, "⚠️ このボタンは古くなっています。もう一度操作をやり直してください。", "⚠️ This button is outdated. Please start over."), 5, lang);
  }

  async function handleSelect(interaction) {
    const config = loadConfig(interaction.guildId);
    const lang = getLang(config);
    const id = interaction.customId;

    if (!hasPermission(interaction, config.operatorRoleName)) {
      return permissionDenied(interaction, config, lang);
    }

    if (id.startsWith("select_nmgr_del_")) {
      const eventId = fromKey(id.slice("select_nmgr_del_".length));
      if (!eventId) return outdated(interaction, lang, { update: true });
      deleteNoticeEntry(interaction.guildId, eventId, parseInt(interaction.values[0], 10));
      await showNoticeManager(interaction, eventId, lang);
      syncAfterChange(interaction.guildId, config);
      return;
    }

    if (id === "select_edit_event") {
      const eventId = fromKey(interaction.values[0]);
      const pending = sharedState.pendingEdits.get(getPendingEditKey(interaction));
      const event   = pending?.events.get(eventId);
      if (!event) {
        return interaction.reply({
          content: pick(lang, "❌ 編集対象の情報が見つかりません。もう一度編集を開いてください。", "❌ Event details are no longer available. Please open edit again."),
          flags: MessageFlags.Ephemeral,
        });
      }
      // showModal は defer できないので、ここでは API 呼び出しをせずキャッシュ済みの予定を使う
      return interaction.showModal(require("./modals").buildEditModal(event, lang));
    }

    if (id === "select_delete_event") {
      await interaction.deferUpdate();
      const eventId = fromKey(interaction.values[0]);
      if (!eventId) return outdated(interaction, lang);
      try {
        const event = await getEvent(config.calendarId, eventId);
        const f     = formatEvent(event, lang);
        return interaction.editReply({
          content: lang === "en"
            ? `⚠️ Are you sure you want to delete this?\n\n**${f.title}**  ${f.w} ${f.d}  \`${f.timeStr}\``
            : `⚠️ 本当に削除しますか？\n\n**${f.title}**　${f.d}日(${f.w})　\`${f.timeStr}\``,
          components: [new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`btn_confirm_delete_${toKey(eventId)}`).setLabel(pick(lang, "🗑️ 削除する", "🗑️ Delete")).setStyle(ButtonStyle.Danger),
            new ButtonBuilder().setCustomId("btn_cancel_delete").setLabel(pick(lang, "キャンセル", "Cancel")).setStyle(ButtonStyle.Secondary),
          )],
        });
      } catch (err) {
        return interaction.editReply({ content: pick(lang, `❌ 取得失敗: ${err.message}`, `❌ Fetch failed: ${err.message}`), components: [] });
      }
    }

    if (id.startsWith("select_notify_role_")) {
      const eventId = fromKey(id.slice("select_notify_role_".length));
      if (!eventId) return outdated(interaction, lang, { update: true });
      const roleId  = interaction.values[0];
      // ロール選択で @everyone を選ぶと guildId が返る。<@&guildId> ではメンションにならない
      if (roleId === interaction.guildId) {
        return interaction.update({
          content: pick(lang, "⏰ @everyone への通知タイミングを選択してください：", "⏰ Select notification timing for @everyone:"),
          components: buildNotifyTimeButtons(eventId, "@everyone", "role", lang),
        });
      }
      return interaction.update({
        content: pick(lang, `⏰ <@&${roleId}> への通知タイミングを選択してください：`, `⏰ Select notification timing for <@&${roleId}>:`),
        components: buildNotifyTimeButtons(eventId, roleId, "role", lang),
      });
    }

    if (id.startsWith("select_notify_user_")) {
      const eventId = fromKey(id.slice("select_notify_user_".length));
      if (!eventId) return outdated(interaction, lang, { update: true });
      const userId  = interaction.values[0];
      return interaction.update({
        content: pick(lang, `⏰ <@${userId}> への通知タイミングを選択してください：`, `⏰ Select notification timing for <@${userId}>:`),
        components: buildNotifyTimeButtons(eventId, userId, "user", lang),
      });
    }

    console.warn(`[Interaction][${interaction.guildId}] 未対応のメニュー: ${id}`);
  }

  return { handleButton, handleSelect };
}

module.exports = { createButtonHandler };
