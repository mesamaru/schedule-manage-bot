const { getMonthEvents, hashEvents } = require("./calendar");
const { buildCalendarEmbed, buildCalendarButtons, buildStatusEmbed, buildActionButtons } = require("./embed");
const { loadState, saveState } = require("./storage");
const { checkAndFireNotices } = require("./notifier");
const { getLang } = require("./i18n");
const { currentYM } = require("./runtime");

function createScheduler({ client, getAllGuildIds, loadConfig, config = {} }) {
  const guildRunning = new Map();
  const cronSchedule = config.cronSchedule || process.env.CRON_SCHEDULE || "*/5 * * * *";

  async function upsertCalendarMessage(guildId, guildConfig, events, year, month) {
    const lang = getLang(guildConfig);
    const channel = await client.channels.fetch(guildConfig.channelId);
    const embed   = buildCalendarEmbed(guildId, events, year, month, lang);
    const buttons = buildCalendarButtons(year, month, lang);
    const state   = loadState(guildId);
    if (state.calendarMessageId) {
      try {
        const msg = await channel.messages.fetch(state.calendarMessageId);
        await msg.edit({ embeds: [embed], components: [buttons] });
        return;
      } catch { console.warn(`[Cal][${guildId}] 再作成`); }
    }
    const msg = await channel.send({ embeds: [embed], components: [buttons] });
    saveState(guildId, { calendarMessageId: msg.id });
  }

  async function upsertStatusMessage(guildId, guildConfig, events) {
    const lang = getLang(guildConfig);
    const channel = await client.channels.fetch(guildConfig.channelId);
    const state   = loadState(guildId);
    const embed   = buildStatusEmbed(guildId, events, state.updatedAt, guildConfig.operatorRoleName, true, lang);
    const buttons = buildActionButtons(lang);
    if (state.statusMessageId) {
      try {
        const msg = await channel.messages.fetch(state.statusMessageId);
        await msg.edit({ embeds: [embed], components: [buttons] });
        return;
      } catch { console.warn(`[Status][${guildId}] 再作成`); }
    }
    const msg = await channel.send({ embeds: [embed], components: [buttons] });
    saveState(guildId, { statusMessageId: msg.id });
  }

  async function updateBoth(guildId, guildConfig, events, year, month) {
    await upsertCalendarMessage(guildId, guildConfig, events, year, month);
    await upsertStatusMessage(guildId, guildConfig, events);
  }

  async function run(guildId, guildConfig, isFirst = false, force = false) {
    if (guildRunning.get(guildId) && !isFirst) {
      console.warn(`[Cron][${guildId}] スキップ`);
      return;
    }
    guildRunning.set(guildId, true);
    const ts = new Date().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" });
    console.log(`[${ts}][${guildId}] チェック開始`);
    try {
      const { year, month } = currentYM();
      const events  = await getMonthEvents(guildConfig.calendarId, year, month);
      const newHash = hashEvents(events);
      const state   = loadState(guildId);
      const syncedAt = new Date().toISOString();
      if (isFirst || !state.lastHash || force || state.lastHash !== newHash) {
        // Save latest sync timestamp first so status embed always shows the current run time.
        saveState(guildId, { lastHash: newHash, updatedAt: syncedAt });
        await updateBoth(guildId, guildConfig, events, year, month);
      } else {
        // Even when no event diff exists, keep the "last sync" timestamp fresh.
        saveState(guildId, { updatedAt: syncedAt });
        await upsertStatusMessage(guildId, guildConfig, events);
      }
      await checkAndFireNotices(client, guildId, guildConfig);
    } catch (err) {
      console.error(`[Run][${guildId}] エラー:`, err);
    } finally {
      guildRunning.set(guildId, false);
    }
  }

  function startCron() {
    const cron = require("node-cron");
    cron.schedule(cronSchedule, async () => {
      for (const gid of getAllGuildIds()) {
        const cfg = loadConfig(gid);
        if (cfg) run(gid, cfg, false).catch(console.error);
      }
    }, { timezone: "Asia/Tokyo" });
    console.log(`[Cron] 登録完了: "${cronSchedule}"`);
  }

  return {
    cronSchedule,
    run,
    updateBoth,
    upsertCalendarMessage,
    upsertStatusMessage,
    startCron,
  };
}

module.exports = { createScheduler };
