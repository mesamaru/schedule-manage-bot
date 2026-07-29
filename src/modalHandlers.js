const { addEvent, updateEvent, hashEvents } = require("./calendar");
const { buildNoticeManageComponents } = require("./embed");
const { resetFiredForEvent } = require("./storage");
const { MessageFlags } = require("discord.js");
const { getLang, pick } = require("./i18n");

function createModalHandler({ loadConfig, saveState, scheduler, runtime, sharedState, client }) {
  const { normalizeTime, fmtCd, startCountdownDelete, sendAuditLog, currentYM, formatEventLocal } = runtime;

  function getPendingEditKey(interaction) {
    return `${interaction.guildId}:${interaction.user.id}`;
  }

  async function handleModal(interaction) {
    const config = loadConfig(interaction.guildId);
    const lang = getLang(config);
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const title       = interaction.fields.getTextInputValue("title");
    const dateStr     = interaction.fields.getTextInputValue("date");
    const startTime   = normalizeTime(interaction.fields.getTextInputValue("start_time"));
    const endTime     = normalizeTime(interaction.fields.getTextInputValue("end_time"));
    const description = interaction.fields.getTextInputValue("description").trim();

    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
      const emsg = pick(lang, "❌ 日付は `YYYY-MM-DD` 形式で。例: `2026-05-20`", "❌ Date must be in `YYYY-MM-DD` format. Example: `2026-05-20`");
      await interaction.editReply({ content: fmtCd(emsg, 8, lang) });
      startCountdownDelete(interaction, emsg, 8, lang);
      return;
    }
    if (startTime && !/^\d{2}:\d{2}$/.test(startTime)) {
      const emsg = pick(lang, "❌ 時刻は `HH:MM` または `HHMM` 形式で入力してください。", "❌ Time must be in `HH:MM` or `HHMM` format.");
      await interaction.editReply({ content: fmtCd(emsg, 8, lang) });
      startCountdownDelete(interaction, emsg, 8, lang);
      return;
    }

    const timeInfo = startTime ? ` ${startTime}~${endTime || ""}` : (lang === "en" ? " All day" : " 終日");

    if (interaction.customId === "modal_add") {
      try {
        const event = await addEvent(config.calendarId, { title, dateStr, startTime, endTime, description });
        const { content: nc, components: nco } = buildNoticeManageComponents(interaction.guildId, event.id, lang);
        await interaction.editReply({
          content: pick(lang,
            `✅ 追加しました！\n**${title}**　${dateStr}${timeInfo}${description ? `\n📝 ${description}` : ""}\n\n` + nc,
            `✅ Added!\n**${title}**  ${dateStr}${timeInfo}${description ? `\n📝 ${description}` : ""}\n\n` + nc),
          components: nco,
        });
        const { year, month } = currentYM();
        const events = await require("./calendar").getMonthEvents(config.calendarId, year, month);
        saveState(interaction.guildId, { lastHash: hashEvents(events), updatedAt: new Date().toISOString() });
        await scheduler.updateBoth(interaction.guildId, config, events, year, month);
        sendAuditLog(client, "追加", interaction, { title, dateStr, timeStr: startTime ? `${startTime}~${endTime || ""}` : (lang === "en" ? "All day" : "終日"), desc: description }, config);
      } catch (err) {
        const emsg = pick(lang, `❌ 追加失敗: ${err.message}`, `❌ Add failed: ${err.message}`);
        await interaction.editReply({ content: fmtCd(emsg, 8, lang) });
        startCountdownDelete(interaction, emsg, 8, lang);
      }
    }

    if (interaction.customId.startsWith("modal_edit_")) {
      const pendingKey = getPendingEditKey(interaction);
      const prev = sharedState.pendingEditInteractions.get(pendingKey);
      if (prev) {
        prev.deleteReply().catch(() => {});
        sharedState.pendingEditInteractions.delete(pendingKey);
      }
      sharedState.pendingEditEvents.delete(pendingKey);
      const eventId = interaction.customId.replace("modal_edit_", "");
      try {
        await updateEvent(config.calendarId, eventId, { title, dateStr, startTime, endTime, description });
        resetFiredForEvent(interaction.guildId, eventId);
        const { content: nc, components: nco } = buildNoticeManageComponents(interaction.guildId, eventId, lang);
        await interaction.editReply({
          content: pick(lang,
            `✅ 更新しました！\n**${title}**　${dateStr}${timeInfo}${description ? `\n📝 ${description}` : ""}\n\n` + nc,
            `✅ Updated!\n**${title}**  ${dateStr}${timeInfo}${description ? `\n📝 ${description}` : ""}\n\n` + nc),
          components: nco,
        });
        const { year, month } = currentYM();
        const events = await require("./calendar").getMonthEvents(config.calendarId, year, month);
        saveState(interaction.guildId, { lastHash: hashEvents(events), updatedAt: new Date().toISOString() });
        await scheduler.updateBoth(interaction.guildId, config, events, year, month);
        sendAuditLog(client, "変更", interaction, { title, dateStr, timeStr: startTime ? `${startTime}~${endTime || ""}` : (lang === "en" ? "All day" : "終日"), desc: description }, config);
      } catch (err) {
        const emsg = pick(lang, `❌ 更新失敗: ${err.message}`, `❌ Update failed: ${err.message}`);
        await interaction.editReply({ content: fmtCd(emsg, 8, lang) });
        startCountdownDelete(interaction, emsg, 8, lang);
      }
    }
  }

  return { handleModal };
}

module.exports = { createModalHandler };
