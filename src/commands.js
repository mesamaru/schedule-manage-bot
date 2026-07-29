/**
 * commands.js
 * /add スラッシュコマンド + モーダルの定義と処理
 */

const { SlashCommandBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder, MessageFlags } = require("discord.js");
const { addEvent } = require("./calendar");

// スラッシュコマンド定義
const addCommand = new SlashCommandBuilder()
  .setName("add")
  .setDescription("Googleカレンダーに予定を追加します");

/**
 * /add コマンドが呼ばれたときにモーダルを表示する
 */
async function handleAddCommand(interaction) {
  const modal = new ModalBuilder()
    .setCustomId("add_event_modal")
    .setTitle("📅 予定を追加");

  const titleInput = new TextInputBuilder()
    .setCustomId("event_title")
    .setLabel("タイトル（必須）")
    .setStyle(TextInputStyle.Short)
    .setPlaceholder("例: 練習、試合、合宿")
    .setRequired(true)
    .setMaxLength(100);

  const dateInput = new TextInputBuilder()
    .setCustomId("event_date")
    .setLabel("日付（必須）YYYY-MM-DD形式")
    .setStyle(TextInputStyle.Short)
    .setPlaceholder("例: 2026-05-20")
    .setRequired(true)
    .setMaxLength(10);

  const startTimeInput = new TextInputBuilder()
    .setCustomId("event_start_time")
    .setLabel("開始時刻（任意）HH:MM形式・空欄で終日")
    .setStyle(TextInputStyle.Short)
    .setPlaceholder("例: 14:00")
    .setRequired(false)
    .setMaxLength(5);

  const endTimeInput = new TextInputBuilder()
    .setCustomId("event_end_time")
    .setLabel("終了時刻（任意）HH:MM形式")
    .setStyle(TextInputStyle.Short)
    .setPlaceholder("例: 16:00")
    .setRequired(false)
    .setMaxLength(5);

  const descInput = new TextInputBuilder()
    .setCustomId("event_description")
    .setLabel("メモ（任意）")
    .setStyle(TextInputStyle.Paragraph)
    .setPlaceholder("場所・持ち物など")
    .setRequired(false)
    .setMaxLength(500);

  modal.addComponents(
    new ActionRowBuilder().addComponents(titleInput),
    new ActionRowBuilder().addComponents(dateInput),
    new ActionRowBuilder().addComponents(startTimeInput),
    new ActionRowBuilder().addComponents(endTimeInput),
    new ActionRowBuilder().addComponents(descInput)
  );

  await interaction.showModal(modal);
}

/**
 * モーダルが送信されたときの処理
 */
async function handleModalSubmit(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const title = interaction.fields.getTextInputValue("event_title");
  const dateStr = interaction.fields.getTextInputValue("event_date");
  const startTime = interaction.fields.getTextInputValue("event_start_time").trim();
  const endTime = interaction.fields.getTextInputValue("event_end_time").trim();
  const description = interaction.fields.getTextInputValue("event_description").trim();

  // 日付バリデーション
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    return interaction.editReply({ content: "❌ 日付の形式が正しくありません。`YYYY-MM-DD` で入力してください。例: `2026-05-20`" });
  }

  // 時刻バリデーション
  if (startTime && !/^\d{2}:\d{2}$/.test(startTime)) {
    return interaction.editReply({ content: "❌ 開始時刻の形式が正しくありません。`HH:MM` で入力してください。例: `14:00`" });
  }

  try {
    const event = await addEvent({ title, dateStr, startTime, endTime, description });

    const [year, month, day] = dateStr.split("-");
    const timeInfo = startTime ? ` ${startTime}〜${endTime || ""}` : " 終日";

    await interaction.editReply({
      content: `✅ 予定を追加しました！\n📅 **${title}**\n🗓️ ${year}/${month}/${day}${timeInfo}\n${description ? `📝 ${description}` : ""}`,
    });

    console.log(`[Add] 予定追加: ${title} (${dateStr}) by ${interaction.user.tag}`);
  } catch (err) {
    console.error("[Add] 追加エラー:", err.message);
    await interaction.editReply({ content: `❌ 追加に失敗しました: ${err.message}` });
  }
}

module.exports = { addCommand, handleAddCommand, handleModalSubmit };
