/**
 * guildConfig.js
 * per-guild 設定の読み書き
 * 保存先: data/{guildId}/config.json
 *
 * config 構造:
 * {
 *   channelId:        string   カレンダー投稿チャンネル
 *   calendarId:       string   Google Calendar ID
 *   notifyChannelId:  string|null  通知チャンネル（null → channelId と同じ）
 *   logChannelId:     string|null  ログチャンネル（null → ログなし）
 *   logEnabled:       boolean  ログ通知ON/OFF（省略時はON扱い）
 *   language:         "ja"|"en"  Bot表示言語（省略時はja）
 *   operatorRoleName: string   操作ロール名
 * }
 */
const fs   = require("fs");
const path = require("path");
const { readJson, writeJsonAtomic } = require("./fsutil");

const DATA = path.join(__dirname, "../data");

function configPath(guildId) {
  return path.join(DATA, String(guildId), "config.json");
}

/** @returns {object|null} */
function loadConfig(guildId) {
  if (!guildId) return null;
  const cfg = readJson(configPath(guildId), null);
  return cfg && typeof cfg === "object" && cfg.channelId && cfg.calendarId ? cfg : null;
}

function saveConfig(guildId, data) {
  writeJsonAtomic(configPath(guildId), data);
}

function deleteConfig(guildId) {
  try {
    fs.rmSync(path.join(DATA, String(guildId)), { recursive: true, force: true });
  } catch {}
}

/** config.json が存在するギルドIDの一覧 */
function getAllGuildIds() {
  try {
    if (!fs.existsSync(DATA)) return [];
    return fs.readdirSync(DATA).filter(f => /^\d+$/.test(f) && fs.existsSync(configPath(f)));
  } catch { return []; }
}

module.exports = { loadConfig, saveConfig, deleteConfig, getAllGuildIds };
