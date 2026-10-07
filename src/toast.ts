export type ToastVariant = "info" | "success" | "warning" | "error";

/**
 * V2 notification fallback.
 *
 * The V1 implementation published `{type: "tui.toast.show"}` through
 * `client.tui.publish`. That channel has no confirmed equivalent in the V2
 * plugin API (the V2 context exposes no TUI domain), so notifications fall
 * back to best-effort console logging. Logging never throws and never blocks
 * the edit/write gating path.
 */
const VARIANT_PREFIX: Record<ToastVariant, string> = {
	info: "ℹ️",
	success: "✅",
	warning: "⚠️",
	error: "❌",
};

function formatLogMessage(variant: ToastVariant, message: string, title?: string): string {
	const scope = title ? `[JetBrains Index: ${title}]` : "[JetBrains Index]";
	return `${VARIANT_PREFIX[variant]} ${scope} ${message}`;
}

/**
 * Show a best-effort notification via console logging.
 * Never throws; safe to call with `void` from hook paths.
 */
export async function showToast(
	variant: ToastVariant,
	message: string,
	title?: string,
): Promise<void> {
	try {
		const formatted = formatLogMessage(variant, message, title);
		if (variant === "warning" || variant === "error") {
			console.warn(formatted);
		} else {
			console.info(formatted);
		}
	} catch {
		// Silently ignore — notification is best-effort, not critical path.
	}
}

/**
 * Show a diagnostics-related notification with a summary of new problems.
 * Strips XML tags from the message for clean log display.
 */
export async function showDiagnosticsToast(summary: string, filePath?: string): Promise<void> {
	const cleanSummary = stripXmlTags(summary);
	const title = filePath ? `Diagnostics: ${filePath}` : "New Diagnostics";

	await showToast("warning", cleanSummary, title);
}

/**
 * Show an info notification for plugin status updates.
 */
export async function showInfoToast(message: string, title?: string): Promise<void> {
	await showToast("info", message, title);
}

function stripXmlTags(text: string): string {
	return text
		.replace(/<\/?system-reminder>/g, "")
		.replace(/<\/?new-diagnostics>/g, "")
		.replace(/\[Plugin Visibility Notice\]/g, "")
		.replace(/\[Plugin Injected Reminder Content\]/g, "")
		.replace(/^- /gm, "")
		.trim();
}
