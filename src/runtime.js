const os = require("os");
const crypto = require("crypto");
const { EmbedBuilder, PermissionFlagsBits, RESTJSONErrorCodes } = require("discord.js");
const { getLang, pick } = require("./i18n");

// このプロセスを識別する ID。ステータスに表示し、同じ Bot トークンで別の場所
// （例: Fly.io と Pterodactyl）が同時に動いていないかの検出にも使う
const INSTANCE_ID = `${os.hostname().slice(0, 12)}/${crypto.randomBytes(2).toString("hex")}`;

function getAndIncrementStartupCount(fs, path) {
  const dir  = path.join(__dirname, "../data");
  const file = path.join(dir, ".startup_count");
  let count  = 0;
  try {
    if (fs.existsSync(file)) count = parseInt(fs.readFileSync(file, "utf8").trim()) || 0;
    count++;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, String(count), "utf8");
  } catch {}
  return count;
}

function fmtTimestamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}/${p(d.getMonth()+1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function currentYM() {
  const now = new Date();
  return { year: now.getFullYear(), month: now.getMonth() + 1 };
}

/**
 * 操作権限の判定。interaction を受け取る。
 * ギルドがキャッシュに無いと interaction.member は生データ（roles が ID 配列）になり、
 * 以前の実装（member.permissions.has / member.roles.cache）は例外で落ちていた。
 */
function hasPermission(interaction, operatorRoleName) {
  if (!interaction?.inGuild?.()) return false;
  if (interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) return true;
  const roleName = operatorRoleName || "CalendarOperator";
  const member = interaction.member;
  const roleIds = Array.isArray(member?.roles) ? member.roles : [...(member?.roles?.cache?.keys() || [])];
  return roleIds.some(id => interaction.guild?.roles.cache.get(id)?.name === roleName);
}

function normalizeTime(str) {
  return require("./calendar").normalizeTime(str);
}

function isLogNotifyEnabled(cfg) {
  return Boolean(cfg?.logChannelId) && cfg.logEnabled !== false;
}

function normalizeSystemLogToggles(cfg) {
  return {
    startup: cfg?.systemLogToggles?.startup !== false,
    connection: cfg?.systemLogToggles?.connection !== false,
    error: cfg?.systemLogToggles?.error !== false,
  };
}

function isSystemLogEnabled(cfg, category) {
  if (!isLogNotifyEnabled(cfg)) return false;
  const toggles = normalizeSystemLogToggles(cfg);
  return toggles[category] !== false;
}

/**
 * 「n秒後に消えます」表示。以前は 1 秒ごとに editReply してカウントダウンしていたが、
 * 操作 1 回で 5〜8 回の API 呼び出しになり、レート制限で他の応答が遅れる原因になっていた。
 * Discord の相対タイムスタンプ（<t:…:R>）ならクライアント側で勝手にカウントダウンされる。
 */
function fmtCd(content, n, lang = "ja") {
  const at = Math.floor(Date.now() / 1000) + n;
  return `${content}\n-# ${lang === "en" ? `Deletes <t:${at}:R>` : `<t:${at}:R>に消えます`}`;
}

function startCountdownDelete(interaction, _content, seconds = 5) {
  setTimeout(() => interaction.deleteReply().catch(() => {}), seconds * 1000);
}

// ── Discord エラー判定 ──────────────────────────────────
/**
 * インタラクションに応答できなくなった（3 秒の応答期限切れ／別プロセスが先に応答済み）ことを示すエラーか。
 * 10062 Unknown interaction / 40060 Interaction has already been acknowledged
 */
function isInteractionGone(err) {
  return err?.code === RESTJSONErrorCodes.UnknownInteraction
    || err?.code === RESTJSONErrorCodes.InteractionHasAlreadyBeenAcknowledged;
}

async function sendAuditLog(client, action, interaction, { title, dateStr, timeStr, desc }, config) {
  if (!isLogNotifyEnabled(config)) return;
  try {
    const lang = getLang(config);
    const ch = await client.channels.fetch(config.logChannelId).catch(() => null);
    if (!ch?.isTextBased?.()) return;
    const colorMap = { "追加": 0x57f287, "変更": 0xfee75c, "削除": 0xed4245 };
    const iconMap  = { "追加": "📅", "変更": "✏️", "削除": "🗑️" };
    const actionEn = { "追加": "Added", "変更": "Updated", "削除": "Deleted" };
    const memberName = interaction.member?.displayName || interaction.user.globalName || interaction.user.username;
    let body = `**${title}**\n📅 ${dateStr}\u3000\`${timeStr}\``;
    if (desc) body += `\n📝 ${desc}`;
    const embed = new EmbedBuilder()
      .setColor(colorMap[action] ?? 0x5865f2)
      .setTitle(lang === "en" ? `${iconMap[action]} Event ${actionEn[action] || action}` : `${iconMap[action]} 予定${action}`)
      .setDescription(body)
      .setFooter({ text: `${memberName} (@${interaction.user.username})`, iconURL: interaction.user.displayAvatarURL() })
      .setTimestamp();
    await ch.send({ embeds: [embed] });
  } catch (e) {
    console.error("[AuditLog] 送信失敗:", e.message);
  }
}

function buildSystemLogMessage(kind, payload, lang) {
  switch (kind) {
    case "startup":
      return {
        title: payload.startupCount > 1
          ? (lang === "en" ? `🔄 Bot Restart (#${payload.startupCount})` : `🔄 Bot 再起動 (#${payload.startupCount})`)
          : (lang === "en" ? "✅ Bot Started" : "✅ Bot 起動"),
        description: lang === "en"
          ? `Login: **${payload.clientTag}**\nStarted at: ${payload.ts}\nPID: ${payload.pid}`
          : `ログイン: **${payload.clientTag}**\n起動時刻: ${payload.ts}\nPID: ${payload.pid}`,
      };
    case "disconnect":
      return {
        title: lang === "en" ? "⚠️ Discord Disconnected" : "⚠️ Discord 接続切断",
        description: lang === "en"
          ? `shard: ${payload.shardId} | code: ${payload.code}\nTime: ${payload.ts}`
          : `shard: ${payload.shardId} | code: ${payload.code}\n時刻: ${payload.ts}`,
      };
    case "reconnecting":
      return {
        title: lang === "en" ? "🔄 Discord Reconnecting..." : "🔄 Discord 再接続中…",
        description: lang === "en"
          ? `shard: ${payload.shardId}\nTime: ${payload.ts}`
          : `shard: ${payload.shardId}\n時刻: ${payload.ts}`,
      };
    case "resume":
      return {
        title: lang === "en" ? "✅ Discord Connection Resumed" : "✅ Discord 接続再開",
        description: lang === "en"
          ? `shard: ${payload.shardId} | replayed: ${payload.replayed}\nTime: ${payload.ts}`
          : `shard: ${payload.shardId} | replayed: ${payload.replayed}\n時刻: ${payload.ts}`,
      };
    case "error":
      return {
        title: lang === "en" ? "❌ Discord Error" : "❌ Discord エラー",
        description: lang === "en" ? `${payload.message}\nTime: ${payload.ts}` : `${payload.message}\n時刻: ${payload.ts}`,
      };
    case "duplicate":
      return {
        title: lang === "en" ? "⚠️ Another bot instance detected" : "⚠️ 別の Bot プロセスを検出",
        description: lang === "en"
          ? `The status message was updated by another process (\`${payload.other}\`) running with the same bot token.\nThis process: \`${payload.self}\`\nStop one of them (e.g. Fly.io or Pterodactyl). Otherwise buttons fail with "Unknown interaction".\nTime: ${payload.ts}`
          : `同じ Bot トークンで動いている別プロセス（\`${payload.other}\`）がステータスを更新しています。\nこのプロセス: \`${payload.self}\`\nどちらか一方（例: Fly.io か Pterodactyl）を停止してください。放置するとボタン操作が「Unknown interaction」で失敗します。\n時刻: ${payload.ts}`,
      };
    case "shutdown":
      return {
        title: lang === "en" ? "🛑 Bot Stopping" : "🛑 Bot 停止",
        description: lang === "en"
          ? `Signal: ${payload.signal}\nTime: ${payload.ts}`
          : `シグナル: ${payload.signal}\n時刻: ${payload.ts}`,
      };
    default:
      return { title: "Bot", description: "" };
  }
}

async function sendSystemLog(client, color, kind, payload, category, getAllGuildIds, loadConfig) {
  // 起動直後（ready 前）はギルドがキャッシュされておらず、channels.fetch が null を返す。
  // 以前はそのまま ch.send して「Cannot read properties of null (reading 'send')」になっていた
  if (!client.isReady()) return;
  for (const gid of getAllGuildIds()) {
    const cfg = loadConfig(gid);
    if (!isSystemLogEnabled(cfg, category)) continue;
    try {
      const lang = getLang(cfg);
      const msg  = buildSystemLogMessage(kind, payload, lang);
      const ch = await client.channels.fetch(cfg.logChannelId).catch(() => null);
      if (!ch?.isTextBased?.()) {
        console.warn(`[SystemLog][${gid}] ログチャンネルにアクセスできません: ${cfg.logChannelId}`);
        continue;
      }
      await ch.send({
        embeds: [new EmbedBuilder().setColor(color).setTitle(msg.title).setDescription(msg.description).setTimestamp()]
      });
    } catch (e) {
      console.error(`[SystemLog][${gid}] 送信失敗: ${e.message}`);
    }
  }
}

function formatEventLocal(event, lang = "ja") {
  return require("./calendar").formatEvent(event, lang);
}

module.exports = {
  INSTANCE_ID,
  isInteractionGone,
  getAndIncrementStartupCount,
  fmtTimestamp,
  currentYM,
  hasPermission,
  normalizeTime,
  isLogNotifyEnabled,
  normalizeSystemLogToggles,
  isSystemLogEnabled,
  fmtCd,
  startCountdownDelete,
  sendAuditLog,
  sendSystemLog,
  formatEventLocal,
  getLang,
  pick,
};
