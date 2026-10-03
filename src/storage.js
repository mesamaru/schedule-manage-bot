/**
 * storage.js
 * per-guild データストレージ
 * data/{guildId}/state.json   : Bot状態（メッセージID・ハッシュ等）
 * data/{guildId}/notices.json : 通知設定（eventId → [{roleId, minutesBefore, targetType?, firedAt?, firedFor?}]）
 */
const path = require("path");
const { readJson, writeJsonAtomic } = require("./fsutil");

const DATA = path.join(__dirname, "../data");

function filePath(guildId, file) {
  return path.join(DATA, String(guildId), file);
}

function read(guildId, file) {
  const data = readJson(filePath(guildId, file), {});
  return data && typeof data === "object" && !Array.isArray(data) ? data : {};
}

function write(guildId, file, data) {
  writeJsonAtomic(filePath(guildId, file), data);
}

// ── state ──────────────────────────────────────────────
function loadState(guildId) { return read(guildId, "state.json"); }

/**
 * state を部分更新する。updatedAt（＝「最終同期」表示）は明示的に渡したときだけ変わる。
 * 以前は渡さないと現在時刻で上書きしていたため、通知キューの更新などでも「最終同期」が進んでいた。
 */
function saveState(guildId, partial = {}) {
  write(guildId, "state.json", { ...loadState(guildId), ...partial });
}

// ── 予約削除キュー ─────────────────────────────────────
// 通知メッセージの自動削除は setTimeout だと再起動で失われるため state に永続化する
// 構造: state.pendingDeletes = [ { channelId, messageId, deleteAt, attempts? } ]
function addPendingDelete(guildId, entry) {
  const state = loadState(guildId);
  const queue = Array.isArray(state.pendingDeletes) ? state.pendingDeletes : [];
  queue.push(entry);
  saveState(guildId, { pendingDeletes: queue });
}

/** 削除予定時刻を過ぎた項目をキューから取り出す（取り出した分はキューから消える） */
function takeDuePendingDeletes(guildId, nowMs = Date.now()) {
  const state = loadState(guildId);
  const queue = Array.isArray(state.pendingDeletes) ? state.pendingDeletes : [];
  if (queue.length === 0) return [];
  const due     = queue.filter(e => e.deleteAt <= nowMs);
  const pending = queue.filter(e => e.deleteAt > nowMs);
  if (due.length > 0) saveState(guildId, { pendingDeletes: pending });
  return due;
}

// ── notices ────────────────────────────────────────────
function loadNotices(guildId)       { return read(guildId, "notices.json"); }
function saveNotices(guildId, data) { write(guildId, "notices.json", data); }

function sameTarget(a, b) {
  return a.roleId === b.roleId
    && a.minutesBefore === b.minutesBefore
    && (a.targetType || "role") === (b.targetType || "role");
}

function getNoticesForEvent(guildId, eventId) {
  return loadNotices(guildId)[eventId] || [];
}

function setNoticesForEvent(guildId, eventId, notices) {
  const all = loadNotices(guildId);
  if (!notices || notices.length === 0) delete all[eventId];
  else all[eventId] = notices;
  saveNotices(guildId, all);
}

/** 通知を 1 件追加する。同じ宛先・同じタイミングが既にあれば追加しない（二重メンション防止） */
function addNotice(guildId, eventId, entry) {
  const all = loadNotices(guildId);
  const list = all[eventId] || [];
  if (list.some(n => sameTarget(n, entry))) return false;
  list.push(entry);
  all[eventId] = list;
  saveNotices(guildId, all);
  return true;
}

function deleteNoticesForEvent(guildId, eventId) {
  const all = loadNotices(guildId);
  if (!(eventId in all)) return;
  delete all[eventId];
  saveNotices(guildId, all);
}

/**
 * 送信済みにする。インデックスではなく宛先＋タイミングで照合する
 * （送信中に UI から通知が削除されてもズレて別の通知に印が付かないように）。
 * firedFor には「どの開始時刻に対して送ったか」を残し、Google カレンダー側で
 * 予定が移動された場合に再通知できるようにする。
 */
function markNoticesFired(guildId, eventId, entries, firedFor) {
  const all = loadNotices(guildId);
  const list = all[eventId];
  if (!list) return;
  const firedAt = new Date().toISOString();
  for (const n of list) {
    if (entries.some(e => sameTarget(e, n))) {
      n.firedAt  = firedAt;
      n.firedFor = firedFor;
    }
  }
  saveNotices(guildId, all);
}

function resetFiredForEvent(guildId, eventId) {
  const all = loadNotices(guildId);
  if (!all[eventId]) return;
  all[eventId] = all[eventId].map(n => {
    const copy = { roleId: n.roleId, minutesBefore: n.minutesBefore };
    if (n.targetType) copy.targetType = n.targetType;
    return copy;
  });
  saveNotices(guildId, all);
}

function deleteNoticeEntry(guildId, eventId, index) {
  const all = loadNotices(guildId);
  if (!all[eventId] || !all[eventId][index]) return;
  all[eventId].splice(index, 1);
  if (all[eventId].length === 0) delete all[eventId];
  saveNotices(guildId, all);
}

module.exports = {
  loadState, saveState,
  addPendingDelete, takeDuePendingDeletes,
  loadNotices, getNoticesForEvent, setNoticesForEvent, addNotice,
  deleteNoticesForEvent, markNoticesFired,
  resetFiredForEvent, deleteNoticeEntry,
};
