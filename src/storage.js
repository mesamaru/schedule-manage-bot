/**
 * storage.js v5
 * per-guild データストレージ
 * data/{guildId}/state.json   : Bot状態（メッセージID・ハッシュ等）
 * data/{guildId}/notices.json : 通知設定（eventId → [{roleId, minutesBefore, firedAt?}]）
 */
const fs   = require("fs");
const path = require("path");

const DATA = path.join(__dirname, "../data");

function read(guildId, file) {
  const p = path.join(DATA, guildId, file);
  try {
    if (!fs.existsSync(p)) return {};
    return JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch { return {}; }
}

function write(guildId, file, data) {
  const dir = path.join(DATA, guildId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, file), JSON.stringify(data, null, 2), "utf-8");
}

// ── state ──────────────────────────────────────────────
function loadState(guildId)          { return read(guildId, "state.json"); }
// updatedAt を明示的に渡された場合はそれを尊重する（渡されなければ現在時刻）
function saveState(guildId, partial) { write(guildId, "state.json", { ...loadState(guildId), ...partial, updatedAt: partial?.updatedAt || new Date().toISOString() }); }

// ── 予約削除キュー ─────────────────────────────────────
// 通知メッセージの自動削除は setTimeout だと再起動で失われるため state に永続化する
// 構造: state.pendingDeletes = [ { channelId, messageId, deleteAt } ]
function addPendingDelete(guildId, entry) {
  const state = loadState(guildId);
  const queue = Array.isArray(state.pendingDeletes) ? state.pendingDeletes : [];
  queue.push(entry);
  // 「最終同期」の表示を汚さないよう updatedAt は据え置く
  saveState(guildId, { pendingDeletes: queue, updatedAt: state.updatedAt });
}

/** 削除予定時刻を過ぎた項目をキューから取り出す（取り出した分はキューから消える） */
function takeDuePendingDeletes(guildId, nowMs = Date.now()) {
  const state = loadState(guildId);
  const queue = Array.isArray(state.pendingDeletes) ? state.pendingDeletes : [];
  if (queue.length === 0) return [];
  const due     = queue.filter(e => e.deleteAt <= nowMs);
  const pending = queue.filter(e => e.deleteAt > nowMs);
  if (due.length > 0) saveState(guildId, { pendingDeletes: pending, updatedAt: state.updatedAt });
  return due;
}

// ── notices ────────────────────────────────────────────
// 構造: { [eventId]: [ { roleId, minutesBefore, firedAt? } ] }
function loadNotices(guildId)         { return read(guildId, "notices.json"); }
function saveNotices(guildId, data)   { write(guildId, "notices.json", data); }

function getNoticesForEvent(guildId, eventId) {
  return loadNotices(guildId)[eventId] || [];
}

function setNoticesForEvent(guildId, eventId, notices) {
  const all = loadNotices(guildId);
  if (!notices || notices.length === 0) {
    delete all[eventId];
  } else {
    all[eventId] = notices;
  }
  saveNotices(guildId, all);
}

function deleteNoticesForEvent(guildId, eventId) {
  const all = loadNotices(guildId);
  delete all[eventId];
  saveNotices(guildId, all);
}

function markNoticeFired(guildId, eventId, index) {
  const all = loadNotices(guildId);
  if (all[eventId]?.[index]) {
    all[eventId][index].firedAt = new Date().toISOString();
    saveNotices(guildId, all);
  }
}

function resetFiredForEvent(guildId, eventId) {
  const all = loadNotices(guildId);
  if (all[eventId]) {
    all[eventId] = all[eventId].map(n => {
      const copy = { roleId: n.roleId, minutesBefore: n.minutesBefore };
      if (n.targetType) copy.targetType = n.targetType;
      return copy;
    });
    saveNotices(guildId, all);
  }
}

function deleteNoticeEntry(guildId, eventId, index) {
  const all = loadNotices(guildId);
  if (all[eventId]) {
    all[eventId].splice(index, 1);
    if (all[eventId].length === 0) delete all[eventId];
    saveNotices(guildId, all);
  }
}

module.exports = {
  loadState, saveState,
  addPendingDelete, takeDuePendingDeletes,
  loadNotices, getNoticesForEvent, setNoticesForEvent,
  deleteNoticesForEvent, markNoticeFired,
  resetFiredForEvent, deleteNoticeEntry,
};
