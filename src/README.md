# gcal-discord-bot

GoogleカレンダーをDiscordに自動表示するBotです。

## 機能
- 今月のスケジュールを固定メッセージとして5分ごとに上書き更新
- カレンダーに変更があった場合は更新ログを追加投稿
- `/add` コマンド＋モーダルでDiscordからGoogleカレンダーに予定を追加

---

## セットアップ手順

### ステップ1：Google Cloud でサービスアカウントを作成

1. https://console.cloud.google.com/ にアクセス
2. 新しいプロジェクトを作成（または既存を選択）
3. 「APIとサービス」→「ライブラリ」→「Google Calendar API」を有効化
4. 「APIとサービス」→「認証情報」→「認証情報を作成」→「サービスアカウント」
5. 名前を入力して作成（ロールは不要）
6. 作成したサービスアカウントをクリック→「キー」タブ→「鍵を追加」→JSON
7. ダウンロードされたJSONファイルを開く

JSONファイルの中身：
```json
{
  "client_email": "xxxx@xxxx.iam.gserviceaccount.com",  ← GOOGLE_CLIENT_EMAIL
  "private_key": "-----BEGIN RSA PRIVATE KEY-----\n..."  ← GOOGLE_PRIVATE_KEY
}
```

### ステップ2：GoogleカレンダーをサービスアカウントにAPI共有

1. https://calendar.google.com/ を開く
2. 使いたいカレンダーの「⋮」→「設定と共有」
3. 「特定のユーザーまたはグループと共有する」→サービスアカウントのメールを追加
4. 権限：「予定の変更および管理権限」を選択
5. 同画面の「カレンダーの統合」→「カレンダーID」をコピー → GOOGLE_CALENDAR_ID

### ステップ3：Discord Bot の設定

1. https://discord.com/developers/applications でBotを選択
2. 「Bot」→Token をコピー → DISCORD_TOKEN
3. 「Bot」→「Privileged Gateway Intents」は不要（Guildsだけ）
4. 「OAuth2」→「URL Generator」→ scopes: `bot`, `applications.commands`
5. Bot permissions: `Send Messages`, `Read Message History`, `Manage Messages`（ピン留め用）, `Embed Links`
6. 生成されたURLでBotをサーバーに招待

### ステップ4：.env を設定して起動

```bash
cp .env.example .env
# .envを編集して各値を入力

npm install
npm start
```

---

## Pterodactyl 設定

| 項目 | 値 |
|---|---|
| Docker Image | Nodejs 22 |
| MAIN_FILE | src/index.js |
| USER_UPLOAD | 1 |
| NODE_PACKAGES | （空欄でOK） |
| 起動検知文字列 | `gcal-discord-bot 起動完了` |

### 起動検知JSON（Startup Detection）
```json
{ "done": ["gcal-discord-bot 起動完了"] }
```

---

## ディレクトリ構成

```
gcal-discord-bot/
├── src/
│   ├── index.js      # エントリーポイント・Discordクライアント
│   ├── calendar.js   # Google Calendar API
│   ├── commandsHandler.js # スラッシュコマンド定義・処理
│   └── storage.js    # 状態保存
├── data/
│   └── state.json    # 自動生成（固定メッセージIDなど）
├── .env              # 要作成
├── .env.example
└── package.json
```
