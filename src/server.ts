import { resolve } from "node:path";
import { Plugin } from "@opencode/plugin";
import { showToast } from "./toast.js";
import {
	DEFAULT_IDE_TOOL_NAMES,
	DIAGNOSTICS_POST_EDIT_DELAY_MS,
	LARGE_READ_CONSECUTIVE_BLOCK_THRESHOLD,
	LARGE_READ_LINE_THRESHOLD,
	MOVE_BASH_REGEX,
	NON_SYMBOLIC_DENY_COOLDOWN_MS,
	NON_SYMBOLIC_STREAK_BLOCK_THRESHOLD,
	NON_SYMBOLIC_UNBOUNDED_READ_INCREMENT,
	NUDGE_COOLDOWN_MS,
	SEARCH_BASH_REGEX,
} from "./constants.js";
import { formatDiagnosticsSummary } from "./diagnostics.js";
import {
	buildMoveRefactorReminder,
	buildNewDiagnosticsReminder,
	buildReadEfficiencyReminder,
	buildSessionStartIdeNudge,
	buildSystemPromptPolicy,
	wrapSystemReminder,
} from "./prompts.js";
import { ProblemsTracker, type DiagnosticsCheckOutcome } from "./problems-tracker.js";
import { SessionStateStore } from "./state.js";
import {
	getBashCommand,
	getFilePathFromToolInput,
	isSearchFirstResetTool,
	isSemanticIdeTool,
	isUnboundedReadInput,
	resolveEffectiveToolName,
} from "./tool-names.js";

function asRecord(value: unknown): Record<string, unknown> | null {
	if (!(value && typeof value === "object")) {
		return null;
	}
	return value as Record<string, unknown>;
}

function countTextLinesFromToolResult(result: unknown): number {
	const record = asRecord(result);
	if (!record) {
		return 0;
	}

	if (typeof record.output === "string" && record.output.length > 0) {
		return record.output.split(/\r?\n/).length;
	}

	const content = record.content;
	if (typeof content === "string") {
		return content.length > 0 ? content.split(/\r?\n/).length : 0;
	}

	if (!Array.isArray(content)) {
		return 0;
	}

	let lines = 0;
	for (const block of content) {
		const item = asRecord(block);
		if (!item || item.type !== "text") {
			continue;
		}
		const text = item.text;
		if (typeof text !== "string" || text.length === 0) {
			continue;
		}
		lines += text.split(/\r?\n/).length;
	}

	return lines;
}

function appendSystemReminder(output: unknown, reminder: string): void {
	const record = asRecord(output);
	if (!record) {
		return;
	}

	if (typeof record.output === "string") {
		record.output = record.output.length > 0 ? `${record.output}\n\n${reminder}` : reminder;
		return;
	}

	if (typeof record.content === "string") {
		record.content = record.content.length > 0 ? `${record.content}\n\n${reminder}` : reminder;
		return;
	}

	if (Array.isArray(record.content)) {
		record.content = [...record.content, { type: "text", text: reminder }];
		return;
	}

	record.output = reminder;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function stripSystemReminderEnvelope(reminder: string): string {
	const match = reminder.match(/^<system-reminder>\n([\s\S]*?)\n<\/system-reminder>$/);
	return match?.[1] ?? reminder;
}

function buildPluginVisibilityNotice(lines: string[]): string {
	return ["[Plugin Visibility Notice]", ...lines.map((line) => `- ${line}`)].join("\n");
}

function buildUserVisibleReminderEcho(reminder: string): string {
	return [
		"[Plugin Injected Reminder Content]",
		stripSystemReminderEnvelope(reminder),
	].join("\n");
}

function appendReminderWithVisibility(output: unknown, reminder: string, noticeLines: string[]): void {
	appendSystemReminder(output, buildPluginVisibilityNotice(noticeLines));
	appendSystemReminder(output, buildUserVisibleReminderEcho(reminder));
	appendSystemReminder(output, reminder);
}

function buildDiagnosticsOutcomeNotice(outcome: DiagnosticsCheckOutcome): string {
	const scopedPath = outcome.relativePath ?? outcome.requestedAbsolutePath;
	const lines: string[] = [`Diagnostics pipeline target: ${scopedPath}`];

	switch (outcome.status) {
		case "missing-pending":
			lines.push("Pending mutation baseline: missing");
			lines.push("Diagnostics diff skipped because no pre-mutation baseline was found.");
			break;
		case "sync-failed":
			lines.push(`IDE sync call status: failed (${scopedPath})`);
			lines.push("Used tool: jetbrains_index_ide_sync_files");
			break;
		case "index-not-ready":
			lines.push(`IDE sync call status: succeeded (${scopedPath})`);
			lines.push("Post-sync index readiness: not ready");
			break;
		case "checked":
			lines.push(`IDE sync call status: succeeded (${scopedPath})`);
			lines.push("Post-sync index readiness: ready");
			lines.push(`New diagnostics in this file: ${outcome.newDiagnosticsCount}`);
			break;
	}

	if (outcome.reason) {
		lines.push(`Detail: ${outcome.reason}`);
	}

	return buildPluginVisibilityNotice(lines);
}

function toCommandPreview(command: string): string {
	const normalized = command.replace(/\s+/g, " ").trim();
	return normalized.length > 120 ? `${normalized.slice(0, 117)}...` : normalized;
}

function isMoveCommand(command: string): boolean {
	return MOVE_BASH_REGEX.test(command);
}

function getNonSymbolicIncrement(toolName: string, input: Record<string, unknown>): number {
	if (toolName === "grep") {
		return 1;
	}

	if (toolName === "read") {
		return isUnboundedReadInput(input) ? NON_SYMBOLIC_UNBOUNDED_READ_INCREMENT : 1;
	}

	if (toolName === "bash") {
		const command = getBashCommand(input);
		if (command && SEARCH_BASH_REGEX.test(command)) {
			return 1;
		}
	}

	return 0;
}

function describeNonSymbolicTool(toolName: string, input: Record<string, unknown>): string {
	if (toolName === "read") {
		return isUnboundedReadInput(input) ? "read (unbounded)" : "read";
	}

	if (toolName === "bash") {
		const command = getBashCommand(input);
		if (command && SEARCH_BASH_REGEX.test(command)) {
			return `bash (${toCommandPreview(command)})`;
		}
	}

	return toolName;
}

function extractSessionIdFromEvent(event: Record<string, unknown>): string | undefined {
	const data = asRecord(event.data);
	const dataSessionId = data?.sessionID;
	if (typeof dataSessionId === "string" && dataSessionId.length > 0) {
		return dataSessionId;
	}

	const properties = asRecord(event.properties);
	if (!properties) {
		return undefined;
	}

	const directSessionId = properties.sessionID;
	if (typeof directSessionId === "string" && directSessionId.length > 0) {
		return directSessionId;
	}

	const info = asRecord(properties.info);
	const infoId = info?.id;
	if (typeof infoId === "string" && infoId.length > 0) {
		return infoId;
	}

	return undefined;
}

export default Plugin.define({
	id: "opencode.jetbrains-index-guard",
	async setup(ctx) {
		const directory = ctx.location.directory;
		const state = new SessionStateStore();
		const tracker = new ProblemsTracker();

		let extensionEnabled = false;
		let indexDisabledForSession = false;
		const activeTools = [...DEFAULT_IDE_TOOL_NAMES];

		function getDisableReason(): string {
			return tracker.getStatus().lastError ?? "requirements not satisfied";
		}

		async function disableForSession(reason: string): Promise<void> {
			if (indexDisabledForSession) {
				return;
			}

			indexDisabledForSession = true;
			extensionEnabled = false;
			tracker.reset();
			await tracker.shutdown();
			void showToast("warning", `⚠️ JetBrains index disabled for this session: ${reason}`, "JetBrains Index");
			void showToast("info", "ℹ️ Edit/write will proceed without index checks or diagnostics.", "JetBrains Index");
		}

		async function refreshExtensionEnabled(): Promise<boolean> {
			try {
				const connected = await tracker.initialize(directory);
				extensionEnabled = connected;
				if (!connected) {
					await tracker.shutdown();
				}
				return connected;
			} catch {
				extensionEnabled = false;
				await tracker.shutdown();
				return false;
			}
		}

		await refreshExtensionEnabled();

		async function handleEvent(event: unknown): Promise<void> {
			const record = asRecord(event);
			if (!record || typeof record.type !== "string") {
				return;
			}

			const sessionId = extractSessionIdFromEvent(record);
			if (record.type === "session.created" && sessionId) {
				state.resetTurn(sessionId);
				tracker.reset();
				indexDisabledForSession = false;

				const connected = await refreshExtensionEnabled();
				if (!connected) {
					await disableForSession(getDisableReason());
					return;
				}

				state.markSessionNudgePending(sessionId);
				return;
			}

			if (record.type === "session.deleted" && sessionId) {
				state.clear(sessionId);
				indexDisabledForSession = false;
				return;
			}

			if (record.type === "global.disposed") {
				state.clearAll();
				extensionEnabled = false;
				indexDisabledForSession = false;
				tracker.reset();
				void tracker.shutdown();
			}
		}

		const controller = new AbortController();
		void (async () => {
			try {
				for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
					try {
						await handleEvent(event);
					} catch (error) {
						const message = error instanceof Error ? error.message : String(error);
						console.warn(`[JetBrains Index] Event handling failed: ${message}`);
					}
				}
			} catch {
				// Subscription aborted during plugin cleanup.
			}
		})();

		await ctx.session.hook("prompt", async (event) => {
			state.resetTurn(event.sessionID);
			tracker.reset();

			if (indexDisabledForSession) {
				return;
			}

			const connected = await refreshExtensionEnabled();
			if (!connected) {
				await disableForSession(getDisableReason());
				return;
			}

			state.markSessionNudgePending(event.sessionID);
		});

		await ctx.session.hook("context", (event) => {
			if (!extensionEnabled || indexDisabledForSession) {
				return;
			}

			event.system.push({ type: "text", text: wrapSystemReminder(buildSystemPromptPolicy(activeTools)) });

			state.markSessionNudgePending(event.sessionID);
			if (state.consumeSessionNudge(event.sessionID)) {
				event.system.push({ type: "text", text: buildSessionStartIdeNudge(activeTools) });
			}
		});

		await ctx.tool.hook("execute.before", async (event) => {
			if (!extensionEnabled || indexDisabledForSession) {
				return;
			}

			const args = asRecord(event.input) ?? {};
			const sessionState = state.ensure(event.sessionID);
			const effectiveToolName = resolveEffectiveToolName({ toolName: event.tool, input: args });

			if (isSearchFirstResetTool(effectiveToolName)) {
				sessionState.consecutiveLargeReadCountThisTurn = 0;
				sessionState.nearReadBlockWarningSentThisTurn = false;
			}

			if (
				effectiveToolName === "read"
				&& isUnboundedReadInput(args)
				&& sessionState.consecutiveLargeReadCountThisTurn >= LARGE_READ_CONSECUTIVE_BLOCK_THRESHOLD
			) {
				const reason = `Blocked unbounded read after ${sessionState.consecutiveLargeReadCountThisTurn} consecutive large reads (> ${LARGE_READ_LINE_THRESHOLD} lines). Use IDE search-first tools or switch to bounded read (offset/limit).`;
				sessionState.consecutiveLargeReadCountThisTurn = 0;
				sessionState.nearReadBlockWarningSentThisTurn = false;
				throw new Error(reason);
			}

			if (isSemanticIdeTool(effectiveToolName)) {
				sessionState.nonSymbolicStreakCountThisTurn = 0;
			} else {
				const increment = getNonSymbolicIncrement(effectiveToolName, args);
				if (increment > 0) {
					const now = Date.now();
					const cooldownElapsed =
						sessionState.lastNonSymbolicDenyAt === 0
						|| now - sessionState.lastNonSymbolicDenyAt >= NON_SYMBOLIC_DENY_COOLDOWN_MS;
					if (cooldownElapsed) {
						sessionState.nonSymbolicStreakCountThisTurn += increment;
						if (sessionState.nonSymbolicStreakCountThisTurn >= NON_SYMBOLIC_STREAK_BLOCK_THRESHOLD) {
							const reason = `Blocked ${describeNonSymbolicTool(effectiveToolName, args)} after ${sessionState.nonSymbolicStreakCountThisTurn} consecutive non-symbolic steps. Prefer JetBrains IDE index tools first (find_definition/find_references/find_file/search_text). Cooldown: ${Math.round(NON_SYMBOLIC_DENY_COOLDOWN_MS / 1000)}s.`;
							sessionState.nonSymbolicStreakCountThisTurn = 0;
							sessionState.lastNonSymbolicDenyAt = now;
							throw new Error(reason);
						}
					}
				}
			}

			if (event.tool !== "edit" && event.tool !== "write") {
				return;
			}

			const filePath = getFilePathFromToolInput(args);
			if (!filePath) {
				return;
			}

			const absolutePath = resolve(directory, filePath);
			let beforeMutation;
			try {
				beforeMutation = await tracker.beforeFileMutation(absolutePath);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				const reason = `Diagnostics preflight failed: ${message}`;
				await disableForSession(reason);
				throw new Error(
					`${reason} Extension disabled for this session — subsequent edits will proceed without index checks.`,
				);
			}

			if (beforeMutation.allowed) {
				return;
			}

			const reason = beforeMutation.reason ?? "IDE index is not ready after retries.";
			await disableForSession(reason);
			throw new Error(
				`${reason} Extension disabled for this session — subsequent edits will proceed without index checks.`,
			);
		});

		await ctx.tool.hook("execute.after", async (event) => {
			if (!extensionEnabled || indexDisabledForSession) {
				return;
			}

			if (event.status !== "completed") {
				return;
			}

			const args = asRecord(event.input) ?? {};
			const result = event.result;
			const sessionState = state.ensure(event.sessionID);

			if (event.tool === "read") {
				const unbounded = isUnboundedReadInput(args);
				const lineCount = countTextLinesFromToolResult(result);
				const isLargeRead = lineCount > LARGE_READ_LINE_THRESHOLD;

				if (!unbounded) {
					sessionState.consecutiveLargeReadCountThisTurn = 0;
					sessionState.nearReadBlockWarningSentThisTurn = false;
				} else if (isLargeRead) {
					sessionState.consecutiveLargeReadCountThisTurn += 1;
				} else {
					sessionState.consecutiveLargeReadCountThisTurn = 0;
					sessionState.nearReadBlockWarningSentThisTurn = false;
				}

				if (unbounded) {
					sessionState.unboundedReadCountThisTurn += 1;
					const reasons: string[] = [];

					if (isLargeRead) {
						reasons.push(
							`Large unbounded read detected (${lineCount} lines). Use search-first and bounded reads to minimize tokens.`,
						);
					}

					if (sessionState.unboundedReadCountThisTurn >= 2 && !sessionState.unboundedReadWarningSentThisTurn) {
						sessionState.unboundedReadWarningSentThisTurn = true;
						reasons.push(
							`You already made ${sessionState.unboundedReadCountThisTurn} unbounded reads this turn. Prefer bounded read windows (offset/limit).`,
						);
					}

					if (
						sessionState.consecutiveLargeReadCountThisTurn === LARGE_READ_CONSECUTIVE_BLOCK_THRESHOLD - 1
						&& !sessionState.nearReadBlockWarningSentThisTurn
					) {
						sessionState.nearReadBlockWarningSentThisTurn = true;
						reasons.push(
							"Hard limit warning: one more consecutive large unbounded read will be blocked. Use search-first IDE tools or a bounded read first.",
						);
					}

					if (reasons.length > 0) {
						const now = Date.now();
						if (now - sessionState.lastReadReminderAt >= NUDGE_COOLDOWN_MS) {
							sessionState.lastReadReminderAt = now;
							appendReminderWithVisibility(result, buildReadEfficiencyReminder(activeTools, reasons), [
								`Injected read-efficiency reminder after ${event.tool} (${lineCount} lines, unbounded=${unbounded ? "yes" : "no"}).`,
							]);
							void showToast(
								"warning",
								"⚠ Prefer search-first and bounded reads for token efficiency",
								"Read Efficiency",
							);
						}
					}
				}
			}

			if (event.tool === "bash") {
				const command = getBashCommand(args);
				if (command && isMoveCommand(command)) {
					const now = Date.now();
					const withinCooldown = now - sessionState.lastMoveReminderAt < NUDGE_COOLDOWN_MS;
					sessionState.lastMoveReminderAt = now;

					appendReminderWithVisibility(
						result,
						buildMoveRefactorReminder(activeTools, toCommandPreview(command)),
						[
							"Injected move-refactor reminder after detecting mv/git mv in bash command.",
							`Command: ${toCommandPreview(command)}`,
							...(withinCooldown ? [
								"Note: repeated within cooldown window; reminder still surfaced for user visibility.",
							] : []),
						],
					);
					void showToast(
						"warning",
						"⚠ Detected mv/git mv. Prefer IDE move refactor for code files",
						"Move Refactor",
					);
				}
			}

			if (event.tool !== "edit" && event.tool !== "write") {
				return;
			}

			const filePath = getFilePathFromToolInput(args);
			if (!filePath) {
				return;
			}

			const absolutePath = resolve(directory, filePath);
			try {
				appendSystemReminder(result, buildPluginVisibilityNotice([
					`Diagnostics check scheduled for edited file: ${filePath}`,
					`Will sync exactly this edited path with jetbrains_index_ide_sync_files before diagnostics.`,
					`Waiting ${Math.round(DIAGNOSTICS_POST_EDIT_DELAY_MS / 1000)}s before querying IDE diagnostics.`,
				]));

				await sleep(DIAGNOSTICS_POST_EDIT_DELAY_MS);

				const diagnosticsResult = await tracker.getNewProblems([absolutePath]);
				for (const outcome of diagnosticsResult.outcomes) {
					appendSystemReminder(result, buildDiagnosticsOutcomeNotice(outcome));
				}

				const incompleteOutcome = diagnosticsResult.outcomes.find((outcome) => outcome.status !== "checked");
				if (incompleteOutcome) {
					appendSystemReminder(result, buildPluginVisibilityNotice([
						`Diagnostics check did not complete for ${filePath}.`,
						`Status: ${incompleteOutcome.status}`,
						...(incompleteOutcome.reason ? [`Reason: ${incompleteOutcome.reason}`] : []),
					]));
					return;
				}

				if (diagnosticsResult.files.length === 0) {
					appendSystemReminder(result, buildPluginVisibilityNotice([
						`Diagnostics check completed for ${filePath}.`,
						"No new diagnostics were introduced by this edit/write.",
					]));
					return;
				}

				const newProblemCount = diagnosticsResult.files.reduce((sum, file) => sum + file.diagnostics.length, 0);
				const summary = formatDiagnosticsSummary(diagnosticsResult.files);
				appendReminderWithVisibility(result, buildNewDiagnosticsReminder(summary), [
					`Injected diagnostics reminder for edited file: ${filePath}`,
					`New diagnostics detected: ${newProblemCount}`,
				]);
				void showToast(
					"warning",
					`🔍 New JetBrains index diagnostics: ${newProblemCount} issue${newProblemCount === 1 ? "" : "s"}`,
					"Diagnostics",
				);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				appendSystemReminder(result, buildPluginVisibilityNotice([
					`Diagnostics check failed for ${filePath}.`,
					`Error: ${message}`,
				]));
			}
		});

		return () => {
			controller.abort();
			state.clearAll();
			extensionEnabled = false;
			indexDisabledForSession = false;
			tracker.reset();
			void tracker.shutdown();
		};
	},
});
