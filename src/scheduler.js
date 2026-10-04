const { RESTJSONErrorCodes } = require("discord.js");
const { getMonthEvents, hashString } = require("./calendar");
const { buildCalendarEmbed, buildCalendarButtons, buildStatusEmbed, buildActionButtons } = require("./embed");
const { loadState, saveState } = require("./storage");
const { checkAndFireNotices, sweepPendingDeletes } = require("./notifier");
const { getLang } = require("./i18n");
const { currentYM, INSTANCE_ID, fmtTimestamp, sendSystemLog } = require("./runtime");

// state.json を失ったときに備え、直近この件数のメッセージから自分の投稿を探して引き継ぐ
const ADOPT_SCAN_LIMIT = 50;
// 別プロセス検出の警告をログチャンネルへ送る間隔
const DUPLICATE_WARN_INTERVAL_MS = 60 * 60 * 1000;

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

function matchesManaged(message, descriptor) {
  if (hasMarker(message, descriptor.marker)) return true;
  const embed = message.embeds?.[0];
  return Boolean(embed && descriptor.matchEmbed?.(embed));
}

/** Embed の見た目が変わったかを判定するためのハッシュ（タイムスタンプは除外） */
function hashPayload(payload) {
  const json = JSON.stringify({
    embeds: (payload.embeds || []).map(e => { const j = e.toJSON ? e.toJSON() : e; const { timestamp, ...rest } = j; return rest; }),
    components: (payload.components || []).map(c => (c.toJSON ? c.toJSON() : c)),
  });
  return hashString(json);
}

function summarizeRunError(err, calendarId) {
  const code = err?.code || err?.status || err?.response?.status;
  const reason = err?.errors?.[0]?.reason || err?.response?.data?.error?.errors?.[0]?.reason;
  const message = err?.errors?.[0]?.message || err?.message || "unknown error";
  if (code === 404 && reason === "notFound") {
    return `Google Calendar not found or not shared (calendarId: ${calendarId}). Check calendar_id and service-account sharing.`;
  }
  return `${message} (code=${code ?? "n/a"}${reason ? `, reason=${reason}` : ""})`;
}

function createScheduler({ client, getAllGuildIds, loadConfig, config = {} }) {
  const cronSchedule = config.cronSchedule || process.env.CRON_SCHEDULE || "*/5 * * * *";

  // ── ギルド単位の排他制御 ──────────────────────────────
  // 以前は cron の実行中フラグを見るだけで、ボタン・モーダル・起動時の処理は素通りしていた。
  // 同時に走ると両方が「メッセージがない」と判断して二重投稿したり、
  // state.json / notices.json を読み書きで上書きし合ったりする。
  // ここでは Promise をつないで、同じギルドの同期処理を必ず 1 本ずつ実行する。
  const guildQueues = new Map();
  const guildBusy   = new Set();

  function withGuildLock(guildId, fn) {
    const prev = guildQueues.get(guildId) || Promise.resolve();
    const next = prev.catch(() => {}).then(async () => {
      guildBusy.add(guildId);
      try { return await fn(); } finally { guildBusy.delete(guildId); }
    });
    const tail = next.catch(() => {});
    guildQueues.set(guildId, tail);
    tail.then(() => { if (guildQueues.get(guildId) === tail) guildQueues.delete(guildId); });
    return next;
  }

  // ── 別プロセス検出 ───────────────────────────────────
  // このプロセスが一度でも更新したステータスメッセージに、別の INSTANCE_ID が書かれていたら
  // 同じトークンで別の場所（Fly.io と Pterodactyl など）が同時に動いている。
  // その状態だとボタン押下が両方に届き、片方が「Unknown interaction」で失敗する。
  const editedStatusOnce = new Set();
  const lastDuplicateWarn = new Map();

  function detectOtherInstance(guildId, message, guildConfig) {
    const desc = message?.embeds?.[0]?.description || "";
    const m = desc.match(/v[\d.]+`\s+·\s+`([^`]+)`/);
    if (!m || m[1] === INSTANCE_ID || !editedStatusOnce.has(guildId)) return;
    const other = m[1];
    console.error(`[Duplicate][${guildId}] 別プロセス（${other}）が同じ Bot トークンで稼働しています。このプロセス: ${INSTANCE_ID}`);
    const last = lastDuplicateWarn.get(guildId) || 0;
    if (Date.now() - last < DUPLICATE_WARN_INTERVAL_MS) return;
    lastDuplicateWarn.set(guildId, Date.now());
    sendSystemLog(client, 0xed4245, "duplicate", { other, self: INSTANCE_ID, ts: fmtTimestamp() }, "error",
      () => [guildId], () => guildConfig).catch(() => {});
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

  async function fetchChannel(channelId) {
    const channel = await client.channels.fetch(channelId);
    if (!channel?.isTextBased?.()) throw new Error(`チャンネルにアクセスできません（channelId: ${channelId}）`);
    return channel;
  }

  /**
   * 常設メッセージを更新する。Discord 上から消えている場合のみ作り直す。
   * state を失っていても、チャンネルに残っている自分の投稿を引き継いで重複投稿を防ぐ。
   * ※ 必ず withGuildLock の中から呼ぶこと
   */
  async function upsertManagedMessage(kind, guildId, channel, payload, { onFetched } = {}) {
    const descriptor = MANAGED_MESSAGES[kind];
    const { stateKey, label } = descriptor;
    const trackedId = loadState(guildId)[stateKey];

    if (trackedId) {
      try {
        const msg = await channel.messages.fetch({ message: trackedId, force: true });
        onFetched?.(msg);
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

  async function upsertCalendarMessage(guildId, guildConfig, events, year, month, { force = false } = {}) {
    const lang = getLang(guildConfig);
    const payload = {
      embeds: [buildCalendarEmbed(guildId, events, year, month, lang)],
      components: [buildCalendarButtons(year, month, lang)],
    };
    // 予定・通知設定・言語・「今日」マーク・月のいずれかが変われば見た目が変わる。
    // 以前は予定の更新日時だけをハッシュしていたため、月替わり（両月とも予定なし）や
    // 通知設定の変更、/language の変更がカレンダーに反映されなかった。
    const renderHash = hashPayload(payload);
    const state = loadState(guildId);
    if (!force && state.calendarMessageId && state.calendarRenderHash === renderHash) return;
    const channel = await fetchChannel(guildConfig.channelId);
    const msg = await upsertManagedMessage("calendar", guildId, channel, payload);
    if (msg) saveState(guildId, { calendarRenderHash: renderHash });
  }

  async function upsertStatusMessage(guildId, guildConfig, { events = [], upcomingSource = events, syncError = null } = {}) {
    const lang    = getLang(guildConfig);
    const channel = await fetchChannel(guildConfig.channelId);
    const state   = loadState(guildId);
    const msg = await upsertManagedMessage("status", guildId, channel, {
      embeds: [buildStatusEmbed(guildId, {
        events, upcomingSource, lastUpdated: state.updatedAt, operatorRoleName: guildConfig.operatorRoleName,
        online: true, lang, syncError, instanceId: INSTANCE_ID,
      })],
      components: [buildActionButtons(lang)],
    }, { onFetched: (m) => detectOtherInstance(guildId, m, guildConfig) });
    if (msg) editedStatusOnce.add(guildId);
  }

  /** 過去に重複投稿されてしまった常設メッセージを片付ける（現行のものは残す） */
  async function cleanupDuplicateMessages(guildId, guildConfig) {
    const channel = await client.channels.fetch(guildConfig.channelId).catch(() => null);
    if (!channel?.isTextBased?.()) return;
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

  /**
   * 1 ギルド分の同期本体（ロック内で実行される）。
   * 今月＋来月の予定を取得し、カレンダー・ステータスを更新し、通知を送る。
   */
  async function doSync(guildId, guildConfig, { isFirst = false, force = false, notify = true } = {}) {
    const ts = new Date().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" });
    console.log(`[${ts}][${guildId}] チェック開始${isFirst ? "（起動時）" : ""}`);
    try {
      const { year, month } = currentYM();
      const next = month === 12 ? { year: year + 1, month: 1 } : { year, month: month + 1 };
      const [events, nextEvents] = await Promise.all([
        getMonthEvents(guildConfig.calendarId, year, month),
        // 月末に「直近の予定」が消えないよう翌月分も見る。通知判定にも使い回す
        getMonthEvents(guildConfig.calendarId, next.year, next.month).catch((err) => {
          console.warn(`[Run][${guildId}] 翌月分の取得に失敗: ${err.message}`);
          return [];
        }),
      ]);
      const seen = new Set(events.map(e => e.id));
      const horizon = [...events, ...nextEvents.filter(e => !seen.has(e.id))];

      saveState(guildId, { updatedAt: new Date().toISOString(), lastError: null });
      await upsertCalendarMessage(guildId, guildConfig, events, year, month, { force: isFirst || force });
      await upsertStatusMessage(guildId, guildConfig, { events, upcomingSource: horizon });
      if (isFirst) await cleanupDuplicateMessages(guildId, guildConfig).catch(() => {});
      if (notify) await checkAndFireNotices(client, guildId, guildConfig, horizon);
    } catch (err) {
      const summary = summarizeRunError(err, guildConfig.calendarId);
      console.error(`[Run][${guildId}] ${summary}`);
      // 「最終同期」は成功時刻のまま残し、エラーを別行で表示する
      saveState(guildId, { lastError: summary, lastErrorAt: new Date().toISOString() });
      await upsertStatusMessage(guildId, guildConfig, { syncError: summary }).catch((statusErr) => {
        console.error(`[Run][${guildId}] Status update failed: ${statusErr.message}`);
      });
      throw err;
    } finally {
      // 再起動を挟んでも消えないよう、通知の自動削除は永続キューから掃除する
      await sweepPendingDeletes(client, guildId).catch(() => {});
    }
  }

  /**
   * 同期を実行する（ボタン・モーダル・コマンドからはこれを呼ぶ）。
   * 実行中の同期があれば終わるのを待ってから実行する。
   */
  function sync(guildId, guildConfig, options = {}) {
    return withGuildLock(guildId, () => doSync(guildId, guildConfig, options));
  }

  /** cron 用。前回の同期がまだ終わっていなければスキップする */
  async function run(guildId, guildConfig, isFirst = false, force = false) {
    if (!isFirst && (guildBusy.has(guildId) || guildQueues.has(guildId))) {
      console.warn(`[Cron][${guildId}] 前回の同期が実行中のためスキップ`);
      return;
    }
    return sync(guildId, guildConfig, { isFirst, force });
  }

  let cronTask = null;
  function startCron() {
    if (cronTask) return;
    const cron = require("node-cron");
    if (!cron.validate(cronSchedule)) {
      console.error(`[Cron] CRON_SCHEDULE が不正です: "${cronSchedule}"。既定値 */5 * * * * を使います`);
    }
    cronTask = cron.schedule(cron.validate(cronSchedule) ? cronSchedule : "*/5 * * * *", async () => {
      if (!client.isReady()) return;
      for (const gid of getAllGuildIds()) {
        const cfg = loadConfig(gid);
        if (cfg) run(gid, cfg, false).catch(() => {});
      }
    }, { timezone: "Asia/Tokyo" });
    console.log(`[Cron] 登録完了: "${cronSchedule}"`);
  }

  function stopCron() {
    cronTask?.stop();
    cronTask = null;
  }

  return {
    cronSchedule,
    run,
    sync,
    withGuildLock,
    upsertCalendarMessage,
    upsertStatusMessage,
    cleanupDuplicateMessages,
    startCron,
    stopCron,
  };
}

module.exports = { createScheduler };
