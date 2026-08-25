const { RESTJSONErrorCodes } = require("discord.js");
const { getMonthEvents, hashEvents } = require("./calendar");
const { buildCalendarEmbed, buildCalendarButtons, buildStatusEmbed, buildActionButtons } = require("./embed");
const { loadState, saveState } = require("./storage");
const { checkAndFireNotices, sweepPendingDeletes } = require("./notifier");
const { getLang } = require("./i18n");
const { currentYM } = require("./runtime");

// state.json を失ったときに備え、直近この件数のメッセージから自分の投稿を探して引き継ぐ
const ADOPT_SCAN_LIMIT = 50;

// Bot が常設で管理するメッセージ。
// marker      : 種類を見分けるためのボタン customId（通常はこれで判別する）
// matchEmbed  : v8.3.0 以前の停止処理でボタンを剥がされた残骸を拾うための予備判定。
//               ログ通知・予定通知の Embed を巻き込まないよう footer なしを条件に含める
const MANAGED_MESSAGES = {
  calendar: {
    stateKey: "calendarMessageId",
    marker: "btn_refresh",
    label: "Cal",
    matchEmbed: (e) => !e.footer && /^📅\s+(\d{4}年|[A-Z][a-z]{2}\s+\d{4})/.test(e.title || ""),
  },
  status: {
    stateKey: "statusMessageId",
    marker: "btn_add",
    label: "Status",
    matchEmbed: (e) => !e.footer && !e.title
      && (e.description || "").includes("🔐") && (e.description || "").includes("🔃"),
  },
};

function describeDiscordError(err) {
  const code = err?.code ?? err?.status ?? "n/a";
  return `${err?.message || "unknown error"} (code=${code})`;
}

/**
 * Discord 上からメッセージが本当に消えている場合だけ true を返す。
 * レート制限・5xx・ネットワーク断などの一時障害で作り直すと投稿が増え続けるため、
 * 「作り直してよい」条件はこの 1 つに限定する。
 */
function isMessageGone(err) {
  return err?.code === RESTJSONErrorCodes.UnknownMessage;
}

function hasMarker(message, marker) {
  return (message.components || []).some(row =>
    (row.components || []).some(component => component.customId === marker));
}

/**
 * このメッセージが該当種別の管理対象かどうか。
 * 通常はボタンの customId（marker）で判別するが、v8.3.0 より前の停止処理は
 * ボタンを丸ごと削除していたため、その残骸は matchEmbed（Embed の内容）で拾う。
 */
function matchesManaged(message, descriptor) {
  if (hasMarker(message, descriptor.marker)) return true;
  const embed = message.embeds?.[0];
  return Boolean(embed && descriptor.matchEmbed?.(embed));
}

function createScheduler({ client, getAllGuildIds, loadConfig, config = {} }) {
  const guildRunning = new Map();
  const cronSchedule = config.cronSchedule || process.env.CRON_SCHEDULE || "*/5 * * * *";

  function summarizeRunError(err, calendarId) {
    const code = err?.code || err?.status || err?.response?.status;
    const reason = err?.errors?.[0]?.reason || err?.response?.data?.error?.errors?.[0]?.reason;
    const message = err?.errors?.[0]?.message || err?.message || "unknown error";
    if (code === 404 && reason === "notFound") {
      return `Google Calendar not found or not shared (calendarId: ${calendarId}). Check calendar_id and service-account sharing.`;
    }
    return `${message} (code=${code ?? "n/a"}${reason ? `, reason=${reason}` : ""})`;
  }

  /** チャンネル内から、Bot 自身が投稿した該当種別のメッセージを新しい順に返す */
  async function findManagedMessages(channel, descriptor) {
    try {
      const recent = await channel.messages.fetch({ limit: ADOPT_SCAN_LIMIT });
      return [...recent.values()].filter(m => m.author?.id === client.user?.id && matchesManaged(m, descriptor));
    } catch {
      return [];
    }
  }

  /**
   * 常設メッセージを更新する。Discord 上から消えている場合のみ作り直す。
   * state を失っていても、チャンネルに残っている自分の投稿を引き継いで重複投稿を防ぐ。
   */
  async function upsertManagedMessage(kind, guildId, channel, payload) {
    const descriptor = MANAGED_MESSAGES[kind];
    const { stateKey, label } = descriptor;
    const trackedId = loadState(guildId)[stateKey];

    if (trackedId) {
      try {
        const msg = await channel.messages.fetch(trackedId);
        await msg.edit(payload);
        return msg;
      } catch (err) {
        if (!isMessageGone(err)) {
          console.error(`[${label}][${guildId}] 更新失敗のためスキップ（再投稿しない）: ${describeDiscordError(err)}`);
          return null;
        }
        console.warn(`[${label}][${guildId}] メッセージが存在しないため作り直します`);
      }
    }

    for (const candidate of await findManagedMessages(channel, descriptor)) {
      try {
        await candidate.edit(payload);
        saveState(guildId, { [stateKey]: candidate.id });
        console.log(`[${label}][${guildId}] 既存メッセージを引き継ぎ: ${candidate.id}`);
        return candidate;
      } catch (err) {
        if (!isMessageGone(err)) {
          console.error(`[${label}][${guildId}] 既存メッセージの引き継ぎに失敗: ${describeDiscordError(err)}`);
          return null;
        }
      }
    }

    const sent = await channel.send(payload);
    saveState(guildId, { [stateKey]: sent.id });
    console.log(`[${label}][${guildId}] 新規投稿: ${sent.id}`);
    return sent;
  }

  async function upsertCalendarMessage(guildId, guildConfig, events, year, month) {
    const lang = getLang(guildConfig);
    const channel = await client.channels.fetch(guildConfig.channelId);
    await upsertManagedMessage("calendar", guildId, channel, {
      embeds: [buildCalendarEmbed(guildId, events, year, month, lang)],
      components: [buildCalendarButtons(year, month, lang)],
    });
  }

  async function upsertStatusMessage(guildId, guildConfig, events, upcomingSource = events) {
    const lang = getLang(guildConfig);
    const channel = await client.channels.fetch(guildConfig.channelId);
    const state   = loadState(guildId);
    await upsertManagedMessage("status", guildId, channel, {
      embeds: [buildStatusEmbed(guildId, events, state.updatedAt, guildConfig.operatorRoleName, true, lang, upcomingSource)],
      components: [buildActionButtons(lang)],
    });
  }

  /** 過去に重複投稿されてしまった常設メッセージを片付ける（現行のものは残す） */
  async function cleanupDuplicateMessages(guildId, guildConfig) {
    const channel = await client.channels.fetch(guildConfig.channelId).catch(() => null);
    if (!channel) return;
    const state = loadState(guildId);
    for (const descriptor of Object.values(MANAGED_MESSAGES)) {
      const { stateKey, label } = descriptor;
      const keepId = state[stateKey];
      if (!keepId) continue;
      for (const msg of await findManagedMessages(channel, descriptor)) {
        if (msg.id === keepId) continue;
        try {
          await msg.delete();
          console.log(`[${label}][${guildId}] 重複メッセージを削除: ${msg.id}`);
        } catch (err) {
          console.warn(`[${label}][${guildId}] 重複メッセージの削除に失敗: ${describeDiscordError(err)}`);
        }
      }
    }
  }

  async function updateBoth(guildId, guildConfig, events, year, month, upcomingSource = events) {
    await upsertCalendarMessage(guildId, guildConfig, events, year, month);
    await upsertStatusMessage(guildId, guildConfig, events, upcomingSource);
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
      const next    = month === 12 ? { year: year + 1, month: 1 } : { year, month: month + 1 };
      const events  = await getMonthEvents(guildConfig.calendarId, year, month);
      // 月末に「直近の予定」が消えないよう翌月分も見る。通知判定にも使い回す
      const nextEvents = await getMonthEvents(guildConfig.calendarId, next.year, next.month).catch(() => []);
      const horizon = [...events, ...nextEvents];
      const newHash = hashEvents(events);
      const state   = loadState(guildId);
      const syncedAt = new Date().toISOString();
      if (isFirst || !state.lastHash || force || state.lastHash !== newHash) {
        // Save latest sync timestamp first so status embed always shows the current run time.
        saveState(guildId, { lastHash: newHash, updatedAt: syncedAt });
        await updateBoth(guildId, guildConfig, events, year, month, horizon);
      } else {
        // Even when no event diff exists, keep the "last sync" timestamp fresh.
        saveState(guildId, { updatedAt: syncedAt });
        await upsertStatusMessage(guildId, guildConfig, events, horizon);
      }
      if (isFirst) await cleanupDuplicateMessages(guildId, guildConfig).catch(() => {});
      await checkAndFireNotices(client, guildId, guildConfig, horizon);
    } catch (err) {
      const syncedAt = new Date().toISOString();
      saveState(guildId, { updatedAt: syncedAt });
      // Keep status embed fresh even if calendar fetch fails, so operators can notice current bot state/version.
      await upsertStatusMessage(guildId, guildConfig, []).catch((statusErr) => {
        console.error(`[Run][${guildId}] Status update failed: ${statusErr.message}`);
      });
      console.error(`[Run][${guildId}] ${summarizeRunError(err, guildConfig.calendarId)}`);
    } finally {
      // 再起動を挟んでも消えないよう、通知の自動削除は永続キューから掃除する
      await sweepPendingDeletes(client, guildId).catch(() => {});
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
    cleanupDuplicateMessages,
    startCron,
  };
}

module.exports = { createScheduler };
