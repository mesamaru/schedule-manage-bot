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

function createApp() {
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  const scheduler = createScheduler({ client, getAllGuildIds, loadConfig, config: { cronSchedule: process.env.CRON_SCHEDULE || "*/5 * * * *" } });
  const sharedState = {
    pendingEditInteractions: new Map(),
    pendingEditEvents: new Map(),
  };

  const commands = createCommandsHandler({ client, loadConfig, saveConfig, deleteConfig, getAllGuildIds, scheduler, runtime });
  const buttons  = createButtonHandler({ client, loadConfig, saveState, scheduler, runtime, sharedState });
  const modals   = createModalHandler({ loadConfig, saveState, scheduler, runtime, sharedState, client });
  const lifecycle = createLifecycle({ client, logger, loadConfig, getAllGuildIds, scheduler, runtime, registerGlobalCommands: () => registerGlobalCommands(client), saveState });

  async function routeInteraction(interaction) {
    if (interaction.isChatInputCommand()) return commands.handleChatInputCommand(interaction);
    const config = loadConfig(interaction.guildId);
    if (!config) {
      if (!interaction.replied && !interaction.deferred) {
        const lang = interaction.locale?.toLowerCase().startsWith("en") ? "en" : "ja";
        return interaction.reply({ content: lang === "en" ? "❌ This server is not set up. Ask an administrator to run `/setup` first." : "❌ このサーバーはセットアップされていません。管理者に `/setup` の実行を依頼してください。", flags: MessageFlags.Ephemeral }).catch(() => {});
      }
      return;
    }
    if (interaction.isButton()) return buttons.handleButton(interaction);
    if (interaction.isStringSelectMenu() || interaction.isRoleSelectMenu() || interaction.isUserSelectMenu()) return buttons.handleSelect(interaction);
    if (interaction.isModalSubmit()) return modals.handleModal(interaction);
  }

  client.on("interactionCreate", async (interaction) => {
    try {
      await routeInteraction(interaction);
    } catch (err) {
      // ここで拾わないと Discord 側は「インタラクションに失敗しました」とだけ表示して原因が残らない
      console.error(`[Interaction][${interaction.guildId}] ${interaction.customId || interaction.commandName || interaction.type}: ${err?.stack || err?.message || err}`);
      const lang = interaction.locale?.toLowerCase().startsWith("en") ? "en" : "ja";
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
  client.login(process.env.DISCORD_TOKEN);
  return { client, scheduler, commands, buttons, modals, lifecycle };
}

module.exports = { createApp };
