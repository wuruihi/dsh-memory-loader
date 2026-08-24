// dsh-memory-loader v1.0 — deterministic memory injection at session start.
// Injects two-level memory (global ~/.dsh/memory + project <cwd>/memory) as a
// durable user message at the first pre-step of each agent session, using the
// same seam as @deepseek-ai/dsh-agent-instructions (see PLAN.md for evidence).
//
// Mount (bundle): dsh plugin --profile web add <this-repo-tarball>   — see README.md
// Mount (single file): place next to a profile that can resolve @deepseek-ai/dsh-llm
//   (e.g. ~/.dsh/profiles/web/) and insert into that profile's cordis.patch.yml:
//   - insert:
//     - id: dsh-memory-loader
//       name: file:///<absolute-path-to>/dsh-memory-loader.mjs
//       config:
//         maxBytes: 16384
//         maxSourceBytes: 65536

import { stat, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { createUserMessage } from "@deepseek-ai/dsh-llm";

export const PLUGIN_NAME = "dsh-memory-loader";
const DEFAULT_MAX_BYTES = 16384;
const DEFAULT_MAX_SOURCE_BYTES = 65536;
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

async function readBounded(file, maxSourceBytes) {
	try {
		const info = await stat(file);
		if (!info.isFile()) return undefined;
		if (info.size > maxSourceBytes) return undefined;
		const content = await readFile(file, "utf8");
		if (byteLength(content) > maxSourceBytes) return undefined;
		return content;
	} catch {
		return undefined;
	}
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

// Budget policy mirrors agent-instructions: drop whole least-specific files
// first, then truncate the tail of the most specific kept file.
function buildFrame(loaded, maxBytes) {
	if (!Array.isArray(loaded) || loaded.length === 0) return undefined;
	const header = `Memory context ${MARKER}. Long-term and today's memory for this workspace. Use it as background knowledge; workspace instructions (AGENTS.md) take precedence over this frame.`;
	const kept = [...loaded];
	const notices = [];
	while (kept.length > 1 && byteLength(frameText(header, kept, notices)) > maxBytes) {
		const dropped = kept.shift();
		notices.push(`omitted ${dropped.label}`);
	}
	if (byteLength(frameText(header, kept, notices)) > maxBytes) {
		const last = kept[kept.length - 1];
		const truncationSuffix = "\n\n...(truncated; read the full file for the rest)";
		notices.push(`truncated ${last.label}`);
		const probe = (cut) => {
			const candidate = { ...last, content: last.content.slice(0, cut) + truncationSuffix };
			return byteLength(frameText(header, [...kept.slice(0, -1), candidate], notices)) <= maxBytes;
		};
		let lo = 0;
		let hi = last.content.length;
		if (!probe(0)) {
			// Even an empty cut overflows the budget: drop the whole file instead.
			kept.pop();
			notices[notices.length - 1] = `omitted ${last.label}`;
			if (kept.length === 0) return undefined;
		} else {
			while (lo < hi) {
				const mid = Math.ceil((lo + hi) / 2);
				if (probe(mid)) lo = mid;
				else hi = mid - 1;
			}
			kept[kept.length - 1] = { ...last, content: last.content.slice(0, lo) + truncationSuffix };
		}
	}
	return frameText(header, kept, notices);
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
	const maxBytes = Number.isSafeInteger(rawMax) && rawMax > 0 ? rawMax : DEFAULT_MAX_BYTES;
	const maxSourceBytes = Number.isSafeInteger(rawSource) && rawSource > 0 ? rawSource : DEFAULT_MAX_SOURCE_BYTES;
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
			for (const candidate of memoryCandidates(cwd, home, today)) {
				signal?.throwIfAborted?.();
				const content = await readBounded(candidate.file, maxSourceBytes);
				if (content !== undefined && content.trim().length > 0) loaded.push({ ...candidate, content });
			}
			composed.add(agent);
			if (loaded.length === 0) return decision;

			const text = buildFrame(loaded, maxBytes);
			if (text === undefined) return decision;
			const desired = createUserMessage({
				content: [{ type: "text", text }],
				source: { kind: "plugin", plugin: PLUGIN_NAME }
			});
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
	localDateString,
	escapeFrame,
	readBounded,
	memoryCandidates,
	buildFrame,
	sessionHasMarker
};
