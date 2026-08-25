# AI開発継続用 技術仕様書
## スケジュール管理 Discord Bot — v8.3.0

> **用途**: 次回AIに開発の続きを依頼する際の引き継ぎ資料

---

## 1. プロジェクト概要

Discord サーバー上で Google カレンダーの予定を管理・表示・通知する Bot。  
**1インスタンスで複数サーバー（マルチギルド）に対応**。  
`/setup` スラッシュコマンドでサーバーごとに独立して設定できる。  
チャンネルに固定投稿した2つのEmbedとボタンUIで予定を操作する。

**バージョン**: v8.3.0  
**最終更新**: 2026-08-24

> バージョンは `package.json` / `src/package.json` の `version` が唯一の正。
> `src/version.js` がそれを読み、ステータスEmbedと起動ログに表示する。
> 変更は `npm run version:patch|minor|major` で行う（両方の package.json が同時に更新される）。

---

## 2. 技術スタック

| 項目 | 内容 |
|------|------|
| ランタイム | Node.js v18+ |
| Discord | discord.js v14 |
| カレンダー | Google Calendar API v3（googleapis） |
| スケジューラ | node-cron v3 |
| 設定管理 | dotenv |
| 永続化 | JSON ファイル（`data/` ディレクトリ） |

**Discordインテント**: `GatewayIntentBits.Guilds` のみ

---

## 3. ファイル構成と役割

```
src/
├── index.js        起動専用エントリ（app.js を呼び出すだけ）
├── app.js          client/handler/cron/lifecycle の組み立て
├── runtime.js      共通ユーティリティ・ログ送信・権限判定
├── scheduler.js    定期同期とカレンダー/ステータス更新
├── commandsHandler.js  スラッシュコマンド処理
├── buttonHandlers.js    ボタン/セレクト処理
├── modalHandlers.js     モーダル処理
├── lifecycle.js    起動/停止/接続イベントとシャットダウン
├── i18n.js         ja/en の文言選択
├── guildConfig.js  ギルドごとの設定管理（data/{guildId}/config.json の読み書き）
├── calendar.js     Google Calendar API ラッパー（CRUD + hashEvents + formatEvent）
├── embed.js        全 EmbedBuilder・ActionRowBuilder のファクトリ
├── modals.js       追加・編集モーダルのファクトリ
├── storage.js      state.json・notices.json の読み書き（guildId ベース）
├── notifier.js     cron定期呼び出しによる通知チェック・送信・予約削除の回収
├── version.js      package.json から版数を読む（appVersion）
└── logger.js       console をファイルにも記録（日別ローテーション・7日自動削除）

data/
├── .startup_count          累積起動回数（整数テキスト）
└── {guildId}/
    ├── config.json         /setup で保存されたサーバー設定
    ├── state.json          Bot状態（メッセージID・最終ハッシュ等）
    └── notices.json        通知設定（eventId → 通知リスト）

logs/
└── YYYY-MM-DD.log  日別ログファイル（7日分保持）
```

---

## 4. 環境変数（`.env`）

v5からチャンネルID・カレンダーIDはすべて `/setup` で per-guild に保存するため、認証情報のみ必要。

| 変数名 | 説明 | 省略時 |
|--------|------|--------|
| `DISCORD_TOKEN` | Bot トークン | 必須 |
| `GOOGLE_CLIENT_EMAIL` | GCPサービスアカウントメール | 必須 |
| `GOOGLE_PRIVATE_KEY` | GCP秘密鍵（`\n` 含む文字列） | 必須 |
| `CRON_SCHEDULE` | cron式 | `*/5 * * * *` |

> `GOOGLE_PRIVATE_KEY` の改行は `\\n` をそのまま .env に書けばよい（`replace(/\\n/g, "\n")` で処理済み）

---

## 5. ギルド設定（`data/{guildId}/config.json`）

`/setup` コマンド実行時に `guildConfig.js` で保存される。

```json
{
  "channelId":        "カレンダー投稿チャンネルID",
  "calendarId":       "xxxx@group.calendar.google.com",
  "notifyChannelId":  "通知チャンネルID（null可）",
  "logChannelId":     "ログチャンネルID（null可）",
  "logEnabled":       true,
  "language":         "ja",
  "systemLogToggles": {
    "startup": true,
    "connection": true,
    "error": true
  },
  "operatorRoleName": "CalendarOperator"
}
```

| フィールド | 省略時の動作 |
|-----------|------------|
| `notifyChannelId` | `channelId` と同じチャンネルに通知 |
| `logChannelId` | ログなし（操作ログ・システムログ共に無効） |
| `logEnabled` | `true` 扱い（ただし `logChannelId` 未設定時は送信しない） |
| `language` | `ja` / `en`（省略時は `ja`） |
| `systemLogToggles` | 省略時は全カテゴリON（`startup`/`connection`/`error`） |
| `operatorRoleName` | `"CalendarOperator"` |

---

## 6. データ構造

### `data/{guildId}/state.json`
```json
{
  "calendarMessageId": "1234567890",
  "statusMessageId":   "0987654321",
  "lastHash":          "a1b2c3d4",
  "updatedAt":         "2026-05-26T10:00:00.000Z",
  "pendingDeletes": [
    { "channelId": "111", "messageId": "222", "deleteAt": 1787542274911 }
  ]
}
```

### `data/{guildId}/notices.json`
```json
{
  "googleCalEventId": [
    { "roleId": "discordRoleId", "minutesBefore": 60 },
    { "roleId": "discordUserId", "minutesBefore": 30, "targetType": "user" },
    { "roleId": "@everyone",     "minutesBefore": 5 },
    { "roleId": "@here",         "minutesBefore": 10, "firedAt": "2026-05-26T09:00:00.000Z" }
  ]
}
```

`targetType: "user"` がある場合はユーザーメンション。ない場合はロールメンション。  
`firedAt` は通知済みマーク（ISO文字列）。

---

## 7. スラッシュコマンド

グローバルコマンドとして登録（`registerGlobalCommands()`）。

### `/setup`
サーバーに Bot を導入する。管理者のみ実行可能。

| オプション | 必須 | 説明 |
|-----------|------|------|
| `channel` | ✅ | カレンダー投稿チャンネル |
| `calendar_id` | ✅ | Google Calendar ID |
| `notify_channel` | ❌ | 通知チャンネル（省略→カレンダーチャンネルと同じ） |
| `log_channel` | ❌ | 操作ログ・システムログ送信チャンネル |
| `operator_role` | ❌ | 操作許可ロール名（省略→`CalendarOperator`） |

実行フロー:
1. `saveConfig(guildId, cfg)` で `data/{guildId}/config.json` を書き込み
2. `run(guildId, cfg, true)` でカレンダー・ステータスを初期投稿
3. 完了メッセージにサービスアカウントのメールアドレスを表示（共有忘れ防止）

### `/setup-remove`
サーバーの Bot 設定を完全削除する。管理者のみ実行可能。

実行フロー:
1. `deleteConfig(guildId)` で `data/{guildId}/` ディレクトリを削除
2. 完了 ephemeral メッセージ

### `/log-notify`
ログチャンネルへの通知を ON/OFF 切り替えする。管理者のみ実行可能。

| オプション | 必須 | 説明 |
|-----------|------|------|
| `category` | ✅ | `all` / `startup` / `connection` / `error` |
| `state` | ✅ | `on` / `off` |

実行フロー:
1. `loadConfig(guildId)` で設定を取得
2. `config.logEnabled` を更新して `saveConfig(guildId, config)`
3. 完了 ephemeral メッセージ

### `/language`
Botの表示言語を切り替える。管理者のみ実行可能。

| オプション | 必須 | 説明 |
|-----------|------|------|
| `lang` | ✅ | `ja` / `en` |

実行フロー:
1. `loadConfig(guildId)` で設定を取得
2. `config.language` を更新して `saveConfig(guildId, config)`
3. 完了 ephemeral メッセージ

---

## 8. 権限設計

```js
function hasPermission(member, operatorRoleName) {
  if (!member) return false;
  if (member.permissions.has(PermissionFlagsBits.Administrator)) return true;
  return member.roles.cache.some(r => r.name === operatorRoleName);
}
```

v5 では `operatorRoleName` は per-guild の `config.operatorRoleName` から取得。

**権限チェック不要**: `btn_refresh`, `btn_prev_*`, `btn_next_*`, 通知設定系ボタン全般, 通知削除セレクト  
**権限チェック必要**: `btn_add`, `btn_edit_select`, `btn_delete_select`, 編集・削除系セレクト

---

## 9. カスタムID一覧（ボタン / セレクト / モーダル）

### ボタン
| customId | 権限 | 説明 |
|----------|------|------|
| `btn_refresh` | 不要 | カレンダー強制更新 |
| `btn_prev_{year}_{month}` | 不要 | 先月表示 |
| `btn_next_{year}_{month}` | 不要 | 翌月表示 |
| `btn_add` | 必要 | 追加モーダル表示 |
| `btn_edit_select` | 必要 | 編集予定選択メニュー表示 |
| `btn_delete_select` | 必要 | 削除予定選択メニュー表示 |
| `btn_confirm_delete_{eventId}` | 不要(*) | 削除実行 |
| `btn_cancel_delete` | 不要 | 削除キャンセル |
| `btn_notify_everyone_{eventId}` | 不要 | @everyone通知 |
| `btn_notify_here_{eventId}` | 不要 | @here通知 |
| `btn_notify_t_{eventId}_{roleId}_{minutes}` | 不要 | ロール通知時間確定 |
| `btn_notify_u_{eventId}_{roleId}_{minutes}` | 不要 | ユーザー通知時間確定 |
| `btn_notify_skip_{eventId}` | 不要 | 通知設定スキップ |
| `btn_notify_done_{eventId}` | 不要 | 通知設定完了 |
| `btn_notify_more_{eventId}` | 不要 | 通知追加（管理ビューへ） |
| `btn_nmgr_add_{eventId}` | 不要 | 通知管理：通知追加 |
| `btn_nmgr_del_{eventId}` | 不要 | 通知管理：通知削除メニュー |
| `btn_nmgr_done_{eventId}` | 不要 | 通知管理：完了 |

(*) `btn_confirm_delete_` はephemeralaの中で呼ばれるため権限チェック前に通過

### セレクトメニュー
| customId | 権限 | 説明 |
|----------|------|------|
| `select_edit_event` | 必要 | 編集する予定を選択 |
| `select_delete_event` | 必要 | 削除する予定を選択 |
| `select_notify_role_{eventId}` | 不要 | 通知ロール選択（RoleSelectMenu） |
| `select_notify_user_{eventId}` | 不要 | 通知ユーザー選択（UserSelectMenu） |
| `select_nmgr_del_{eventId}` | 不要 | 通知削除対象選択 |

### モーダル
| customId | 説明 |
|----------|------|
| `modal_add` | 予定追加フォーム |
| `modal_edit_{eventId}` | 予定編集フォーム |

#### モーダルフィールド（追加・編集共通）
| フィールドID | 必須 | 説明 |
|------------|------|------|
| `title` | ✓ | タイトル（最大100文字） |
| `date` | ✓ | 日付 `YYYY-MM-DD` |
| `start_time` | - | 開始時刻（`HHMM` / `HH:MM` / 24時以上も可） |
| `end_time` | - | 終了時刻（同上） |
| `description` | - | 詳細（最大500文字） |

---

## 10. 主要ロジック

### 時刻正規化（`normalizeTime`）
```js
// "2100" → "21:00"  "900" → "09:00"  "21:00" → "21:00"（そのまま）
function normalizeTime(str) {
  if (!str) return "";
  str = str.trim();
  if (/^\d{2}:\d{2}$/.test(str)) return str;
  const digits = str.replace(/\D/g, "");
  if (/^\d{3,4}$/.test(digits)) {
    const padded = digits.padStart(4, "0");
    return `${padded.slice(0, 2)}:${padded.slice(2)}`;
  }
  return str;
}
```

### 24時以上の時刻対応（`resolveDateTime` in `calendar.js`）
```js
// "2026-05-16", "25:00" → "2026-05-17T01:00:00+09:00"
function resolveDateTime(dateStr, timeStr) {
  const [h, m] = timeStr.split(":").map(Number);
  if (h < 24) return `${dateStr}T${timeStr}:00+09:00`;
  const extraDays = Math.floor(h / 24);
  const normalH   = h % 24;
  const [y, mo, d] = dateStr.split("-").map(Number);
  const date = new Date(y, mo - 1, d + extraDays);
  // ...日付を繰り上げて返す
}
```

### カウントダウン自動削除ヘルパー（`runtime.js`）
```js
function fmtCd(content, n) { return `${content}\n-# (${n}秒後に消えます)`; }
function startCountdownDelete(interaction, content, seconds = 5) {
  // 1秒ごとにカウントを更新し、最後に deleteReply()
  for (let i = seconds - 1; i >= 1; i--) {
    setTimeout(() => interaction.editReply({ content: fmtCd(content, i) }).catch(() => {}), (seconds - i) * 1000);
  }
  setTimeout(() => interaction.deleteReply().catch(() => {}), seconds * 1000);
}
```
- 成功メッセージ: **5秒後削除**
- エラーメッセージ: **8秒後削除**
- **適用しないケース**: `btn_prev_*` / `btn_next_*`（月切り替え。カレンダーEmbedを返すため削除しない）

### 操作ログ（Audit Log）
```js
async function sendAuditLog(action, interaction, { title, dateStr, timeStr, desc }, logChannelId) {
  if (!logChannelId) return;
  // action: "追加"(緑) / "変更"(黄) / "削除"(赤)
  // Embedに操作者名・アバター・タイムスタンプを付与
}
```
削除時は `getEvent()` で情報取得 → `deleteEvent()` の順（逆にすると情報を取れない）

### システムログ（Bot ライフサイクル通知）
```js
async function sendSystemLog(color, title, description) {
  for (const gid of getAllGuildIds()) {
    const cfg = loadConfig(gid);
    if (!cfg?.logChannelId) continue;
    // EmbedBuilder で全ギルドの logChannelId に送信
  }
}
```

| 呼び出しタイミング | タイトル例 | 色 |
|------------------|-----------|-----|
| `clientReady`（初回） | `✅ Bot 起動` | 緑 `0x57f287` |
| `clientReady`（2回目以降） | `🔄 Bot 再起動 (#N)` | 黄 `0xfee75c` |
| `shardDisconnect` | `⚠️ Discord 接続切断` | 赤 `0xed4245` |
| `shardReconnecting` | `🔄 Discord 再接続中…` | 青 `0x5865f2` |
| `shardResume` | `✅ Discord 接続再開` | 緑 `0x57f287` |
| `error` | `❌ Discord エラー` | 赤 `0xed4245` |
| `gracefulShutdown`（開始直後） | `🛑 Bot 停止` | 赤 `0xed4245` |

### 起動カウンター
```js
function getAndIncrementStartupCount() {
  // data/.startup_count を読み込み+1して上書き保存
  // 返り値: 今回の起動が何回目か（1始まり）
}
```

### 通知メッセージ自動削除
`notifier.js` で通知送信時に削除予定を `state.pendingDeletes` へ積み、cron 実行ごとに
`sweepPendingDeletes()` が期限を過ぎたものを削除する:
- `notifyChannelId` が設定されている場合: **7日後**（`7 * 24 * 60 * 60 * 1000` ms）
- 設定されていない場合: **24時間後**（`24 * 60 * 60 * 1000` ms）
- フッターに削除予定日時を表示: `🗑️ あと7日で削除（MM/DD HH:mm）`

> **v8.3.0 で `setTimeout` から永続キューに変更**。`setTimeout` は再起動で失われるため、
> 「7日後に削除」の表示どおりに消えないことがあった。新規実装でも `setTimeout` に戻さないこと。

### 編集フロー（`pendingEditInteractions`）
```js
const pendingEditInteractions = new Map(); // userId → interaction

// btn_edit_select: await reply → Mapに保存
pendingEditInteractions.set(interaction.user.id, interaction);

// modal_edit_: モーダル送信時にMapから取得し削除
const _prevEdit = pendingEditInteractions.get(interaction.user.id);
if (_prevEdit) {
  _prevEdit.deleteReply().catch(() => {});  // 「選んでください」メッセージを削除
  pendingEditInteractions.delete(interaction.user.id);
}
```
インタラクショントークンは15分間有効。キャンセル時はMapに残るが次回編集で上書きされる。

---

## 11. 投稿構造（チャンネル固定2件）

```
DISCORD_CHANNEL_ID チャンネル
├── 投稿1: カレンダーEmbed + [◀先月] [翌月▶] [🔄更新]
└── 投稿2: ステータスEmbed + [➕追加] [✏️編集] [🗑️削除]
```

- メッセージIDは `data/{guildId}/state.json` に保存。再起動後も同じメッセージを edit する
- 起動時は `run(guildId, cfg, isFirst=true)` で強制更新、その後は cron で `run(guildId, cfg, false)`
- cron 実行時はハッシュ比較で変更があった場合のみカレンダーを更新
- ステータスEmbedは毎回更新（最終同期時刻を表示するため）
- ギルドごとに `guildRunning` Map で多重実行を防止（`guildRunning.get(guildId)` フラグ）

#### 重複投稿の防止（v8.3.0/v8.3.1・`upsertManagedMessage()`）

固定投稿を**作り直してよいのは `10008 Unknown Message` のときだけ**。ここは壊しやすいので必ず守ること。

- `fetch` / `edit` の例外をすべて「消えた」と扱うと、レート制限(429)や 5xx のたびに新規投稿が増える（v8.2.1 までの不具合）
- 消えていた場合はまずチャンネルの直近50件から自分の投稿を探して**引き継ぐ**（`state.json` を失っても重複しない）。
  判別は原則ボタンの customId（カレンダー=`btn_refresh` / ステータス=`btn_add`）。
  加えて `MANAGED_MESSAGES[kind].matchEmbed(embed)` による Embed 内容ベースの予備判定も持つ
  （v8.3.0 より前の `gracefulShutdown` がボタンを丸ごと削除していたため、その残骸を拾うための保険）
- 起動時に `cleanupDuplicateMessages()` が、追跡中の1件を残して過去の重複投稿を削除する
- `gracefulShutdown`（`lifecycle.js`）は停止時にボタンを**削除ではなく無効化**する
  （`buildCalendarButtons`/`buildActionButtons` の `{ disabled: true }`）。
  ボタンを削除すると customId が消え、次回起動時に自分のメッセージだと判別できなくなり重複投稿の原因になる。
  **新しい停止処理を書く場合も `components: []` にしないこと**
- `data/` が揮発する構成（`fly.toml` の `[[mounts]]` 欠落など）だと設定ごと消えるため、インフラ側も要確認

---

## 12. 通知フロー

```
予定追加/編集後 → buildNoticeManageComponents(eventId) → 通知管理UI表示
（通知設定なしでも「完了」ボタンで閉じられる）

通知管理UI:
  [➕ 通知を追加] → ロール選択 / ユーザー選択 / @everyone / @here
                  → 時間選択（5分〜24時間）→ 保存 → 管理UI戻り
  [🗑️ 通知を削除] → deferUpdate後 guild.members.fetch() で実名取得
                  → セレクトメニュー表示 → 選択 → deleteNoticeEntry → 管理UI戻り
  [✅ 完了]        → カウントダウン後削除

cron（*/5分）→ checkAndFireNotices:
  今月・来月のイベントを取得 → notices.jsonと照合
  → 通知タイミングを過ぎた未送信通知を NOTIFY_CHANNEL_ID に送信
  → 送信済みは firedAt に記録
  → 予定開始から24時間経過したものは notices.json から自動削除
```

---

## 13. グレースフルシャットダウン

`SIGTERM` / `SIGINT` / `SIGHUP` 受信時:
1. **全ギルドの logChannelId へ `🛑 Bot 停止` を送信**（`sendSystemLog`）
2. ステータスEmbedを「Bot停止中」（グレー）に更新、ボタン削除
3. カレンダーのボタンを削除
4. `client.destroy()` して `logger.close()` → `process.exit(0)`
5. 10秒タイムアウト内に完了しなければ `process.exit(1)`（強制終了）

---

## 14. embed.js 主要ビルダー一覧

**v7 時点では一部の関数に `lang` が追加され、多言語表示に対応している。**

| 関数名 | 返り値 | 説明 |
|--------|--------|------|
| `buildCalendarEmbed(guildId, events, year, month, lang?)` | `EmbedBuilder` | カレンダー本体 |
| `buildCalendarButtons(year, month, lang?)` | `ActionRowBuilder` | ◀▶🔄 ボタン行 |
| `buildStatusEmbed(guildId, events, lastUpdated, roleName, online?, lang?)` | `EmbedBuilder` | ステータス（直近予定・件数等） |
| `buildActionButtons(lang?)` | `ActionRowBuilder` | ➕✏️🗑️ ボタン行 |
| `buildSelectMenu(events, customId, placeholder, lang?)` | `ActionRowBuilder\|null` | 予定選択メニュー（0件時null） |
| `buildRoleSelectForNotify(eventId, lang?)` | `ActionRowBuilder[]` | ロール/ユーザー選択行 |
| `buildNotifyTimeButtons(eventId, roleId, targetType?, lang?)` | `ActionRowBuilder[]` | 時間選択ボタン行 |
| `buildNoticeManageComponents(guildId, eventId, lang?)` | `{content, components}` | 通知管理UI全体 |

---

## 15. storage.js 関数一覧

**v5 から第1引数に `guildId` が追加された。ファイルパスは `data/{guildId}/state.json` 等。**

| 関数 | 説明 |
|------|------|
| `loadState(guildId)` | state.json を読む |
| `saveState(guildId, partial)` | state.json に partial をマージ保存 |
| `getNoticesForEvent(guildId, eventId)` | 特定イベントの通知リスト |
| `setNoticesForEvent(guildId, eventId, notices)` | 通知リスト全体を上書き保存 |
| `deleteNoticesForEvent(guildId, eventId)` | イベントの通知設定を全削除 |
| `markNoticeFired(guildId, eventId, index)` | 指定インデックスに firedAt 記録 |
| `resetFiredForEvent(guildId, eventId)` | 全 firedAt を削除（編集時に使用） |
| `deleteNoticeEntry(guildId, eventId, index)` | 指定インデックスの通知設定を削除 |

---

## 16. guildConfig.js 関数一覧

| 関数 | 説明 |
|------|------|
| `loadConfig(guildId)` | `data/{guildId}/config.json` を読む（なければ `null`） |
| `saveConfig(guildId, data)` | config.json を書き込む（ディレクトリも作成） |
| `deleteConfig(guildId)` | `data/{guildId}/` ディレクトリを再帰削除 |
| `getAllGuildIds()` | config.json が存在するギルドIDの配列を返す |

---

## 17. calendar.js 関数一覧

**v5 から第1引数に `calendarId` が追加された。**

| 関数 | 説明 |
|------|------|
| `getMonthEvents(calendarId, year, month)` | 指定月のイベント一覧取得 |
| `addEvent(calendarId, data)` | イベント追加 |
| `updateEvent(calendarId, eventId, data)` | イベント更新 |
| `getEvent(calendarId, eventId)` | イベント1件取得 |
| `deleteEvent(calendarId, eventId)` | イベント削除 |
| `hashEvents(events)` | イベント配列のハッシュ文字列生成（変更検知用） |
| `formatEvent(event, lang?)` | イベントを表示文字列に整形 |

---

## 18. 既知の制約・注意事項

- Discordインタラクショントークンは**15分**で失効。長時間かかる操作には注意
- `btn_nmgr_del_` は `guild.members.fetch()` を使うため `deferUpdate()` が必要（非同期操作前に確認応答）
- `btn_prev_*` / `btn_next_*` は ephemeral メッセージからのクリックかどうかで `interaction.update()` / `interaction.editReply()` を切り替える
- 予定取得は `maxResults: 250` でページングし、1か月あたり最大1000件まで。Embed説明欄は4000文字で切り捨て
- 日時の解釈・表示は **JST 固定**（`resolveDateTime()` が `+09:00`、`formatEvent()` がプロセスローカル時刻を使う）。
  `src/index.js` の先頭で `process.env.TZ` を `Asia/Tokyo` に固定し、Dockerfile では `tzdata` を入れている。
  alpine は tzdata が無いと `TZ` を解決できず UTC 扱いになるので外さないこと
- 通知の同 `minutesBefore` に対して複数メンションがあれば1メッセージにまとめる
- `sendSystemLog` は `clientReady` より前に呼ぶと `client.channels.fetch` が失敗するため、必ず ready 後または shutdown 時のみ呼ぶ
- 入口は `src/index.js` だが、実処理は `src/app.js` と各 handler に分割済み

---

## 19. 実装済み機能（v8.3.0 時点の累積）

- [x] チャンネル固定2投稿（カレンダー・ステータス）
- [x] 予定CRUD（追加・編集・削除）
- [x] ロール制限（`operatorRoleName` / 管理者）
- [x] 通知設定（ロール・ユーザー・@everyone・@here、複数設定可）
- [x] 通知送信（cron, 別チャンネル対応）
- [x] 通知メッセージ自動削除（notify_channel あり: 7日後 / なし: 24時間後）
- [x] 操作ログ Embed（`logChannelId` チャンネルへ色分け送信）
- [x] **システムログ（Bot ライフサイクルを logChannelId へ Embed 送信）**
- [x] 月切り替え（先月・来月）
- [x] 24時以上の時刻入力対応（`2700` = 翌3時など）
- [x] ephemeral 応答のカウントダウン自動削除（成功5秒・エラー8秒）
- [x] 通知削除メニューに実際のロール名/ユーザー名を表示
- [x] 編集フロー完了時に「選んでください」メッセージを自動削除
- [x] グレースフルシャットダウン（停止中表示への切り替え + ログチャンネル通知）
- [x] 起動カウンター（`data/.startup_count`）・コンソールへの起動回数/PID/タイムスタンプ出力
- [x] `unhandledRejection` / `uncaughtException` ハンドラ（プロセスクラッシュ防止）
- [x] **マルチギルド対応（`/setup` per-guild 設定、guildConfig.js）**
- [x] **index.js の機能分割（app.js + handler 群 + runtime/scheduler/lifecycle）**
- [x] **`/setup-remove` コマンド（設定・データ完全削除）**
- [x] ギルドごとの多重実行防止（`guildRunning` Map）
- [x] ファイルログ（`logger.js`、日別ローテーション、7日自動削除）
- [x] Fly.io デプロイ対応（Dockerfile、fly.toml 設定済み）

---

## 20. デプロイ情報

### Fly.io（本番）
- アプリ名: `schedule-manage-bot`
- リージョン: `nrt`（東京）
- ボリューム: `schedule_bot_data` → `/app/data`
- VM: `shared-cpu-1x` / 256MB
- `[http_service]` は削除済み（HTTP なしで常時稼働）

```powershell
cd C:\temp\github\schedule-bot
flyctl deploy        # ビルド＋デプロイ
flyctl logs          # リアルタイムログ
flyctl machines start  # 停止中マシンの再起動
flyctl status        # 稼働状況確認
```

### Pterodactyl（サブ）
- パネルの管理画面から「Start」ボタンで起動
- 起動コマンド: `node src/index.js`

---

## 21. 起動コマンド（ローカル開発）

```bash
cd C:\temp\github\schedule-bot
node src/index.js
```

---

*この仕様書は 2026-05-28 時点のコードベースに基づいています。*
