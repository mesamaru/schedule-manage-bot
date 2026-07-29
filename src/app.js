require("dotenv").config();
const fs = require("fs");
const path = require("path");
const logger = require("./logger");
const { Client, GatewayIntentBits, MessageFlags } = require("discord.js");
const { buildCommands, registerGlobalCommands, createCommandsHandler } = require("./commandsHandler");
const { createButtonHandler } = require("./buttonHandlers");
const { createModalHandler } = require("./modalHandlers");
const { createScheduler } = require("./scheduler");
const { createLifecycle } = require("./lifecycle");
const { loadState, saveState, getNoticesForEvent, setNoticesForEvent, deleteNoticesForEvent, resetFiredForEvent, deleteNoticeEntry } = require("./storage");
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

  client.on("interactionCreate", async (interaction) => {
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
  });

  lifecycle.setupLifecycle();
  client.login(process.env.DISCORD_TOKEN);
  return { client, scheduler, commands, buttons, modals, lifecycle };
}

module.exports = { createApp };
