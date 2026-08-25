# 📅 スケジュール管理 Discord Bot

Google カレンダーと連携して、Discord サーバーにスケジュールを自動表示・通知する Bot です。  
**1つの Bot インスタンスで複数のサーバーに対応**しています。各サーバーは `/setup` コマンドで独立して設定できます。

---

## 🗺️ 目次

1. [できること](#できること)
2. [GCP（Google Cloud）の設定](#gcpgoogle-cloudの設定)
3. [Discord Bot の作成](#discord-bot-の作成)
4. [Bot のデプロイ（Fly.io）](#bot-のデプロイflyio)
5. [サーバーへの導入（/setup）](#サーバーへの導入setup)
6. [日常的な使い方](#日常的な使い方)
7. [ローカル開発環境での起動](#ローカル開発環境での起動)
8. [トラブルシューティング](#トラブルシューティング)
9. [バージョン運用ルール](#バージョン運用ルール)

---

## できること

### 📆 カレンダー表示
- 指定チャンネルに **カレンダー埋め込み** と **ステータス埋め込み** を固定投稿
- ◀▶ ボタンで月切り替え（自分だけに見える ephemeral 表示）
- 今日の日付をハイライト（📍）
- 曜日別カラードット（🔴日・🔵土・▫️平日）

### 📝 予定管理（オペレーターロール or 管理者のみ）

| 操作 | 方法 |
|------|------|
| ➕ 追加 | ステータスのボタン → モーダル入力 |
| ✏️ 編集 | ステータスのボタン → 予定選択 → モーダル入力 |
| 🗑️ 削除 | ステータスのボタン → 予定選択 → 確認 |
| 🔄 更新 | ステータスのボタン（全員操作可） |

### 🔔 通知設定
- 予定ごとに **複数の通知** を設定可能
- 通知対象: **ロール** / **ユーザー** / `@everyone` / `@here`
- 通知タイミング: 5分前〜24時間前などから選択
- 通知メッセージは投稿後 **自動削除**（`notify_channel` あり: **7日後** / なし: **24時間後**）
### 📋 操作ログ
- 予定の追加・編集・削除を専用チャンネルに色分け Embed で記録
- **Bot のライフサイクルイベント**（起動・再起動・切断・停止）も同チャンネルへ自動通知

---

## GCP（Google Cloud）の設定

Bot が Google カレンダーの予定を読み書きするために、**サービスアカウント**が必要です。

### 1. Google Cloud プロジェクトを作成する

1. [Google Cloud Console](https://console.cloud.google.com/) を開く
2. 上部のプロジェクト選択から **「新しいプロジェクト」** をクリック
3. プロジェクト名を入力（例: `discord-schedule-bot`）して **「作成」**
4. 作成したプロジェクトが選択されていることを確認

### 2. Google Calendar API を有効化する

1. 左側メニューから **「APIとサービス」→「ライブラリ」** を開く
2. 検索欄に `Google Calendar API` と入力
3. **「Google Calendar API」** をクリックして **「有効にする」**

### 3. サービスアカウントを作成する

1. 左側メニューから **「APIとサービス」→「認証情報」** を開く
2. 上部の **「認証情報を作成」→「サービスアカウント」** をクリック
3. サービスアカウント名を入力（例: `calendar-bot`）して **「作成して続行」**
4. ロールの付与は不要 → **「完了」**

### 4. 秘密鍵（JSON）をダウンロードする

1. 認証情報の一覧から、今作ったサービスアカウントのメールアドレスをクリック
2. 上部の **「キー」タブ** を開く
3. **「鍵を追加」→「新しい鍵を作成」→「JSON」→「作成」**
4. JSON ファイルが自動ダウンロードされます（大切に保管してください）

JSON ファイルの中身はこのような形になっています：

```json
{
  "type": "service_account",
  "project_id": "discord-schedule-bot",
  "client_email": "calendar-bot@discord-schedule-bot.iam.gserviceaccount.com",
  "private_key": "-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n-----END RSA PRIVATE KEY-----\n",
  ...
}
```

後で使うのは `client_email` と `private_key` の2つです。

### 5. Google カレンダーをサービスアカウントと共有する

> ⚠️ **この手順はサーバーごと（カレンダーのオーナーが行う）** です。Bot 管理者が1回行うだけでも構いません。

1. [Google カレンダー](https://calendar.google.com/) を開く
2. 左側のカレンダー名の横の **「⋮」→「設定と共有」** を開く
3. **「特定のユーザーまたはグループと共有する」** の **「ユーザーを追加」** をクリック
4. サービスアカウントのメールアドレス（例: `calendar-bot@discord-schedule-bot.iam.gserviceaccount.com`）を入力
5. 権限を **「予定の変更」（編集者）** に設定して **「送信」**

> 📋 **カレンダー ID をメモしておいてください！**  
> 同じ「設定と共有」ページの **「カレンダーの統合」** セクションに **「カレンダー ID」** が表示されています（例: `xxxx@group.calendar.google.com`）。  
> この値は後の `/setup` コマンドの `calendar_id` に入力します。

---

## Discord Bot の作成

### 1. アプリケーションを作成する

1. [Discord Developer Portal](https://discord.com/developers/applications) を開く
2. 右上の **「New Application」** をクリック
3. Bot の名前を入力して **「Create」**

### 2. Bot を有効化してトークンを取得する

1. 左メニューの **「Bot」** を開く
2. **「Add Bot」→「Yes, do it!」** をクリック
3. **「Reset Token」** をクリック → 確認ダイアログで **「Yes, do it!」**
4. 表示されたトークンをコピーして安全な場所に保存

> ⚠️ トークンは**一度しか表示されません**。ページを閉じたら再発行が必要です。

### 3. Intents を設定する

1. Bot のページで **「Privileged Gateway Intents」** のセクションを探す
2. **「SERVER MEMBERS INTENT」** と **「MESSAGE CONTENT INTENT」** を ON にする  
   （このBotは実際には不要ですが、将来の機能追加に備えて有効化を推奨します）
3. **「Save Changes」**

### 4. Bot をサーバーに招待する

1. 左メニューの **「OAuth2」→「URL Generator」** を開く
2. **「SCOPES」** で `bot` と `applications.commands` にチェック
3. **「BOT PERMISSIONS」** で以下にチェック：
   - `Send Messages`
   - `Embed Links`
   - `Read Message History`
   - `Manage Messages`（既存メッセージの編集用）
4. 下部に生成された URL をコピー → ブラウザで開いてサーバーを選択して招待

---

## Bot のデプロイ（Fly.io）

> 無料で Bot を常時稼働させます。[Fly.io](https://fly.io) の無料プラン（shared-cpu-1x × 3VM、3GBストレージ）を使用します。

### 1. 前準備

**Fly CLI のインストール（初回のみ）**

**Windows（PowerShell で実行）：**
```powershell
# Fly.io 公式スクリプト
# %USERPROFILE%\.fly\bin\ にインストールされ、PATH も自動設定される
iwr https://fly.io/install.ps1 -useb | iex
```

> PowerShell は スタートメニュー → 「Windows PowerShell」で開けます。  
> インストール後、**PowerShell を再起動** してから次の手順に進んでください。

**Mac（ターミナルで実行）：**
```bash
brew install flyctl
```

**アカウントにログイン（初回のみ）：**
```powershell
fly auth login
```
ブラウザが開くので Fly.io のアカウントでログインしてください（アカウント未作成の場合は [fly.io](https://fly.io) で無料登録）。

### 2. プロジェクトをデプロイする

以下はすべて **PowerShell** で実行します。

```powershell
# リポジトリのルートに移動（パスは実際の場所に合わせてください）
cd C:\temp\github\schedule-bot

# Fly.io アプリを作成（fly.toml が既にあるので --no-deploy を使用）
fly launch --no-deploy
```

実行するとブラウザでWeb UIが開きます。以下の通りに設定してください：

| 項目 | 設定値 |
|------|--------|
| **App Name** | 任意（グローバルで一意の名前。`schedule-manage-bot` が使われていたら末尾に任意の文字を追加） |
| **Region** | `nrt`（東京）を選択 |
| **Postgres / Redis** | どちらも **No / Skip** |

設定を確認したら **「Confirm Settings」** をクリックします。  

> ⚠️ App Name を変更した場合は `fly.toml` の `app = '...'` を同じ名前に書き換えてください。

```powershell
# 永続ボリュームを作成（予定・通知データ保存用）
fly volumes create schedule_bot_data --size 1 --region nrt
```

> 途中で `Do you still want to use the volumes feature?` と表示されたら **`y`** を入力して Enter を押してください。

> ⚠️ **`fly launch` を再実行すると `fly.toml` が自動生成で上書きされます。**
> このとき `[[mounts]]`（永続ボリューム）と `[env]`（`TZ=Asia/Tokyo`）が消え、代わりに `[http_service]` が追加されることがあります。
> この Bot は HTTP サーバーを持たない常駐プロセスなので、**次の3点を必ず維持してください**：
> - `[[mounts]]` **あり** … 無いと再起動のたびに `/setup` の設定とメッセージIDが消え、カレンダー／ステータスが**重複投稿**されます
> - `[env] TZ = 'Asia/Tokyo'` **あり** … 無いと予定の時刻表示がずれます
> - `[http_service]` **なし** … あると Fly が HTTP アクセスの有無でマシンを停止／起動しようとします

次に環境変数（シークレット）を設定します。**1行ずつ** 実行してください：

```powershell
fly secrets set DISCORD_TOKEN="ここにDiscordのBotトークン"
fly secrets set GOOGLE_CLIENT_EMAIL="ここにサービスアカウントのメール"
fly secrets set GOOGLE_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n-----END RSA PRIVATE KEY-----\n"
```

> `GOOGLE_PRIVATE_KEY` は JSON ファイルの `private_key` の値をそのままコピーしてください。  
> 値全体をダブルクォート `"..."` で囲み、`\n` はそのまま残してください。

```powershell
# デプロイ実行
fly deploy
```

### 3. 動作確認

```powershell
# ログを確認（リアルタイムで流れ続けます）
fly logs
```

起動に成功すると以下のようなログが表示されます：

### 4. サービスをアップデートする

GitHub 上の変更を反映するときは、リポジトリを最新化してから再デプロイします。

```powershell
fly deploy
```

```
========================================
  gcal-discord-bot v8.3.0 起動完了（マルチギルド）
  ログイン: BotName#1234
  スケジュール: */5 * * * *
  起動回数: 1 回目 | 2026/05/26 18:30:00
  PID: 46
========================================
[起動] 設定済みギルド数: 1
[Cron] 登録完了: "*/5 * * * *"
```

再起動が発生した場合は **「起動回数」** の数字が増加します。また、Discord との接続状態も記録されます：

```
[Discord] 接続切断 (shard:0, code:1001) 2026/05/26 20:00:00
[Discord] 再接続中... (shard:0) 2026/05/26 20:00:01
[Discord] 接続再開 (shard:0, replayed:3) 2026/05/26 20:00:02
```

> ログの表示を終了するには **Ctrl + C** を押してください。PowerShell のプロンプトに戻ります。

---

## バージョン運用ルール

このプロジェクトは **SemVer（MAJOR.MINOR.PATCH）** で管理します。

- 移行アップデートや不具合修正: `8.0.0 -> 8.0.1`（PATCH）
- 機能追加やマイナー改善: `8.0.0 -> 8.1.0`（MINOR）
- 破壊的変更や大規模更新: `8.0.0 -> 9.0.0`（MAJOR）

### コマンド

```powershell
# 任意バージョンを直接指定
npm run version:set -- 8.0.0

# 修正リリース（PATCH）
npm run version:patch

# 機能追加リリース（MINOR）
npm run version:minor

# メジャーリリース（MAJOR）
npm run version:major
```

これらのコマンドは `package.json` と `src/package.json` の `version` を同時更新します。

---

## サーバーへの導入（/setup）

Bot をサーバーに招待したら、**サーバーの管理者** が `/setup` を実行します。

### /setup コマンド

Discord のコマンド入力欄に `/setup` と入力すると、以下のオプションが表示されます：

| オプション | 必須 | 説明 |
|-----------|------|------|
| `channel` | ✅ | カレンダーを投稿するチャンネル |
| `calendar_id` | ✅ | Google Calendar ID（カレンダー設定で確認） |
| `notify_channel` | ❌ | 通知メッセージを送るチャンネル（省略するとカレンダーチャンネルと同じ） |
| `log_channel` | ❌ | 操作ログを送るチャンネル（省略するとログなし） |
| `operator_role` | ❌ | 予定の追加・編集・削除を許可するロール名（デフォルト: `CalendarOperator`） |

**実行例：**
```
/setup
  channel: #schedule
  calendar_id: xxxx@group.calendar.google.com
  notify_channel: #お知らせ
  log_channel: #bot-log
  operator_role: スタッフ
```

セットアップが完了すると、指定チャンネルにカレンダーとステータスが自動投稿されます。

> ⚠️ **Google カレンダーの共有を忘れずに！**  
> `/setup` の完了メッセージにサービスアカウントのメールアドレスが表示されます。  
> そのメールアドレスをカレンダーに「編集者」として共有してください（[GCP手順5](#5-google-カレンダーをサービスアカウントと共有する) を参照）。

### /setup-remove コマンド

サーバーから Bot の設定を完全に削除します（管理者のみ実行可能）。

### /log-notify コマンド

ログチャンネル通知の ON/OFF を切り替えます（管理者のみ実行可能）。

| オプション | 必須 | 説明 |
|-----------|------|------|
| `category` | ✅ | `all` / `startup` / `connection` / `error` |
| `state` | ✅ | `on` または `off` |

**実行例：**
```
/log-notify
  category: connection
  state: off
```

> `state: off` の間は、操作ログ・システムログのどちらも `log_channel` へ送信しません。
> `category` を `startup` / `connection` / `error` にすると、システムログの該当カテゴリだけを個別に ON/OFF できます。

### /language コマンド

Botの表示言語を切り替えます（管理者のみ実行可能）。

| オプション | 必須 | 説明 |
|-----------|------|------|
| `lang` | ✅ | `ja` または `en` |

**実行例：**
```
/language
  lang: en
```

### 📋 ログチャンネルに届く通知一覧

`log_channel` を設定しているサーバーには、操作ログに加えて以下のシステムイベントも Embed で通知されます。

| イベント | タイトル例 | 色 |
|---------|-----------|----|
| 初回起動 | `✅ Bot 起動` | 🟢 緑 |
| 再起動（2回目以降） | `🔄 Bot 再起動 (#2)` | 🟡 黄 |
| Discord 接続切断 | `⚠️ Discord 接続切断` | 🔴 赤 |
| 再接続中 | `🔄 Discord 再接続中…` | 🔵 青 |
| 接続再開 | `✅ Discord 接続再開` | 🟢 緑 |
| Discord エラー | `❌ Discord エラー` | 🔴 赤 |
| 停止（デプロイ・再起動） | `🛑 Bot 停止` | 🔴 赤 |

> `log_channel` を設定していないサーバーには届きません。

---

## 日常的な使い方

### 🔐 権限について

| 権限 | 操作できること |
|------|--------------|
| サーバー管理者 | すべての操作 + `/setup` / `/setup-remove` / `/log-notify` / `/language` |
| `operator_role` のロール保持者 | 予定の追加・編集・削除・通知設定 |
| **全員** | 🔄 更新・◀▶ 月切り替え・通知の受け取り |

### ➕ 予定を追加する

1. カレンダーチャンネルのステータス Embed の **「➕ 追加」** ボタンをクリック
2. フォームが開くので入力する：
   - **タイトル**（必須）
   - **日付**：`YYYY-MM-DD` 形式（例: `2026-06-15`）
   - **開始時刻**：`HH:MM` または `HHMM` 形式（例: `18:00` / `1800`）、空白で終日
   - **終了時刻**：省略可
   - **メモ**：省略可
3. 送信するとカレンダーが自動更新される

### ✏️ 予定を編集する

1. ステータス Embed の **「✏️ 編集」** をクリック
2. 予定をセレクトメニューから選択
3. 現在の内容が入力済みのフォームが開くので修正して送信

### 🗑️ 予定を削除する

1. ステータス Embed の **「🗑️ 削除」** をクリック
2. セレクトメニューから削除したい予定を選択
3. 確認ダイアログで **「🗑️ 削除する」** をクリック

### 🔔 通知を設定する

予定を追加・編集した後、自動的に通知設定の画面が表示されます。

1. **ロール選択**または**ユーザー選択**、または `@everyone` / `@here` ボタンを押す
2. **通知タイミング**を選択（5分前・30分前・1時間前・3時間前・24時間前）
3. 複数の通知を追加する場合は **「+ もう1件追加」**
4. 設定完了したら **「✅ 完了」**

> 通知は `notify_channel` に設定したチャンネル（未設定の場合はカレンダーチャンネル）に送信されます。  
> 通知メッセージのフッターに削除予定日時が表示され、期限になると自動で削除されます。
>
> | 設定 | 自動削除 | フッター表示 |
> |------|----------|----------|
> | `notify_channel` あり | **7日後** | `🗑️ あと7日で削除（06/02 18:30）` |
> | `notify_channel` なし | **24時間後** | `🗑️ あと 24時間で削除（05/27 18:30）` |

### 🔄 手動更新

ステータス Embed の **「🔄 更新」** ボタンを押すと、Google カレンダーと即時同期します。  
通常は5分ごとに自動同期されます。

---

## ローカル開発環境での起動

### 前提条件
- Node.js v18 以上
- `.env` ファイル（`.env.example` をコピーして作成）

### セットアップ

```bash
# 依存パッケージをインストール
npm install

# .env ファイルを作成
cp .env.example .env
```

`.env` ファイルを編集します：

```env
DISCORD_TOKEN=ここにDiscordのBotトークン
GOOGLE_CLIENT_EMAIL=サービスアカウントのメールアドレス
GOOGLE_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n-----END RSA PRIVATE KEY-----\n"
```

> `GOOGLE_PRIVATE_KEY` はダウンロードした JSON の `private_key` の値をそのままコピーしてください。値全体をダブルクォートで囲んでください。

### 起動

```bash
node src/index.js
```

### 更新

Pterodactyl の Node.js Generic など、サーバー上から直接更新したい場合は以下を実行します。

```bash
npm run update
```

- Pterodactyl の console では shell を直接開いていないため、Bot プロセスに `update` か `npm run update` を入力すると更新が始まります
- GitHub の latest release を取得して上書き更新します
- release が未作成の場合は既定ブランチの最新スナップショットにフォールバックします
- `.env`、`data/`、`logs/`、`node_modules/` は保持したまま更新します
- 更新後に `npm install --omit=dev` を自動実行します

起動コマンドは以下です。

```bash
npm start
```

---

## トラブルシューティング

### ❌ `/setup` でカレンダー投稿に失敗する

**原因:** Google カレンダーがサービスアカウントと共有されていない  
**対処:** サービスアカウントのメールアドレス（`/setup` の完了メッセージに表示）を「編集者」として共有する

---

### ❌ `Invalid Calendar ID` エラーが出る

**原因:** `calendar_id` の入力が正しくない  
**対処:** Google カレンダーの「設定と共有」→「カレンダーの統合」で表示される **カレンダー ID** を使用する

---

### ❌ カレンダーが自動更新されない

**原因:** Fly.io の VM がスリープしている / cron が停止している  
**対処:** `fly logs` でエラーがないか確認。問題があれば `fly restart` で再起動

---

### ❌ カレンダー／ステータスが何度も新規投稿される（重複する）

**原因1:** `fly.toml` に `[[mounts]]` が無く、再起動のたびに `data/` が消えている  
**対処:** 上記「Bot のデプロイ」の注意書きを参照し、永続ボリュームの設定を戻す

**原因2:** Discord API の一時エラー（v8.3.0 で修正済み）  
**対処:** v8.3.1 以降に更新する。既存の重複メッセージは **Bot の再起動時に自動で削除**されます（現行の1件だけ残ります）

**原因3:** それより前の停止処理がカレンダー／ステータス投稿のボタンを削除しており、そのメッセージを Bot 自身の投稿と判別できず新規投稿していた（v8.3.1 で修正済み）  
**対処:** v8.3.1 以降に更新する。修正後は Embed の内容からも判別するため、過去の残骸も自動で引き継がれます

---

### ❌ 通知が来ない

**原因1:** 通知チャンネルに Bot の送信権限がない  
**対処:** Bot にそのチャンネルへの「メッセージを送信」権限を付与する

**原因2:** 通知が既に送信済みになっている  
**対処:** 予定を編集すると通知がリセットされます

---

### ❌ `This interaction failed` とだけ表示される

**原因:** Bot が応答する前に 3秒のタイムアウトが発生した  
**対処:** Bot のレスポンスが遅い場合は Fly.io のリージョンを確認（日本なら `nrt`）

---

## 📁 ファイル構成

```
schedule-bot/
├── src/
│   ├── index.js        起動用エントリ（app.js を呼び出すだけ）
│   ├── app.js          client/handler/cron/lifecycle の組み立て
│   ├── runtime.js      共通ユーティリティ・ログ送信・権限判定
│   ├── scheduler.js    定期同期・カレンダー/ステータス更新
│   ├── commandsHandler.js  スラッシュコマンド処理
│   ├── buttonHandlers.js    ボタン/セレクト処理
│   ├── modalHandlers.js     モーダル処理
│   ├── lifecycle.js    起動/停止/接続イベント
│   ├── i18n.js         ja/en 文言選択
│   ├── guildConfig.js  ギルドごとの設定管理（data/{guildId}/config.json）
│   ├── calendar.js     Google Calendar API ラッパー
│   ├── embed.js        Discord Embed・コンポーネントのビルダー
│   ├── modals.js       モーダル（追加・編集フォーム）のビルダー
│   ├── storage.js      状態・通知設定の永続化（JSONファイル）
│   ├── notifier.js     cron定期実行による通知チェック・送信
│   └── logger.js       コンソールログのファイル記録（日別ローテーション）
├── data/
│   └── {guildId}/
│       ├── config.json   /setup で保存されたサーバー設定
│       ├── state.json    メッセージID・最終ハッシュ等
│       └── notices.json  通知設定（eventId ごと）
├── Dockerfile
├── fly.toml
└── .env.example
```

---

## ℹ️ 仕様・制限

- Google カレンダーの予定変更は最大5分後に自動反映（cron 間隔による）
- 通知メッセージは自動削除（`notify_channel` あり: 7日後、なし: 24時間後）
- 通知設定は予定開始から 24時間経過後に自動クリーンアップ
- メインチャンネルへの投稿は常に2件のみ（カレンダー・ステータス）
- Discord インタラクショントークンの有効期限は15分