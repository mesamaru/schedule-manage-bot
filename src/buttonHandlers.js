const { MessageFlags } = require("discord.js");
const { buildSelectMenu, buildRoleSelectForNotify, buildNotifyTimeButtons, buildNoticeManageComponents, buildActionButtons, buildCalendarEmbed, buildCalendarButtons } = require("./embed");
const { getMonthEvents, getEvent, deleteEvent, hashEvents } = require("./calendar");
const { getNoticesForEvent, setNoticesForEvent, deleteNoticesForEvent, deleteNoticeEntry, resetFiredForEvent } = require("./storage");
const { getLang, pick } = require("./i18n");

function createButtonHandler({ client, loadConfig, saveState, scheduler, runtime, sharedState }) {
  const { hasPermission, currentYM, fmtCd, startCountdownDelete, sendAuditLog, formatEventLocal } = runtime;

  function getPendingEditKey(interaction) {
    return `${interaction.guildId}:${interaction.user.id}`;
  }

  async function handleButton(interaction) {
    const config = loadConfig(interaction.guildId);
    const lang = getLang(config);
    const id = interaction.customId;

    if (id === "btn_refresh") {
      await interaction.deferReply({ ephemeral: true });
      try {
        const { year, month } = currentYM();
        const events = await getMonthEvents(config.calendarId, year, month);
        await scheduler.updateBoth(interaction.guildId, config, events, year, month);
        saveState(interaction.guildId, { lastHash: hashEvents(events), updatedAt: new Date().toISOString() });
        const msg = pick(lang, "✅ カレンダーとステータスを更新しました！", "✅ Calendar and status updated.");
        await interaction.editReply({ content: fmtCd(msg, 5, lang) });
        startCountdownDelete(interaction, msg, 5, lang);
        return;
      } catch (err) {
        const msg = pick(lang, `❌ 更新失敗: ${err.message}`, `❌ Update failed: ${err.message}`);
        await interaction.editReply({ content: fmtCd(msg, 8, lang) });
        startCountdownDelete(interaction, msg, 8, lang);
        return;
      }
    }

    if (id.startsWith("btn_prev_") || id.startsWith("btn_next_")) {
      const parts = id.split("_");
      const year  = parseInt(parts[2]);
      const month = parseInt(parts[3]);
      try {
        const events  = await getMonthEvents(config.calendarId, year, month);
        const embed   = buildCalendarEmbed(interaction.guildId, events, year, month, lang);
        const buttons = buildCalendarButtons(year, month, lang);
        if (interaction.message.flags.has(MessageFlags.Ephemeral)) {
          return interaction.update({ embeds: [embed], components: [buttons] });
        } else {
          await interaction.deferReply({ ephemeral: true });
          return interaction.editReply({ embeds: [embed], components: [buttons] });
        }
      } catch (err) {
        if (interaction.deferred || interaction.replied) return interaction.editReply({ content: pick(lang, `❌ 取得失敗: ${err.message}`, `❌ Fetch failed: ${err.message}`) });
        return interaction.reply({ content: pick(lang, `❌ 取得失敗: ${err.message}`, `❌ Fetch failed: ${err.message}`), ephemeral: true });
      }
    }

    if (id.startsWith("btn_notify_everyone_") || id.startsWith("btn_notify_here_")) {
      const isEveryone = id.startsWith("btn_notify_everyone_");
      const roleId     = isEveryone ? "@everyone" : "@here";
      const eventId    = id.slice(isEveryone ? "btn_notify_everyone_".length : "btn_notify_here_".length);
      return interaction.update({ content: pick(lang, `⏰ ${roleId} への通知タイミングを選択してください：`, `⏰ Select notification timing for ${roleId}:`), components: buildNotifyTimeButtons(eventId, roleId, "role", lang) });
    }

    if (id.startsWith("btn_notify_u_")) {
      const wp  = id.slice("btn_notify_u_".length);
      const li  = wp.lastIndexOf("_");
      const min = parseInt(wp.slice(li + 1));
      const r   = wp.slice(0, li);
      const si  = r.lastIndexOf("_");
      const uid = r.slice(si + 1);
      const eid = r.slice(0, si);
      const ex  = getNoticesForEvent(interaction.guildId, eid);
      ex.push({ roleId: uid, minutesBefore: min, targetType: "user" });
      setNoticesForEvent(interaction.guildId, eid, ex);
      const { content: nc, components: nco } = buildNoticeManageComponents(interaction.guildId, eid, lang);
      return interaction.update({ content: nc, components: nco });
    }

    if (id.startsWith("btn_notify_t_")) {
      const wp  = id.slice("btn_notify_t_".length);
      const li  = wp.lastIndexOf("_");
      const min = parseInt(wp.slice(li + 1));
      const r   = wp.slice(0, li);
      const si  = r.lastIndexOf("_");
      const rid = r.slice(si + 1);
      const eid = r.slice(0, si);
      const ex  = getNoticesForEvent(interaction.guildId, eid);
      ex.push({ roleId: rid, minutesBefore: min });
      setNoticesForEvent(interaction.guildId, eid, ex);
      const { content: nc, components: nco } = buildNoticeManageComponents(interaction.guildId, eid, lang);
      return interaction.update({ content: nc, components: nco });
    }

    if (id.startsWith("btn_notify_skip_")) {
      const eid = id.slice("btn_notify_skip_".length);
      const { content: nc, components: nco } = buildNoticeManageComponents(interaction.guildId, eid, lang);
      return interaction.update({ content: nc, components: nco });
    }

    if (id.startsWith("btn_notify_done_")) {
      const msg = pick(lang, "✅ 通知設定を完了しました！", "✅ Notification setup completed.");
      await interaction.update({ content: fmtCd(msg, 5, lang), components: [] });
      startCountdownDelete(interaction, msg, 5, lang);
      return;
    }

    if (id.startsWith("btn_notify_more_")) {
      const eid = id.slice("btn_notify_more_".length);
      const { content: nc, components: nco } = buildNoticeManageComponents(interaction.guildId, eid, lang);
      return interaction.update({ content: nc, components: nco });
    }

    if (id.startsWith("btn_nmgr_add_")) {
      const eid = id.slice("btn_nmgr_add_".length);
      const [roleRow, userRow, skipRow] = buildRoleSelectForNotify(eid, lang);
      return interaction.update({ content: pick(lang, "📣 通知するロールまたはユーザーを選択してください：", "📣 Select role or user to notify:"), components: [roleRow, userRow, skipRow] });
    }

    if (id.startsWith("btn_nmgr_del_")) {
      await interaction.deferUpdate();
      const eid = id.slice("btn_nmgr_del_".length);
      const notices = getNoticesForEvent(interaction.guildId, eid);
      const options = [];
      for (let i = 0; i < notices.length; i++) {
        const n = notices[i];
        let targetName;
        if (n.roleId === "@everyone" || n.roleId === "@here") {
          targetName = n.roleId;
        } else if (n.targetType === "user") {
          try {
            const member = await interaction.guild?.members.fetch(n.roleId);
            targetName = "@" + (member?.displayName || member?.user.username || n.roleId);
          } catch { targetName = "@" + n.roleId; }
        } else {
          const role = interaction.guild?.roles.cache.get(n.roleId);
          targetName = "@" + (role?.name || n.roleId);
        }
        const tl = n.minutesBefore >= 60
          ? (lang === "en" ? `${n.minutesBefore / 60}h before` : `${n.minutesBefore / 60}時間前`)
          : (lang === "en" ? `${n.minutesBefore}m before` : `${n.minutesBefore}分前`);
        options.push({ label: `${i + 1}. ${targetName} / ${tl}`.substring(0, 100), value: String(i) });
      }
      const { ActionRowBuilder: ARB, StringSelectMenuBuilder: SSB } = require("discord.js");
      return interaction.editReply({
        content: pick(lang, "🗑️ 削除する通知を選択してください：", "🗑️ Select a notification to delete:"),
        components: [new ARB().addComponents(new SSB().setCustomId(`select_nmgr_del_${eid}`).setPlaceholder(pick(lang, "削除する通知を選択", "Select notification to delete")).addOptions(options))],
      });
    }

    if (id.startsWith("btn_nmgr_done_")) {
      const msg = pick(lang, "✅ 通知設定を完了しました！", "✅ Notification setup completed.");
      await interaction.update({ content: fmtCd(msg, 5, lang), components: [] });
      startCountdownDelete(interaction, msg, 5, lang);
      return;
    }

    if (!hasPermission(interaction.member, config.operatorRoleName)) {
      return interaction.reply({ content: pick(lang, `🔐 この操作には \`${config.operatorRoleName}\` ロールまたは管理者権限が必要です。`, `🔐 This action requires the \`${config.operatorRoleName}\` role or administrator permission.`), ephemeral: true });
    }

    if (id === "btn_add") {
      return interaction.showModal(require("./modals").buildAddModal(new Date().toISOString().substring(0, 10), lang));
    }

    if (id === "btn_edit_select") {
      try {
        const { year, month } = currentYM();
        const events = await getMonthEvents(config.calendarId, year, month);
        const menu   = buildSelectMenu(events, "select_edit_event", pick(lang, "編集する予定を選択", "Select event to edit"), lang);
        if (!menu) return interaction.reply({ content: pick(lang, "編集できる予定がありません。", "No events available to edit."), ephemeral: true });
        await interaction.reply({ content: pick(lang, "✏️ 編集する予定を選んでください：", "✏️ Select an event to edit:"), components: [menu], ephemeral: true });
        const pendingKey = getPendingEditKey(interaction);
        sharedState.pendingEditInteractions.set(pendingKey, interaction);
        sharedState.pendingEditEvents.set(pendingKey, new Map(events.map((event) => [event.id, event])));
        return;
      } catch (err) {
        return interaction.reply({ content: pick(lang, `❌ 取得失敗: ${err.message}`, `❌ Fetch failed: ${err.message}`), ephemeral: true });
      }
    }

    if (id === "btn_delete_select") {
      try {
        const { year, month } = currentYM();
        const events = await getMonthEvents(config.calendarId, year, month);
        const menu   = buildSelectMenu(events, "select_delete_event", pick(lang, "削除する予定を選択", "Select event to delete"), lang);
        if (!menu) return interaction.reply({ content: pick(lang, "削除できる予定がありません。", "No events available to delete."), ephemeral: true });
        return interaction.reply({ content: pick(lang, "🗑️ 削除する予定を選んでください：", "🗑️ Select an event to delete:"), components: [menu], ephemeral: true });
      } catch (err) {
        return interaction.reply({ content: pick(lang, `❌ 取得失敗: ${err.message}`, `❌ Fetch failed: ${err.message}`), ephemeral: true });
      }
    }

    if (id.startsWith("btn_confirm_delete_")) {
      await interaction.deferUpdate();
      const eventId = id.replace("btn_confirm_delete_", "");
      try {
        let _ai = null;
        try {
          const _ev = await getEvent(config.calendarId, eventId);
          const _f  = formatEventLocal(_ev, lang);
          _ai = { title: _f.title, dateStr: (_ev.start.dateTime || _ev.start.date).substring(0, 10), timeStr: _f.timeStr, desc: _ev.description || "" };
        } catch {}
        await deleteEvent(config.calendarId, eventId);
        deleteNoticesForEvent(interaction.guildId, eventId);
        if (_ai) sendAuditLog(client, "削除", interaction, _ai, config);
        const msg = pick(lang, "✅ 削除しました。", "✅ Deleted.");
        await interaction.editReply({ content: fmtCd(msg, 5, lang), components: [] });
        startCountdownDelete(interaction, msg, 5, lang);
        const { year, month } = currentYM();
        const events = await getMonthEvents(config.calendarId, year, month);
        await scheduler.updateBoth(interaction.guildId, config, events, year, month);
        saveState(interaction.guildId, { lastHash: hashEvents(events), updatedAt: new Date().toISOString() });
      } catch (err) {
        const emsg = pick(lang, `❌ 削除失敗: ${err.message}`, `❌ Delete failed: ${err.message}`);
        await interaction.editReply({ content: fmtCd(emsg, 8, lang), components: [] });
        startCountdownDelete(interaction, emsg, 8, lang);
      }
    }

    if (id === "btn_cancel_delete") {
      const msg = pick(lang, "キャンセルしました。", "Cancelled.");
      await interaction.update({ content: fmtCd(msg, 5, lang), components: [] });
      startCountdownDelete(interaction, msg, 5, lang);
      return;
    }
  }

  async function handleSelect(interaction) {
    const lang = getLang(loadConfig(interaction.guildId));
    const config = loadConfig(interaction.guildId);
    if (interaction.customId.startsWith("select_nmgr_del_")) {
      const eid = interaction.customId.slice("select_nmgr_del_".length);
      deleteNoticeEntry(interaction.guildId, eid, parseInt(interaction.values[0]));
      const { content: nc, components: nco } = buildNoticeManageComponents(interaction.guildId, eid, lang);
      return interaction.update({ content: nc, components: nco });
    }
    if (!hasPermission(interaction.member, config.operatorRoleName)) {
      return interaction.reply({ content: pick(lang, `🔐 この操作には \`${config.operatorRoleName}\` ロールまたは管理者権限が必要です。`, `🔐 This action requires the \`${config.operatorRoleName}\` role or administrator permission.`), ephemeral: true });
    }
    if (interaction.customId === "select_edit_event") {
      const eventId = interaction.values[0];
      try {
        const pendingKey = getPendingEditKey(interaction);
        const pendingEvents = sharedState.pendingEditEvents.get(pendingKey);
        const event = pendingEvents?.get(eventId);
        if (!event) {
          return interaction.reply({
            content: pick(lang, "❌ 編集対象の情報が見つかりません。もう一度編集を開いてください。", "❌ Event details are no longer available. Please open edit again."),
            ephemeral: true,
          });
        }
        return interaction.showModal(require("./modals").buildEditModal(event, lang));
      } catch (err) {
        return interaction.reply({ content: pick(lang, `❌ 取得失敗: ${err.message}`, `❌ Fetch failed: ${err.message}`), ephemeral: true });
      }
    }
    if (interaction.customId === "select_delete_event") {
      await interaction.deferUpdate();
      const eventId = interaction.values[0];
      try {
        const event = await getEvent(config.calendarId, eventId);
        const f     = formatEventLocal(event, lang);
        const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require("discord.js");
        return interaction.editReply({
          content: lang === "en"
            ? `⚠️ Are you sure you want to delete this?\n\n**${f.title}**  ${f.w} ${f.d}  \`${f.timeStr}\``
            : `⚠️ 本当に削除しますか？\n\n**${f.title}**　${f.d}日(${f.w})　\`${f.timeStr}\``,
          components: [new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`btn_confirm_delete_${eventId}`).setLabel(pick(lang, "🗑️ 削除する", "🗑️ Delete")).setStyle(ButtonStyle.Danger),
            new ButtonBuilder().setCustomId("btn_cancel_delete").setLabel(pick(lang, "キャンセル", "Cancel")).setStyle(ButtonStyle.Secondary),
          )],
        });
      } catch (err) {
        return interaction.editReply({ content: pick(lang, `❌ 取得失敗: ${err.message}`, `❌ Fetch failed: ${err.message}`), components: [] });
      }
    }
    if (interaction.customId.startsWith("select_notify_role_")) {
      const eid  = interaction.customId.slice("select_notify_role_".length);
      const rid  = interaction.values[0];
      return interaction.update({ content: pick(lang, `⏰ <@&${rid}> への通知タイミングを選択してください：`, `⏰ Select notification timing for <@&${rid}>:`), components: buildNotifyTimeButtons(eid, rid, "role", lang) });
    }
    if (interaction.customId.startsWith("select_notify_user_")) {
      const eid = interaction.customId.slice("select_notify_user_".length);
      const uid = interaction.values[0];
      return interaction.update({ content: pick(lang, `⏰ <@${uid}> への通知タイミングを選択してください：`, `⏰ Select notification timing for <@${uid}>:`), components: buildNotifyTimeButtons(eid, uid, "user", lang) });
    }
  }

  return { handleButton, handleSelect };
}

module.exports = { createButtonHandler };
