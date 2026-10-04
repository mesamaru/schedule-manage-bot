/**
 * idRegistry.js
 * Google の予定 ID を customId / 選択肢の value に埋め込むための短縮 ID。
 * Discord の customId・value は 100 文字までだが、外部から取り込んだ予定（iCal 由来など）は
 * ID が非常に長いことがあり、そのまま埋め込むとメッセージ送信自体が失敗する。
 * 40 文字以下はそのまま使い（既存ボタンとの互換）、それより長いものだけ短縮して対応表を保持する。
 * 対応表はメモリ上のみ。エフェメラルな操作 UI は 15 分で失効するので再起動を跨ぐ必要はない。
 */
const crypto = require("crypto");

const MAX_RAW_LENGTH = 40;
const map = new Map();

function toKey(eventId) {
  const id = String(eventId);
  if (id.length <= MAX_RAW_LENGTH && !id.startsWith("~")) return id;
  const key = "~" + crypto.createHash("sha1").update(id).digest("base64url").slice(0, 16);
  map.set(key, id);
  return key;
}

function fromKey(key) {
  if (!key?.startsWith("~")) return key;
  return map.get(key) || null;
}

module.exports = { toKey, fromKey };
