const { MessageFlags } = require("discord.js");
const { addEvent, updateEvent, normalizeDate, normalizeTime } = require("./calendar");
const { buildNoticeManageComponents } = require("./embed");
const { resetFiredForEvent } = require("./storage");
const { getLang, pick } = require("./i18n");
const { fromKey } = require("./idRegistry");

function createModalHandler({ loadConfig, scheduler, runtime, sharedState, client }) {
  const { fmtCd, startCountdownDelete, sendAuditLog, hasPermission } = runtime;

  function getPendingEditKey(interaction) {
    return `${interaction.guildId}:${interaction.user.id}`;
  }

  async function replyTemp(interaction, content, seconds, lang) {
    await interaction.editReply({ content: fmtCd(content, seconds, lang), components: [] });
    startCountdownDelete(interaction, content, seconds, lang);
  }

  /** 予定の変更は成功済み。表示の更新に失敗しても「追加失敗」等とは表示しない */
  function syncAfterChange(guildId, config) {
    scheduler.sync(guildId, config, { force: true, notify: false }).catch((err) => {
      console.error(`[Sync][${guildId}] 変更後の表示更新に失敗: ${err?.message || err}`);
    });
  }

  /** モーダルの入力値を検証・正規化する。不正ならエラーメッセージを返す */
  function readForm(interaction, lang) {
    const title       = interaction.fields.getTextInputValue("title").trim();
    const rawDate     = interaction.fields.getTextInputValue("date");
    const rawStart    = interaction.fields.getTextInputValue("start_time");
    const rawEnd      = interaction.fields.getTextInputValue("end_time");
    const description = interaction.fields.getTextInputValue("description").trim();

    if (!title) return { error: pick(lang, "❌ タイトルを入力してください。", "❌ Title is required.") };
    const dateStr = normalizeDate(rawDate);
    if (!dateStr) {
      return { error: pick(lang,
        `❌ 日付「${rawDate}」を解釈できませんでした。\`YYYY-MM-DD\` 形式で入力してください（例: \`2026-05-20\`）。`,
        `❌ Could not parse date "${rawDate}". Use \`YYYY-MM-DD\` (e.g. \`2026-05-20\`).`) };
    }
    const startTime = normalizeTime(rawStart);
    const endTime   = normalizeTime(rawEnd);
    if (startTime === null || endTime === null) {
      return { error: pick(lang,
        "❌ 時刻は `HH:MM` または `HHMM` 形式で入力してください（翌日にまたがる場合は `2500` = 翌1時）。",
        "❌ Time must be `HH:MM` or `HHMM` (use `2500` for 1:00 next day).") };
    }
    if (!startTime && endTime) {
      return { error: pick(lang, "❌ 終了時刻だけは指定できません。開始時刻も入力してください。", "❌ Please also enter a start time.") };
    }
    return { title, dateStr, startTime, endTime, description };
  }

  function timeLabel(form, lang) {
    if (!form.startTime) return pick(lang, "終日", "All day");
    return `${form.startTime}~${form.endTime || ""}`;
  }

  async function handleModal(interaction) {
    const config = loadConfig(interaction.guildId);
    const lang = getLang(config);
    // 応答期限（3 秒）に間に合うよう最初に defer する
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    if (!hasPermission(interaction, config.operatorRoleName)) {
      return replyTemp(interaction, pick(lang,
        `🔐 この操作には \`${config.operatorRoleName}\` ロールまたは管理者権限が必要です。`,
        `🔐 This action requires the \`${config.operatorRoleName}\` role or administrator permission.`), 8, lang);
    }

    const form = readForm(interaction, lang);
    if (form.error) return replyTemp(interaction, form.error, 10, lang);

    const timeStr  = timeLabel(form, lang);
    const summary  = `**${form.title}**　${form.dateStr} ${timeStr}${form.description ? `\n📝 ${form.description.slice(0, 500)}` : ""}`;

    if (interaction.customId === "modal_add") {
      let event;
      try {
        event = await addEvent(config.calendarId, form);
      } catch (err) {
        return replyTemp(interaction, pick(lang, `❌ 追加失敗: ${err.message}`, `❌ Add failed: ${err.message}`), 10, lang);
      }
      const { content: nc, components: nco } = buildNoticeManageComponents(interaction.guildId, event.id, lang);
      await interaction.editReply({
        content: pick(lang, `✅ 追加しました！\n${summary}\n\n${nc}`, `✅ Added!\n${summary}\n\n${nc}`).slice(0, 2000),
        components: nco,
      });
      sendAuditLog(client, "追加", interaction, { title: form.title, dateStr: form.dateStr, timeStr, desc: form.description }, config);
      syncAfterChange(interaction.guildId, config);
      return;
    }

    if (interaction.customId.startsWith("modal_edit_")) {
      const pendingKey = getPendingEditKey(interaction);
      const pending = sharedState.pendingEdits.get(pendingKey);
      sharedState.pendingEdits.delete(pendingKey);
      // 編集対象の選択メニュー（エフェメラル）を片付ける
      pending?.interaction?.deleteReply().catch(() => {});

      const eventId = fromKey(interaction.customId.slice("modal_edit_".length));
      if (!eventId) {
        return replyTemp(interaction, pick(lang, "⚠️ この編集画面は期限切れです。もう一度編集を開いてください。", "⚠️ This edit form has expired. Please open edit again."), 8, lang);
      }
      try {
        await updateEvent(config.calendarId, eventId, form);
      } catch (err) {
        return replyTemp(interaction, pick(lang, `❌ 更新失敗: ${err.message}`, `❌ Update failed: ${err.message}`), 10, lang);
      }
      resetFiredForEvent(interaction.guildId, eventId);
      const { content: nc, components: nco } = buildNoticeManageComponents(interaction.guildId, eventId, lang);
      await interaction.editReply({
        content: pick(lang, `✅ 更新しました！\n${summary}\n\n${nc}`, `✅ Updated!\n${summary}\n\n${nc}`).slice(0, 2000),
        components: nco,
      });
      sendAuditLog(client, "変更", interaction, { title: form.title, dateStr: form.dateStr, timeStr, desc: form.description }, config);
      syncAfterChange(interaction.guildId, config);
    }
  }

  return { handleModal };
}

module.exports = { createModalHandler };
