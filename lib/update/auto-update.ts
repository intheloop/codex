import type { OpencodeClient } from "@opencode-ai/sdk";
import { existsSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { logInfo, logWarn } from "../logger.js";
import { CACHE_FILES } from "../utils/cache-config.js";
import { getOpenCodePath, safeReadFile, safeWriteFile } from "../utils/file-system-utils.js";

const require = createRequire(import.meta.url);
const packageInfo = require("../../package.json") as { version?: string };

const REGISTRY_URL = "https://registry.npmjs.org/@openhax/codex";
const REGISTRY_TIMEOUT_MS = 5000;
const AUTO_UPDATE_TTL_MS = 15 * 60 * 1000; // match cache TTL
const PACKAGE_VERSION =
	typeof (packageInfo as { version?: string }).version === "string"
		? (packageInfo as { version: string }).version
		: null;

const UPDATE_STATE_PATH = getOpenCodePath("cache", CACHE_FILES.AUTO_UPDATE_STATE);

interface UpdateState {
	lastChecked?: number;
	lastNotifiedVersion?: string;
	lastNotifiedAt?: number;
	lastError?: string;
}

function readUpdateState(): UpdateState {
	const content = safeReadFile(UPDATE_STATE_PATH);
	if (!content) return {};
	try {
		return JSON.parse(content) as UpdateState;
	} catch {
		return {};
	}
}

function writeUpdateState(state: UpdateState): void {
	safeWriteFile(UPDATE_STATE_PATH, JSON.stringify(state));
}

function shouldThrottle(state: UpdateState, now: number): boolean {
	return typeof state.lastChecked === "number" && now - state.lastChecked < AUTO_UPDATE_TTL_MS;
}

async function parseLocalVersion(): Promise<string | null> {
	if (typeof PACKAGE_VERSION === "string") {
		return PACKAGE_VERSION;
	}

	logWarn("Failed to locate local package version", {
		error: "version not found",
	});
	return null;
}

function isNewerVersion(current: string, latest: string): boolean {
	const toParts = (v: string) => v.split(".").map((part) => Number.parseInt(part, 10));
	const currentParts = toParts(current);
	const latestParts = toParts(latest);
	const max = Math.max(currentParts.length, latestParts.length);
	for (let index = 0; index < max; index += 1) {
		const cur = currentParts[index] ?? 0;
		const lat = latestParts[index] ?? 0;
		if (lat > cur) return true;
		if (lat < cur) return false;
	}
	return false;
}

async function fetchLatestVersion(): Promise<string | null> {
	try {
		const response = await fetch(REGISTRY_URL, {
			headers: {
				accept: "application/vnd.npm.install-v1+json",
			},
		});
		if (!response.ok) {
			throw new Error(`registry responded ${response.status}`);
		}
		const body = (await response.json()) as { "dist-tags"?: { latest?: string } };
		return body?.["dist-tags"]?.latest ?? null;
	} catch (error) {
		logWarn("Failed to fetch latest version from npm", {
			error: error instanceof Error ? error.message : String(error),
		});
		return null;
	}
}

function showToast(client: OpencodeClient | undefined, message: string): void {
	try {
		if (client?.tui?.showToast) {
			client.tui.showToast({
				body: {
					title: "Codex update available",
					message,
					variant: "info",
				},
			});
		}
	} catch (error) {
		logWarn("Failed to show toast", {
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

function removePath(path: string, removed: string[], failed: string[]): void {
	try {
		rmSync(path, { recursive: true, force: true });
		removed.push(path);
	} catch (error) {
		failed.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

function clearOldInstallArtifacts(): { removed: string[]; failed: string[] } {
	const removed: string[] = [];
	const failed: string[] = [];

	const pluginCacheRoot = getOpenCodePath("cache");
	const pluginPath = join(pluginCacheRoot, "node_modules", "@openhax", "codex");
	const cacheFiles = [
		getOpenCodePath("cache", CACHE_FILES.CODEX_INSTRUCTIONS),
		getOpenCodePath("cache", CACHE_FILES.CODEX_INSTRUCTIONS_META),
		getOpenCodePath("cache", CACHE_FILES.OPENCODE_CODEX),
		getOpenCodePath("cache", CACHE_FILES.OPENCODE_CODEX_META),
	];

	if (existsSync(pluginPath)) {
		removePath(pluginPath, removed, failed);
	}

	for (const cacheFile of cacheFiles) {
		if (existsSync(cacheFile)) {
			removePath(cacheFile, removed, failed);
		}
	}

	return { removed, failed };
}

export async function runAutoUpdateCheck(client?: OpencodeClient): Promise<void> {
	const now = Date.now();
	const state = readUpdateState();
	if (shouldThrottle(state, now)) return;

	writeUpdateState({ ...state, lastChecked: now, lastError: undefined });

	const localVersion = await parseLocalVersion();
	if (!localVersion) {
		writeUpdateState({ ...state, lastChecked: now, lastError: "local version unavailable" });
		return;
	}

	const latestVersion = await fetchLatestVersion();
	if (!latestVersion) {
		writeUpdateState({ ...state, lastChecked: now, lastError: "npm fetch failed" });
		return;
	}

	if (!isNewerVersion(localVersion, latestVersion)) {
		writeUpdateState({ ...state, lastChecked: now, lastError: undefined });
		return;
	}

	if (
		state.lastNotifiedVersion === latestVersion &&
		state.lastNotifiedAt &&
		now - state.lastNotifiedAt < 24 * 60 * 60 * 1000
	) {
		writeUpdateState({ ...state, lastChecked: now, lastError: undefined });
		return;
	}

	const message = `New @openhax/codex ${latestVersion} available (current ${localVersion}). Restart OpenCode to apply.`;
	logInfo(message);
	showToast(client, message);

	const cleanup = clearOldInstallArtifacts();
	if (cleanup.removed.length) {
		logInfo("Cleared old Codex install artifacts", { removed: cleanup.removed });
	}
	if (cleanup.failed.length) {
		logWarn("Failed to remove some artifacts during update prep", { errors: cleanup.failed });
	}

	writeUpdateState({
		lastChecked: now,
		lastNotifiedVersion: latestVersion,
		lastNotifiedAt: now,
		lastError: cleanup.failed.length ? cleanup.failed.join("; ") : undefined,
	});
}
