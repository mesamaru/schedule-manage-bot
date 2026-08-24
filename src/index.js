require("dotenv").config();

// 予定の日時表示・入力解釈はすべて JST 前提のため、実行環境の TZ に依存しないよう固定する。
// Date を一度でも使う前に設定する必要があるので、他の require より先に置くこと。
process.env.TZ = process.env.TZ || "Asia/Tokyo";

const path = require("path");
const readline = require("readline");
const { spawn } = require("child_process");
const { createApp } = require("./app");

const app = createApp();
attachPanelCommands(app);

function attachPanelCommands(app) {
	const allowedCommands = new Set(["update", "npm run update", "npm run update --", "npm update"]);
	const input = process.stdin;
	try {
		input.setEncoding("utf8");
	} catch {}
	input.resume();

	const rl = readline.createInterface({ input, crlfDelay: Infinity });
	let updateRunning = false;

	rl.on("line", (line) => {
		const command = line.trim().toLowerCase();
		if (!allowedCommands.has(command)) return;
		if (updateRunning) {
			console.log("[panel] update is already running");
			return;
		}
		updateRunning = true;
		console.log(`[panel] update requested: ${command}`);

		const updater = spawn(process.execPath, [path.join(__dirname, "../scripts/update.mjs")], {
			cwd: path.join(__dirname, ".."),
			stdio: "inherit",
			env: process.env,
		});

		updater.on("exit", async (code) => {
			console.log(`[panel] update finished with code ${code ?? 1}`);
			try {
				await app.client.destroy();
			} catch {}
			process.exit(code ?? 1);
		});

		updater.on("error", async (error) => {
			console.error(`[panel] update failed: ${error.message}`);
			try {
				await app.client.destroy();
			} catch {}
			process.exit(1);
		});
	});

	console.log("[panel] type 'update' or 'npm run update' in the console to update from GitHub");
}
