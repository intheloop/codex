import type { PluginInput } from "@opencode-ai/plugin";
import type { Auth } from "@opencode-ai/sdk";
import { maybeHandleCodexCommand } from "../commands/codex-metrics.js";
import { LOG_STAGES } from "../constants.js";
import { logRequest } from "../logger.js";
import { recordRequestMetrics } from "../metrics/request-metrics.js";
import { recordSessionResponseFromHandledResponse } from "../session/response-recorder.js";
import type { SessionManager } from "../session/session-manager.js";
import type { PluginConfig, UserConfig } from "../types.js";
import {
	createCodexHeaders,
	extractRequestUrl,
	handleErrorResponse,
	handleSuccessResponse,
	refreshAndUpdateToken,
	rewriteUrlForCodex,
	shouldRefreshToken,
	transformRequestForCodex,
} from "./fetch-helpers.js";

export type CodexFetcherDeps = {
	getAuth: () => Promise<Auth>;
	client: PluginInput["client"];
	accountId: string;
	userConfig: UserConfig;
	codexMode: boolean;
	sessionManager: SessionManager;
	codexInstructions: string;
	pluginConfig: PluginConfig;
};

export function createCodexFetcher(deps: CodexFetcherDeps) {
	const {
		getAuth,
		client,
		accountId,
		userConfig,
		codexMode,
		sessionManager,
		codexInstructions,
		pluginConfig,
	} = deps;

	return async function codexFetch(input: Request | string | URL, init?: RequestInit): Promise<Response> {
		let currentAuth = await getAuth();
		if (shouldRefreshToken(currentAuth)) {
			const refreshResult = await refreshAndUpdateToken(currentAuth, client);
			if (!refreshResult.success) {
				return refreshResult.response;
			}
			currentAuth = refreshResult.auth;
		}

		const originalUrl = extractRequestUrl(input);
		const url = rewriteUrlForCodex(originalUrl);
		const transformation = await transformRequestForCodex(
			init,
			url,
			codexInstructions,
			userConfig,
			codexMode,
			sessionManager,
			pluginConfig,
		);

		if (transformation) {
			const commandResponse = maybeHandleCodexCommand(transformation.body, { sessionManager });
			if (commandResponse) {
				return commandResponse;
			}
		}

		if (transformation?.body) {
			const bodyAny = transformation.body as Record<string, unknown>;
			const promptCacheKey = Boolean(bodyAny.prompt_cache_key ?? bodyAny.promptCacheKey);
			const tools = Array.isArray(bodyAny.tools) ? (bodyAny.tools as unknown[]) : [];
			const toolChoiceRaw = bodyAny.tool_choice;
			const toolChoice =
				typeof toolChoiceRaw === "string"
					? toolChoiceRaw
					: toolChoiceRaw && typeof toolChoiceRaw === "object" && "type" in toolChoiceRaw
						? (toolChoiceRaw as { type?: unknown }).type
						: undefined;
			const parallelToolCalls =
				typeof bodyAny.parallel_tool_calls === "boolean"
					? (bodyAny.parallel_tool_calls as boolean)
					: undefined;
			const includeRaw = bodyAny.include;
			const include = Array.isArray(includeRaw)
				? (includeRaw as unknown[]).filter((value): value is string => typeof value === "string")
				: undefined;
			const store = typeof bodyAny.store === "boolean" ? (bodyAny.store as boolean) : undefined;
			const reasoning = bodyAny.reasoning as { effort?: unknown; summary?: unknown } | undefined;
			const text = bodyAny.text as { verbosity?: unknown } | undefined;

			recordRequestMetrics({
				url,
				model: typeof bodyAny.model === "string" ? (bodyAny.model as string) : undefined,
				promptCacheKey,
				toolCount: tools.length,
				toolChoice: typeof toolChoice === "string" ? toolChoice : undefined,
				parallelToolCalls,
				include,
				store,
				reasoningEffort: typeof reasoning?.effort === "string" ? (reasoning.effort as string) : undefined,
				reasoningSummary: typeof reasoning?.summary === "string" ? (reasoning.summary as string) : undefined,
				textVerbosity: typeof text?.verbosity === "string" ? (text.verbosity as string) : undefined,
			});
		}

		const hasTools = transformation?.body.tools !== undefined;
		const requestInit = transformation?.updatedInit ?? init ?? {};
		const sessionContext = transformation?.sessionContext;
		const accessToken = currentAuth.type === "oauth" ? currentAuth.access : "";
		const headers = createCodexHeaders(requestInit, accountId, accessToken, {
			model: transformation?.body.model,
			promptCacheKey: (transformation?.body as Record<string, unknown> | undefined)?.prompt_cache_key as
				| string
				| undefined,
		});

		const response = await fetch(url, { ...requestInit, headers });
		logRequest(LOG_STAGES.RESPONSE, {
			status: response.status,
			ok: response.ok,
			statusText: response.statusText,
			headers: Object.fromEntries(response.headers.entries()),
		});

		if (!response.ok) {
			return await handleErrorResponse(response);
		}

		const handledResponse = await handleSuccessResponse(response, hasTools);

		await recordSessionResponseFromHandledResponse({
			sessionManager,
			sessionContext,
			handledResponse,
		});

		return handledResponse;
	};
}
