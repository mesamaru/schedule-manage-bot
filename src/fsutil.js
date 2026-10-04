/**
 * fsutil.js
 * JSON ファイルの安全な読み書き。
 * writeFileSync で直接上書きすると、書き込み途中で落ちたときにファイルが壊れ、
 * 次回起動時に設定・通知・メッセージIDがすべて消える（＝重複投稿の原因にもなる）。
 * 一時ファイルに書いてから rename することで、常に「古い内容」か「新しい内容」のどちらかが残るようにする。
 */
const fs   = require("fs");
const path = require("path");

function readJson(file, fallback = {}) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch (err) {
    console.error(`[fs] JSON 読み込み失敗: ${file}: ${err.message}`);
    return fallback;
  }
}

function writeJsonAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
  fs.renameSync(tmp, file);
}

module.exports = { readJson, writeJsonAtomic };
