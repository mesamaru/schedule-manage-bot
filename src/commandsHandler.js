const { REST, Routes, PermissionFlagsBits, SlashCommandBuilder, MessageFlags, ChannelType } = require("discord.js");
const { getLang, pick } = require("./i18n");
const { loadState, saveState } = require("./storage");

// 投稿先に選べるチャンネル（ボイス・カテゴリ・フォーラム等を選ぶと投稿に失敗するため絞る）
const TEXT_CHANNEL_TYPES = [ChannelType.GuildText, ChannelType.GuildAnnouncement];
// Bot が投稿先チャンネルで必要な権限
const REQUIRED_PERMS = [
  ["ViewChannel", "チャンネルを見る"],
  ["SendMessages", "メッセージを送信"],
  ["EmbedLinks", "埋め込みリンク"],
  ["ReadMessageHistory", "メッセージ履歴を読む"],
];

function buildCommands() {
  const setupCommand = new SlashCommandBuilder()
    .setName("setup")
    .setDescription("このサーバーでスケジュール管理Botを設定します")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addChannelOption(opt =>
      opt.setName("channel").setDescription("カレンダーを投稿するチャンネル").setRequired(true).addChannelTypes(...TEXT_CHANNEL_TYPES))
    .addStringOption(opt =>
      opt.setName("calendar_id").setDescription("Google Calendar ID").setRequired(true))
    .addChannelOption(opt =>
      opt.setName("notify_channel").setDescription("通知送信先チャンネル（省略: カレンダーチャンネルと同じ）").addChannelTypes(...TEXT_CHANNEL_TYPES))
    .addChannelOption(opt =>
      opt.setName("log_channel").setDescription("操作ログ送信先チャンネル（省略: ログなし）").addChannelTypes(...TEXT_CHANNEL_TYPES))
    .addStringOption(opt =>
      opt.setName("operator_role").setDescription("操作を許可するロール名（デフォルト: CalendarOperator）"));

  const removeSetupCommand = new SlashCommandBuilder()
    .setName("setup-remove")
    .setDescription("このサーバーのBot設定をすべて削除します")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);

  const logNotifyCommand = new SlashCommandBuilder()
    .setName("log-notify")
    .setDescription("ログチャンネル通知のON/OFFを切り替えます")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption(opt =>
      opt.setName("category")
        .setDescription("切り替える通知カテゴリ")
        .setRequired(true)
        .addChoices(
          { name: "全体", value: "all" },
          { name: "起動/再起動", value: "startup" },
          { name: "接続切断/再接続", value: "connection" },
          { name: "エラー", value: "error" }
        ))
    .addStringOption(opt =>
      opt.setName("state")
        .setDescription("通知状態")
        .setRequired(true)
        .addChoices(
          { name: "ON", value: "on" },
          { name: "OFF", value: "off" }
        ));

  const languageCommand = new SlashCommandBuilder()
    .setName("language")
    .setDescription("Bot language / Botの表示言語を変更")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption(opt =>
      opt.setName("lang")
        .setDescription("Language")
        .setRequired(true)
        .addChoices(
          { name: "日本語", value: "ja" },
          { name: "English", value: "en" }
        ));

  return [setupCommand, removeSetupCommand, logNotifyCommand, languageCommand];
}

async function registerGlobalCommands(client) {
  const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);
  const commands = buildCommands();
  try {
    await rest.put(Routes.applicationCommands(client.user.id), { body: commands.map(c => c.toJSON()) });
    console.log(`[Commands] スラッシュコマンドを登録しました（${commands.length} 件）`);
  } catch (err) {
    console.error(`[Commands] スラッシュコマンドの登録に失敗: ${err.message}`);
  }
}

/** Bot に足りない権限の一覧（日本語名）を返す */
function missingPermissions(channel, me) {
  const perms = channel?.permissionsFor?.(me);
  if (!perms) return [];
  return REQUIRED_PERMS.filter(([flag]) => !perms.has(PermissionFlagsBits[flag])).map(([, label]) => label);
}

function createCommandsHandler({ client, loadConfig, saveConfig, deleteConfig, getAllGuildIds, scheduler, runtime }) {

  async function handleSetup(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const setupLang = interaction.locale?.toLowerCase().startsWith("en") ? "en" : "ja";
    const channel       = interaction.options.getChannel("channel");
    const calendarId    = interaction.options.getString("calendar_id");
    const notifyChannel = interaction.options.getChannel("notify_channel");
    const logChannel    = interaction.options.getChannel("log_channel");
    const operatorRole  = (interaction.options.getString("operator_role") || "CalendarOperator").trim();
    const previous      = loadConfig(interaction.guildId);

    // 投稿先で必要な権限がなければ、保存する前に知らせる
    const me = interaction.guild?.members?.me;
    const lacking = [channel, notifyChannel, logChannel].filter(Boolean)
      .flatMap(ch => missingPermissions(ch, me).map(p => `<#${ch.id}>: ${p}`));
    if (lacking.length > 0) {
      return interaction.editReply({
        content: (setupLang === "en" ? "❌ The bot is missing permissions:\n" : "❌ Bot に次の権限がありません:\n") + lacking.map(l => `- ${l}`).join("\n"),
      });
    }

    const config = {
      channelId:        channel.id,
      calendarId:       calendarId.trim(),
      notifyChannelId:  notifyChannel?.id || null,
      logChannelId:     logChannel?.id || null,
      logEnabled:       logChannel ? true : false,
      // 再セットアップ時は既存の言語・ログ設定を引き継ぐ
      language:         previous?.language || setupLang,
      systemLogToggles: previous?.systemLogToggles || { startup: true, connection: true, error: true },
      operatorRoleName: operatorRole,
    };
    // 投稿先チャンネルが変わったら、旧チャンネルのメッセージ ID は使えないので捨てる
    await scheduler.withGuildLock(interaction.guildId, async () => {
      saveConfig(interaction.guildId, config);
      if (previous && previous.channelId !== config.channelId) {
        const st = loadState(interaction.guildId);
        saveState(interaction.guildId, { calendarMessageId: null, statusMessageId: null, calendarRenderHash: null });
        console.log(`[Setup][${interaction.guildId}] 投稿先変更のため旧メッセージ ID を破棄: ${st.calendarMessageId}, ${st.statusMessageId}`);
      }
    });
    try {
      await scheduler.sync(interaction.guildId, config, { force: true, isFirst: true });
      const serviceEmail = process.env.GOOGLE_CLIENT_EMAIL || "（未設定）";
      await interaction.editReply({
        content:
          (setupLang === "en" ? "✅ **Setup completed!**\n\n" : "✅ **セットアップ完了！**\n\n") +
          (setupLang === "en" ? `📅 Calendar channel: <#${channel.id}>\n` : `📅 カレンダーチャンネル: <#${channel.id}>\n`) +
          `📆 Google Calendar ID: \`${calendarId}\`\n` +
          (setupLang === "en"
            ? `🔔 Notify channel: ${notifyChannel ? `<#${notifyChannel.id}>` : "Same as calendar channel"}\n`
            : `🔔 通知チャンネル: ${notifyChannel ? `<#${notifyChannel.id}>` : "カレンダーチャンネルと同じ"}\n`) +
          (setupLang === "en"
            ? `📝 Log channel: ${logChannel ? `<#${logChannel.id}>` : "None"}\n`
            : `📝 ログチャンネル: ${logChannel ? `<#${logChannel.id}>` : "なし"}\n`) +
          `🧾 ${setupLang === "en" ? "Log notify" : "ログ通知"}: ${logChannel ? "ON" : "OFF"}\n` +
          (setupLang === "en" ? `🔐 Operator role: \`${operatorRole}\`\n\n` : `🔐 操作ロール: \`${operatorRole}\`\n\n`) +
          (setupLang === "en"
            ? "> ⚠️ **Please share your Google Calendar with the service account**\n"
            : "> ⚠️ **Googleカレンダーの共有設定を確認してください**\n") +
          (setupLang === "en"
            ? `> Share \`${serviceEmail}\` as **Editor**.`
            : `> \`${serviceEmail}\` を「**編集者**」として共有してください。`),
      });
    } catch (err) {
      await interaction.editReply({
        content: setupLang === "en"
          ? `⚠️ Settings were saved, but posting calendar messages failed: \`${err.message}\``
          : `⚠️ 設定は保存されましたが、カレンダー投稿に失敗しました: \`${err.message}\``,
      });
    }
  }

  async function handleRemoveSetup(interaction) {
    const config = loadConfig(interaction.guildId);
    if (!config) {
      const lang = interaction.locale?.toLowerCase().startsWith("en") ? "en" : "ja";
      return interaction.reply({ content: lang === "en" ? "ℹ️ This server is not set up yet." : "ℹ️ このサーバーはまだセットアップされていません。", flags: MessageFlags.Ephemeral });
    }
    await scheduler.withGuildLock(interaction.guildId, async () => deleteConfig(interaction.guildId));
    return interaction.reply({ content: getLang(config) === "en" ? "✅ Removed this server's setup." : "✅ このサーバーの設定を削除しました。", flags: MessageFlags.Ephemeral });
  }

  async function handleLogNotify(interaction) {
    const config = loadConfig(interaction.guildId);
    if (!config) {
      const lang = interaction.locale?.toLowerCase().startsWith("en") ? "en" : "ja";
      return interaction.reply({ content: lang === "en" ? "❌ This server is not set up. Please run `/setup` first." : "❌ このサーバーはセットアップされていません。先に `/setup` を実行してください。", flags: MessageFlags.Ephemeral });
    }
    const category = interaction.options.getString("category", true);
    const state = interaction.options.getString("state", true);
    if (state === "on" && !config.logChannelId) {
      return interaction.reply({ content: getLang(config) === "en" ? "❌ Log channel is not set. Configure `log_channel` in `/setup` first." : "❌ ログチャンネルが未設定です。`/setup` の `log_channel` を設定してください。", flags: MessageFlags.Ephemeral });
    }
    if (category === "all") config.logEnabled = (state === "on");
    else {
      config.systemLogToggles = runtime.normalizeSystemLogToggles(config);
      config.systemLogToggles[category] = (state === "on");
    }
    saveConfig(interaction.guildId, config);
    const labels = {
      all: pick(getLang(config), "全体", "All"),
      startup: pick(getLang(config), "起動/再起動", "Startup/Restart"),
      connection: pick(getLang(config), "接続切断/再接続", "Connection"),
      error: pick(getLang(config), "エラー", "Error"),
    };
    return interaction.reply({
      content: getLang(config) === "en"
        ? `✅ Log notification (${labels[category]}) set to **${state.toUpperCase()}**.`
        : `✅ ログ通知（${labels[category]}）を **${state.toUpperCase()}** に設定しました。`,
      flags: MessageFlags.Ephemeral,
    });
  }

  async function handleLanguage(interaction) {
    const config = loadConfig(interaction.guildId);
    if (!config) {
      const lang = interaction.locale?.toLowerCase().startsWith("en") ? "en" : "ja";
      return interaction.reply({ content: lang === "en" ? "❌ This server is not set up. Please run `/setup` first." : "❌ このサーバーはセットアップされていません。先に `/setup` を実行してください。", flags: MessageFlags.Ephemeral });
    }
    const selected = interaction.options.getString("lang", true);
    config.language = selected;
    saveConfig(interaction.guildId, config);
    await interaction.reply({
      content: selected === "en" ? "✅ Bot language set to **English**." : "✅ Botの表示言語を **日本語** に設定しました。",
      flags: MessageFlags.Ephemeral,
    });
    // カレンダー・ステータスの表示言語もすぐに切り替える
    scheduler.sync(interaction.guildId, config, { force: true, notify: false }).catch(() => {});
  }

  async function handleChatInputCommand(interaction) {
    if (interaction.commandName === "setup") return handleSetup(interaction);
    if (interaction.commandName === "setup-remove") return handleRemoveSetup(interaction);
    if (interaction.commandName === "log-notify") return handleLogNotify(interaction);
    if (interaction.commandName === "language") return handleLanguage(interaction);
  }

  return { buildCommands, registerGlobalCommands, handleChatInputCommand };
}

module.exports = { createCommandsHandler, buildCommands, registerGlobalCommands };
