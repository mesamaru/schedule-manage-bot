const { buildStatusEmbed, buildActionButtons, buildCalendarButtons } = require("./embed");
const { loadState } = require("./storage");
const { getLang } = require("./i18n");
const { appVersion } = require("./version");

function createLifecycle({ client, logger, loadConfig, getAllGuildIds, scheduler, runtime, registerGlobalCommands, saveState }) {
  const { getAndIncrementStartupCount, fmtTimestamp, sendSystemLog } = runtime;

  let isShuttingDown = false;

  async function gracefulShutdown(signal) {
    if (isShuttingDown) return;
    isShuttingDown = true;
    const ts = fmtTimestamp();
    console.log(`[${signal}] シャットダウン開始...`);
    const timer = setTimeout(() => { console.error("[Shutdown] タイムアウト"); process.exit(1); }, 10000);
    try {
      await sendSystemLog(client, 0xed4245, "shutdown", { signal, ts }, "startup", getAllGuildIds, loadConfig).catch(() => {});
      for (const gid of getAllGuildIds()) {
        const cfg = loadConfig(gid);
        if (!cfg) continue;
        const state   = loadState(gid);
        const channel = await client.channels.fetch(cfg.channelId).catch(() => null);
        if (!channel) continue;
        const lang = getLang(cfg);
        const { year, month } = runtime.currentYM();
        // ボタンは削除せず「無効化」する。削除すると customId が消え、次回起動時に
        // 自分が管理しているメッセージだと判別できず重複投稿になる
        if (state.statusMessageId) {
          try {
            const msg = await channel.messages.fetch(state.statusMessageId);
            await msg.edit({
              embeds: [buildStatusEmbed(gid, [], state.updatedAt, cfg.operatorRoleName, false, lang)],
              components: [buildActionButtons(lang, { disabled: true })],
            });
          } catch (e) { console.error(`[Shutdown][${gid}]`, e.message); }
        }
        if (state.calendarMessageId) {
          try {
            const msg = await channel.messages.fetch(state.calendarMessageId);
            await msg.edit({ components: [buildCalendarButtons(year, month, lang, { disabled: true })] });
          } catch (e) { console.error(`[Shutdown][${gid}]`, e.message); }
        }
      }
    } catch (err) { console.error("[Shutdown] エラー:", err.message); }
    clearTimeout(timer);
    await client.destroy().catch(() => {});
    await logger.close();
    process.exit(0);
  }

  function setupLifecycle() {
    client.once("clientReady", async () => {
      const startupCount = getAndIncrementStartupCount(require("fs"), require("path"));
      const ts           = fmtTimestamp();
      console.log("========================================");
      console.log(`  gcal-discord-bot v${appVersion} 起動完了（マルチギルド）`);
      console.log(`  ログイン: ${client.user.tag}`);
      console.log(`  スケジュール: ${scheduler.cronSchedule}`);
      console.log(`  起動回数: ${startupCount} 回目 | ${ts}`);
      console.log(`  PID: ${process.pid}`);
      console.log(`  CWD: ${process.cwd()}`);
      console.log("========================================");
      await registerGlobalCommands();
      const guildIds = getAllGuildIds();
      console.log(`[起動] 設定済みギルド数: ${guildIds.length}`);
      for (const gid of guildIds) {
        const cfg = loadConfig(gid);
        if (cfg) scheduler.run(gid, cfg, true).catch(console.error);
      }
      scheduler.startCron();

      const isRestart  = startupCount > 1;
      const logColor   = isRestart ? 0xfee75c : 0x57f287;
      sendSystemLog(client, logColor, "startup", {
        startupCount,
        clientTag: client.user.tag,
        ts,
        pid: process.pid,
      }, "startup", getAllGuildIds, loadConfig).catch(console.error);
    });

    client.on("guildDelete", (guild) => {
      require("./guildConfig").deleteConfig(guild.id);
      console.log(`[GuildDelete] 設定削除: ${guild.id}`);
    });

    client.on("shardDisconnect", (event, shardId) => {
      const ts = fmtTimestamp();
      console.warn(`[Discord] 接続切断 (shard:${shardId}, code:${event.code}) ${ts}`);
      sendSystemLog(client, 0xed4245, "disconnect", { shardId, code: event.code, ts }, "connection", getAllGuildIds, loadConfig).catch(() => {});
    });
    client.on("shardReconnecting", (shardId) => {
      const ts = fmtTimestamp();
      console.log(`[Discord] 再接続中... (shard:${shardId}) ${ts}`);
      sendSystemLog(client, 0x5865f2, "reconnecting", { shardId, ts }, "connection", getAllGuildIds, loadConfig).catch(() => {});
    });
    client.on("shardResume", (shardId, replayed) => {
      const ts = fmtTimestamp();
      console.log(`[Discord] 接続再開 (shard:${shardId}, replayed:${replayed}) ${ts}`);
      sendSystemLog(client, 0x57f287, "resume", { shardId, replayed, ts }, "connection", getAllGuildIds, loadConfig).catch(() => {});
    });
    client.on("error", (err) => {
      const ts = fmtTimestamp();
      console.error(`[Discord] エラー: ${err.message} ${ts}`);
      sendSystemLog(client, 0xed4245, "error", { message: err.message, ts }, "error", getAllGuildIds, loadConfig).catch(() => {});
    });

    process.on("SIGTERM", () => gracefulShutdown("SIGTERM").catch(() => process.exit(1)));
    process.on("SIGINT",  () => gracefulShutdown("SIGINT").catch(() =>  process.exit(1)));
    process.on("SIGHUP",  () => gracefulShutdown("SIGHUP").catch(() =>  process.exit(1)));
    process.on("unhandledRejection", (r) => console.error("[UnhandledRejection]", r));
    process.on("uncaughtException",  (e) => console.error("[UncaughtException]",  e));
  }

  return { setupLifecycle, gracefulShutdown };
}

module.exports = { createLifecycle };
