require("dotenv").config();
const logger = require("./logger");
const { Client, GatewayIntentBits, MessageFlags } = require("discord.js");
const { registerGlobalCommands, createCommandsHandler } = require("./commandsHandler");
const { createButtonHandler } = require("./buttonHandlers");
const { createModalHandler } = require("./modalHandlers");
const { createScheduler } = require("./scheduler");
const { createLifecycle } = require("./lifecycle");
const { saveState } = require("./storage");
const { loadConfig, saveConfig, deleteConfig, getAllGuildIds } = require("./guildConfig");
const runtime = require("./runtime");

// Discord のインタラクション応答期限
const INTERACTION_DEADLINE_MS = 3000;

function validateEnv() {
  const missing = ["DISCORD_TOKEN", "GOOGLE_CLIENT_EMAIL", "GOOGLE_PRIVATE_KEY"].filter(k => !process.env[k]);
  if (missing.length > 0) {
    console.error(`[起動] 環境変数が設定されていません: ${missing.join(", ")}（.env またはパネルの変数を確認してください）`);
    process.exit(1);
  }
}

function localeLang(interaction) {
  return interaction.locale?.toLowerCase().startsWith("en") ? "en" : "ja";
}

function createApp() {
  validateEnv();
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  const scheduler = createScheduler({ client, getAllGuildIds, loadConfig, config: { cronSchedule: process.env.CRON_SCHEDULE || "*/5 * * * *" } });
  const sharedState = {
    // `${guildId}:${userId}` → { interaction, events: Map<eventId, event>, createdAt }
    pendingEdits: new Map(),
  };

  const commands = createCommandsHandler({ client, loadConfig, saveConfig, deleteConfig, getAllGuildIds, scheduler, runtime });
  const buttons  = createButtonHandler({ client, loadConfig, saveState, scheduler, runtime, sharedState });
  const modals   = createModalHandler({ loadConfig, saveState, scheduler, runtime, sharedState, client });
  const lifecycle = createLifecycle({ client, logger, loadConfig, getAllGuildIds, scheduler, runtime, registerGlobalCommands: () => registerGlobalCommands(client), saveState });

  async function routeInteraction(interaction) {
    if (!interaction.inGuild()) {
      if (interaction.isRepliable()) {
        await interaction.reply({ content: localeLang(interaction) === "en" ? "❌ Please use this bot inside a server." : "❌ サーバー内で使用してください。", flags: MessageFlags.Ephemeral }).catch(() => {});
      }
      return;
    }
    if (interaction.isChatInputCommand()) return commands.handleChatInputCommand(interaction);
    const config = loadConfig(interaction.guildId);
    if (!config) {
      if (interaction.isRepliable()) {
        const lang = localeLang(interaction);
        await interaction.reply({ content: lang === "en" ? "❌ This server is not set up. Ask an administrator to run `/setup` first." : "❌ このサーバーはセットアップされていません。管理者に `/setup` の実行を依頼してください。", flags: MessageFlags.Ephemeral }).catch(() => {});
      }
      return;
    }
    if (interaction.isButton()) return buttons.handleButton(interaction);
    if (interaction.isStringSelectMenu() || interaction.isRoleSelectMenu() || interaction.isUserSelectMenu()) return buttons.handleSelect(interaction);
    if (interaction.isModalSubmit()) return modals.handleModal(interaction);
  }

  client.on("interactionCreate", async (interaction) => {
    const label = interaction.customId || interaction.commandName || interaction.type;
    try {
      await routeInteraction(interaction);
    } catch (err) {
      // 10062 Unknown interaction / 40060 Already acknowledged:
      // もう応答できないので、エラー返信を試みても同じエラーになるだけ。原因の手がかりだけ残す
      if (runtime.isInteractionGone(err)) {
        const ageMs = Date.now() - interaction.createdTimestamp;
        const hint = ageMs < INTERACTION_DEADLINE_MS
          ? "受信から期限内なのに応答できませんでした。同じ Bot トークンで別のプロセス（Fly.io・別パネル・ローカル実行など）が動いており、そちらが先に応答した可能性が高いです"
          : "受信時点で応答期限（3秒）を過ぎていました。再接続直後に古い操作が届いたか、処理が混み合っていた可能性があります";
        console.warn(`[Interaction][${interaction.guildId}] ${label}: 応答できませんでした (code=${err.code}, 経過 ${ageMs}ms, instance=${runtime.INSTANCE_ID})。${hint}`);
        return;
      }
      // ここで拾わないと Discord 側は「インタラクションに失敗しました」とだけ表示して原因が残らない
      console.error(`[Interaction][${interaction.guildId}] ${label}: ${err?.stack || err?.message || err}`);
      const cfg = loadConfig(interaction.guildId);
      const lang = cfg ? runtime.getLang(cfg) : localeLang(interaction);
      const content = lang === "en" ? "❌ Something went wrong. Please try again." : "❌ 処理中にエラーが発生しました。もう一度お試しください。";
      if (interaction.isRepliable?.()) {
        const reply = interaction.replied || interaction.deferred
          ? interaction.followUp({ content, flags: MessageFlags.Ephemeral })
          : interaction.reply({ content, flags: MessageFlags.Ephemeral });
        await reply.catch(() => {});
      }
    }
  });

  lifecycle.setupLifecycle();
  client.login(process.env.DISCORD_TOKEN).catch((err) => {
    // トークン不正などでログインできない場合、そのまま放置すると何もしないプロセスが残り続ける。
    // 終了してパネル側の自動再起動・エラー表示に任せる
    console.error(`[起動] Discord へのログインに失敗しました: ${err.message}`);
    process.exit(1);
  });
  return { client, scheduler, commands, buttons, modals, lifecycle };
}

module.exports = { createApp };
