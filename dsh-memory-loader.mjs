// dsh-memory-loader v1.3 — deterministic memory injection at session start.
// Injects two-level memory (global ~/.dsh/memory + project <cwd>/memory) as a
// durable user message at the first pre-step of each agent session, using the
// same seam as @deepseek-ai/dsh-agent-instructions (see PLAN.md for evidence).
//
// Mount (DSH 0.1.x, web profile) — ~/.dsh/profiles/web/cordis.patch.yml
//   - insert:
//     - id: dsh-memory-loader
//       name: file:///C:/Users/wurui/.dsh/profiles/web/dsh-memory-loader/dsh-memory-loader.mjs
//       config:
//         maxBytes: 16384
//         maxSourceBytes: 65536
//         dailyLogMode: pointer
//         dailyLogMaxBytes: 4096
//
// Mount (DSH 0.2.0 desktop GUI) — installed as a bundle into the app-owned
// "desktop" profile through the sidebar Plugins page (local absolute path);
// it lands in ~/.dsh/profiles/desktop/node_modules as a link to this repo, so
// an edit here is the installed plugin after a desktop-app restart.
//
// v1.3.1 — session format v4 fix: the injected message must carry a
// producer-owned source kind (`plugin:dsh-memory-loader`). v1.3.0 wrote the
// retired `{ kind: "plugin", plugin }` wrapper, which DSH 0.2.0 refuses with
// "format v4 message requires a producer-owned source kind" — every session
// failed while the plugin was mounted in the desktop profile.
//
// Content policy (what deserves a slot in *every* session): MEMORY.md indexes
// are pointers by nature and are injected whole; day logs are push-only flow
// records whose reader is the curator, not the working session — so by default
// (dailyLogMode: pointer) only a one-line pointer is injected and the body is
// read on demand. dailyLogMode: full restores v1.2 behaviour (byte-capped body),
// "off" drops day logs entirely.
//
// Budget policy: daily logs are reduced first (pointer by default, capped body
// in "full") so a long day log can never evict a MEMORY.md; then whole
// least-specific files are dropped; only then is the tail of the most specific
// kept file truncated.

import { stat, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { createUserMessage } from "@deepseek-ai/dsh-llm";

export const PLUGIN_NAME = "dsh-memory-loader";
// Producer-owned source kind for the injected message. DSH 0.2.0 (session format
// v4) refuses the retired `kind: "plugin"` wrapper; non-bundled producers are
// named `plugin:<package name>` — the same kind the v3→v4 migration assigns to
// the rows this plugin wrote under 0.1.x, so migrated and fresh rows agree.
export const SOURCE_KIND = `plugin:${PLUGIN_NAME}`;
const DEFAULT_MAX_BYTES = 16384;
const DEFAULT_MAX_SOURCE_BYTES = 65536;
const DEFAULT_DAILY_LOG_MAX_BYTES = 4096;
const DEFAULT_DAILY_LOG_MODE = "pointer";
const DAILY_LOG_MODES = new Set(["pointer", "full", "off"]);
const TRUNCATION_SUFFIX = "\n\n...(truncated; read the full file for the rest)";
const DAILY_LOG_LABEL = /(^|\/)\d{4}-\d{2}-\d{2}\.md$/;
const MEMORY_DIR = "memory";
const MARKER = "auto-loaded by dsh-memory-loader";
const FRAME_OPEN = "<system-reminder>";
const FRAME_CLOSE = "</system-reminder>";
const FRAME_CLOSE_ESCAPED = "<\\/system-reminder>";

function localDateString(now = new Date()) {
	const y = now.getFullYear();
	const m = String(now.getMonth() + 1).padStart(2, "0");
	const d = String(now.getDate()).padStart(2, "0");
	return `${y}-${m}-${d}`;
}

function escapeFrame(text) {
	return String(text).split(FRAME_CLOSE).join(FRAME_CLOSE_ESCAPED);
}

function byteLength(text) {
	return Buffer.byteLength(text, "utf8");
}

function isDailyLog(label) {
	return DAILY_LOG_LABEL.test(String(label));
}

function normalizeDailyLogMode(value) {
	if (typeof value !== "string") return undefined;
	const mode = value.trim().toLowerCase();
	return DAILY_LOG_MODES.has(mode) ? mode : undefined;
}

// One log entry = one markdown bullet line (the write-side discipline), so the
// pointer can tell the model how much happened today without injecting any of it.
function countLogEntries(content) {
	let count = 0;
	for (const line of String(content).split(/\r?\n/)) {
		if (/^-\s+\S/.test(line)) count += 1;
	}
	return count;
}

function humanBytes(bytes) {
	return bytes >= 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${bytes} B`;
}

// Pointer form: the day file stays discoverable (deterministic knowledge that it
// exists and where), while its body is paid for only when a session actually
// needs it.
function dailyLogPointer(content) {
	const entries = countLogEntries(content);
	const size = humanBytes(byteLength(content));
	const scale = entries > 0 ? `${entries} 条 / ${size}` : size;
	return `（当日日志未注入正文：${scale}。需要回顾今天发生了什么时，用 read 工具读取本文件全文。）`;
}

// Byte-accurate head cut: the kept text plus `suffix` is at most `limit` bytes,
// which matters because one CJK character is three UTF-8 bytes.
function truncateToBytes(text, limit, suffix = TRUNCATION_SUFFIX) {
	const source = String(text);
	if (byteLength(source) <= limit) return source;
	const candidate = (cut) => source.slice(0, cut) + suffix;
	if (byteLength(candidate(0)) > limit) return "";
	let lo = 0;
	let hi = source.length;
	while (lo < hi) {
		const mid = Math.ceil((lo + hi) / 2);
		if (byteLength(candidate(mid)) <= limit) lo = mid;
		else hi = mid - 1;
	}
	return candidate(lo);
}

// Distinguishes "absent" from "present but over the per-file ceiling" so an
// oversized memory file leaves a visible notice instead of vanishing silently.
async function readBoundedDetailed(file, maxSourceBytes) {
	try {
		const info = await stat(file);
		if (!info.isFile()) return { state: "absent" };
		if (info.size > maxSourceBytes) return { state: "oversized", bytes: info.size };
		const content = await readFile(file, "utf8");
		if (byteLength(content) > maxSourceBytes) return { state: "oversized", bytes: byteLength(content) };
		return { state: "ok", content };
	} catch {
		return { state: "absent" };
	}
}

async function readBounded(file, maxSourceBytes) {
	const result = await readBoundedDetailed(file, maxSourceBytes);
	return result.state === "ok" ? result.content : undefined;
}

// Broad → specific: global long-term, global today, project long-term, project today.
function memoryCandidates(cwd, home, today) {
	return [
		{ file: path.join(home, ".dsh", MEMORY_DIR, "MEMORY.md"), label: `~/.dsh/${MEMORY_DIR}/MEMORY.md` },
		{ file: path.join(home, ".dsh", MEMORY_DIR, `${today}.md`), label: `~/.dsh/${MEMORY_DIR}/${today}.md` },
		{ file: path.join(cwd, MEMORY_DIR, "MEMORY.md"), label: `${MEMORY_DIR}/MEMORY.md` },
		{ file: path.join(cwd, MEMORY_DIR, `${today}.md`), label: `${MEMORY_DIR}/${today}.md` }
	];
}

function sectionText(entry) {
	return `Memory from: ${escapeFrame(entry.label)}\n\n${escapeFrame(entry.content.trim())}`;
}

function frameText(header, entries, notices) {
	const parts = [FRAME_OPEN, header];
	if (notices.length > 0) parts.push(`Budget notice: ${notices.join("; ")}`);
	for (const entry of entries) parts.push(sectionText(entry));
	parts.push(FRAME_CLOSE);
	return parts.join("\n\n");
}

// Budget policy: cap daily logs first (so they can never evict a MEMORY.md),
// then drop whole least-specific files, then truncate the tail of the most
// specific kept file. `options.notices` seeds externally detected problems
// (for example a memory file skipped for exceeding maxSourceBytes).
function buildFrame(loaded, maxBytes, options = {}) {
	const entries = Array.isArray(loaded) ? loaded : [];
	const rawDaily = Number(options?.dailyLogMaxBytes);
	const dailyLogMaxBytes = Number.isSafeInteger(rawDaily) && rawDaily > 0 ? rawDaily : DEFAULT_DAILY_LOG_MAX_BYTES;
	const dailyLogMode = normalizeDailyLogMode(options?.dailyLogMode) ?? DEFAULT_DAILY_LOG_MODE;
	const notices = Array.isArray(options?.notices) ? [...options.notices] : [];
	if (entries.length === 0 && notices.length === 0) return undefined;
	const dailyNote = dailyLogMode === "pointer"
		? "daily logs are not injected; this frame only points at the day file, read it when you need today's detail"
		: dailyLogMode === "off"
			? "daily logs are not injected"
			: `daily logs are capped at ${dailyLogMaxBytes} bytes when injected`;
	const header = `Memory context ${MARKER}. Long-term and today's memory for this workspace. Use it as background knowledge; workspace instructions (AGENTS.md) take precedence over this frame.\nDiscipline: when a session ends with substantive output, append a one-line summary to today's log under this workspace's memory directory (file name YYYY-MM-DD.md with today's local date; create the file if absent; skip for trivial sessions). Keep each log entry to one line and move long detail into a named topic file under memory/: ${dailyNote}. For curating durable facts into MEMORY.md the user says「沉淀」which triggers the memory-keeper skill.`;
	const kept = [];
	for (const entry of entries) {
		if (!isDailyLog(entry.label)) {
			kept.push(entry);
			continue;
		}
		if (dailyLogMode === "off") continue;
		if (dailyLogMode === "pointer") {
			kept.push({ ...entry, content: dailyLogPointer(entry.content) });
			continue;
		}
		if (byteLength(entry.content) <= dailyLogMaxBytes) {
			kept.push(entry);
			continue;
		}
		notices.push(`capped ${entry.label} to ${dailyLogMaxBytes} bytes (daily log)`);
		kept.push({ ...entry, content: truncateToBytes(entry.content, dailyLogMaxBytes) });
	}
	if (kept.length === 0) return notices.length > 0 ? frameText(header, kept, notices) : undefined;
	while (kept.length > 1 && byteLength(frameText(header, kept, notices)) > maxBytes) {
		const dropped = kept.shift();
		notices.push(`omitted ${dropped.label}`);
	}
	if (kept.length > 0 && byteLength(frameText(header, kept, notices)) > maxBytes) {
		const last = kept[kept.length - 1];
		notices.push(`truncated ${last.label}`);
		const probe = (cut) => {
			const candidate = { ...last, content: last.content.slice(0, cut) + TRUNCATION_SUFFIX };
			return byteLength(frameText(header, [...kept.slice(0, -1), candidate], notices)) <= maxBytes;
		};
		let lo = 0;
		let hi = last.content.length;
		if (!probe(0)) {
			// Even an empty cut overflows the budget: drop the whole file instead.
			kept.pop();
			notices[notices.length - 1] = `omitted ${last.label}`;
			if (kept.length === 0) return notices.length > 0 ? frameText(header, kept, notices) : undefined;
		} else {
			while (lo < hi) {
				const mid = Math.ceil((lo + hi) / 2);
				if (probe(mid)) lo = mid;
				else hi = mid - 1;
			}
			kept[kept.length - 1] = { ...last, content: last.content.slice(0, lo) + TRUNCATION_SUFFIX };
		}
	}
	return frameText(header, kept, notices);
}

// Producer attribution of the injected message. v1.3.0 wrote the retired
// `{ kind: "plugin", plugin }` wrapper; DSH 0.2.0's session format v4 refuses
// that shape ("format v4 message requires a producer-owned source kind"), so the
// source kind names the producer itself and the `plugin` field is gone.
function injectionMessage(text) {
	return createUserMessage({
		content: [{ type: "text", text }],
		source: { kind: SOURCE_KIND }
	});
}

// Marker-absent injection rule: one mechanism covers fresh sessions, resume,
// non-fork subagents (they *should* get memory), and fork-type inheritance.
function sessionHasMarker(agent) {
	try {
		const session = agent?.session;
		const nodes = session?.surface?.nodes;
		if (!Array.isArray(nodes)) return false;
		for (const seq of nodes.slice(-400)) {
			const event = session?.events?.[seq];
			if (event?.type !== "user/message") continue;
			const content = event?.data?.content;
			if (!Array.isArray(content)) continue;
			for (const block of content) {
				if (typeof block?.text === "string" && block.text.includes(MARKER)) return true;
			}
		}
	} catch {
		// history surface unavailable → accept possible bounded duplication
	}
	return false;
}

export function apply(ctx, config = {}) {
	const rawMax = Number(config?.maxBytes);
	const rawSource = Number(config?.maxSourceBytes);
	const rawDaily = Number(config?.dailyLogMaxBytes);
	const maxBytes = Number.isSafeInteger(rawMax) && rawMax > 0 ? rawMax : DEFAULT_MAX_BYTES;
	const maxSourceBytes = Number.isSafeInteger(rawSource) && rawSource > 0 ? rawSource : DEFAULT_MAX_SOURCE_BYTES;
	const dailyLogMaxBytes = Number.isSafeInteger(rawDaily) && rawDaily > 0 ? rawDaily : DEFAULT_DAILY_LOG_MAX_BYTES;
	const dailyLogMode = normalizeDailyLogMode(config?.dailyLogMode) ?? DEFAULT_DAILY_LOG_MODE;
	const composed = new WeakSet();

	ctx.on("agent/pre-step", async ({ agent, messages, signal }, next) => {
		const decision = await next();
		try {
			if (decision?.kind !== "enter" || !Array.isArray(decision.messages) || decision.messages.length === 0) return decision;
			if (composed.has(agent)) return decision;
			if (sessionHasMarker(agent)) {
				composed.add(agent);
				return decision;
			}
			const cwd = agent?.session?.header?.cwd;
			if (typeof cwd !== "string" || cwd.length === 0) return decision;
			signal?.throwIfAborted?.();

			const today = localDateString();
			const home = homedir();
			const loaded = [];
			const notices = [];
			for (const candidate of memoryCandidates(cwd, home, today)) {
				signal?.throwIfAborted?.();
				const result = await readBoundedDetailed(candidate.file, maxSourceBytes);
				if (result.state === "oversized") {
					notices.push(`skipped ${candidate.label} (${result.bytes} bytes > maxSourceBytes ${maxSourceBytes})`);
					continue;
				}
				if (result.state !== "ok") continue;
				if (result.content.trim().length === 0) continue;
				loaded.push({ ...candidate, content: result.content });
			}
			composed.add(agent);
			if (loaded.length === 0 && notices.length === 0) return decision;

			const text = buildFrame(loaded, maxBytes, { dailyLogMaxBytes, dailyLogMode, notices });
			if (text === undefined) return decision;
			const desired = injectionMessage(text);
			const lastClaimedIndex = decision.messages.findLastIndex((message) => messages.includes(message));
			return {
				kind: "enter",
				messages: decision.messages.toSpliced(lastClaimedIndex + 1, 0, desired)
			};
		} catch (error) {
			try {
				ctx?.logger?.warn?.(`${PLUGIN_NAME}: ${error?.message ?? error}`);
			} catch {}
			return decision;
		}
	});
}

export const __internals = {
	MARKER,
	SOURCE_KIND,
	injectionMessage,
	DEFAULT_DAILY_LOG_MAX_BYTES,
	DEFAULT_DAILY_LOG_MODE,
	TRUNCATION_SUFFIX,
	localDateString,
	escapeFrame,
	isDailyLog,
	normalizeDailyLogMode,
	countLogEntries,
	dailyLogPointer,
	truncateToBytes,
	readBounded,
	readBoundedDetailed,
	memoryCandidates,
	buildFrame,
	sessionHasMarker
};
