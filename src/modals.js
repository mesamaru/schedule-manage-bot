/**
 * modals.js
 * 予定の追加・編集モーダル
 */
const { ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder } = require("discord.js");
const { pick } = require("./i18n");
const { toFormValues } = require("./calendar");
const { toKey } = require("./idRegistry");

// Discord の TextInput の上限
const TEXT_INPUT_MAX = 4000;
const TITLE_MAX = 200;
const DESC_MAX  = 1000;

/** 空文字の value は送らない（Discord 側で不正値扱いされることがあるため） */
function withValue(input, value) {
  return value ? input.setValue(value) : input;
}

function buildAddModal(defaultDate = "", lang = "ja") {
  const modal = new ModalBuilder().setCustomId("modal_add").setTitle(pick(lang, "📅 予定を追加", "📅 Add Event"));
  modal.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId("title").setLabel(pick(lang, "タイトル（必須）", "Title (required)"))
        .setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(TITLE_MAX)
        .setPlaceholder(pick(lang, "例: 撮影、会議、配信", "e.g. Practice, Match, Meeting"))
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId("date").setLabel(pick(lang, "日付（必須）YYYY-MM-DD", "Date (required) YYYY-MM-DD"))
        .setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(10)
        .setPlaceholder(pick(lang, "例: 2026-05-20", "e.g. 2026-05-20")).setValue(defaultDate)
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId("start_time").setLabel(pick(lang, "開始時刻（任意）HHMM または HH:MM　空欄で終日", "Start (optional) HHMM or HH:MM, blank=all-day"))
        .setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(8)
        .setPlaceholder(pick(lang, "例: 2100 / 21:00 / 2500(翌1時)", "e.g. 2100 / 21:00 / 2500(next day 1:00)"))
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId("end_time").setLabel(pick(lang, "終了時刻（任意）HHMM または HH:MM", "End time (optional) HHMM or HH:MM"))
        .setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(8)
        .setPlaceholder(pick(lang, "例: 2300 / 23:00 / 2700(翌3時)", "e.g. 2300 / 23:00 / 2700(next day 3:00)"))
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId("description").setLabel(pick(lang, "詳細・メモ（任意）", "Description/Notes (optional)"))
        .setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(DESC_MAX)
        .setPlaceholder(pick(lang, "例: 場所、持ち物、備考など", "e.g. Place, items, notes"))
    ),
  );
  return modal;
}

function buildEditModal(event, lang = "ja") {
  const modal = new ModalBuilder().setCustomId(`modal_edit_${toKey(event.id)}`).setTitle(pick(lang, "✏️ 予定を編集", "✏️ Edit Event"));

  // 翌日にまたがる終了時刻は 25:00 形式で入れる（01:00 にすると保存時に開始より前になる）
  const { dateStr, startTime, endTime } = toFormValues(event);
  // 既存の値が上限より長いと Discord がモーダル自体を拒否するので、上限を値に合わせて広げる
  const title = event.summary || "";
  const desc  = event.description || "";
  const titleMax = Math.min(TEXT_INPUT_MAX, Math.max(TITLE_MAX, title.length));
  const descMax  = Math.min(TEXT_INPUT_MAX, Math.max(DESC_MAX, desc.length));

  modal.addComponents(
    new ActionRowBuilder().addComponents(
      withValue(new TextInputBuilder().setCustomId("title").setLabel(pick(lang, "タイトル（必須）", "Title (required)"))
        .setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(titleMax)
        , title.slice(0, TEXT_INPUT_MAX))
    ),
    new ActionRowBuilder().addComponents(
      withValue(new TextInputBuilder().setCustomId("date").setLabel(pick(lang, "日付（必須）YYYY-MM-DD", "Date (required) YYYY-MM-DD"))
        .setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(10), dateStr)
    ),
    new ActionRowBuilder().addComponents(
      withValue(new TextInputBuilder().setCustomId("start_time").setLabel(pick(lang, "開始時刻（任意）HHMM または HH:MM　空欄で終日", "Start (optional) HHMM or HH:MM, blank=all-day"))
        .setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(8), startTime)
    ),
    new ActionRowBuilder().addComponents(
      withValue(new TextInputBuilder().setCustomId("end_time").setLabel(pick(lang, "終了時刻（任意）HHMM または HH:MM", "End time (optional) HHMM or HH:MM"))
        .setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(8), endTime)
    ),
    new ActionRowBuilder().addComponents(
      withValue(new TextInputBuilder().setCustomId("description").setLabel(pick(lang, "詳細・メモ（任意）", "Description/Notes (optional)"))
        .setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(descMax)
        .setPlaceholder(pick(lang, "例: 場所、持ち物、備考など", "e.g. Place, items, notes"))
        , desc.slice(0, TEXT_INPUT_MAX))
    ),
  );
  return modal;
}

module.exports = { buildAddModal, buildEditModal };
