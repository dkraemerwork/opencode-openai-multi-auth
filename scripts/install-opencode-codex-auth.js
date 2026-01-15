#!/usr/bin/env node

import { existsSync } from "node:fs";
import { readFile, writeFile, mkdir, copyFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { parse, modify, applyEdits, printParseErrorCode } from "jsonc-parser";

const PLUGIN_NAME = "opencode-openai-multi-auth";
const args = new Set(process.argv.slice(2));

if (args.has("--help") || args.has("-h")) {
	console.log(`Usage: ${PLUGIN_NAME} [--modern|--legacy] [--uninstall] [--all] [--dry-run] [--no-cache-clear]\n\n` +
		"Default behavior:\n" +
		"  - Installs/updates global config at ~/.config/opencode/opencode.jsonc (falls back to .json)\n" +
		"  - Uses modern config (variants) by default\n" +
		"  - Ensures plugin is unpinned (latest)\n" +
		"  - Clears OpenCode plugin cache\n\n" +
		"Options:\n" +
		"  --modern           Force modern config (default)\n" +
		"  --legacy           Use legacy config (older OpenCode versions)\n" +
		"  --uninstall        Remove plugin + OpenAI config entries from global config\n" +
		"  --all              With --uninstall, also remove tokens, logs, and cached instructions\n" +
		"  --dry-run          Show actions without writing\n" +
		"  --no-cache-clear   Skip clearing OpenCode cache\n"
	);
	process.exit(0);
}

const useLegacy = args.has("--legacy");
const useModern = args.has("--modern") || !useLegacy;
const uninstallRequested = args.has("--uninstall") || args.has("--all");
const uninstallAll = args.has("--all");
const dryRun = args.has("--dry-run");
const skipCacheClear = args.has("--no-cache-clear");

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const templatePath = join(
	repoRoot,
	"config",
	useLegacy ? "opencode-legacy.json" : "opencode-modern.json"
);

const configDir = join(homedir(), ".config", "opencode");
const configPathJson = join(configDir, "opencode.json");
const configPathJsonc = join(configDir, "opencode.jsonc");
const cacheDir = join(homedir(), ".cache", "opencode");
const cacheNodeModules = join(cacheDir, "node_modules", PLUGIN_NAME);
const cacheBunLock = join(cacheDir, "bun.lock");
const cachePackageJson = join(cacheDir, "package.json");
const opencodeAuthPath = join(homedir(), ".opencode", "auth", "openai.json");
const pluginConfigPath = join(
	homedir(),
	".opencode",
	"openai-codex-auth-config.json",
);
const pluginLogDir = join(homedir(), ".opencode", "logs", "codex-plugin");
const opencodeCacheDir = join(homedir(), ".opencode", "cache");

function log(message) {
	console.log(message);
}

function normalizePluginList(list) {
	const entries = Array.isArray(list) ? list.filter(Boolean) : [];
	const filtered = entries.filter((entry) => {
		if (typeof entry !== "string") return true;
		return entry !== PLUGIN_NAME && !entry.startsWith(`${PLUGIN_NAME}@`);
	});
	return [...filtered, PLUGIN_NAME];
}

function removePluginEntries(list) {
	const entries = Array.isArray(list) ? list.filter(Boolean) : [];
	return entries.filter((entry) => {
		if (typeof entry !== "string") return true;
		if (entry === PLUGIN_NAME || entry.startsWith(`${PLUGIN_NAME}@`)) {
			return false;
		}
		return !entry.includes(PLUGIN_NAME);
	});
}

function mergeOpenAIConfig(existingOpenAI, templateOpenAI) {
	const existing = existingOpenAI && typeof existingOpenAI === "object"
		? existingOpenAI
		: {};
	const template = templateOpenAI && typeof templateOpenAI === "object"
		? templateOpenAI
		: {};
	const existingOptions =
		existing.options && typeof existing.options === "object"
			? existing.options
			: {};
	const templateOptions =
		template.options && typeof template.options === "object"
			? template.options
			: {};
	const existingModels =
		existing.models && typeof existing.models === "object"
			? existing.models
			: {};
	const templateModels =
		template.models && typeof template.models === "object"
			? template.models
			: {};

	return {
		...existing,
		...template,
		options: { ...existingOptions, ...templateOptions },
		models: { ...existingModels, ...templateModels },
	};
}

async function getKnownModelIds() {
	const legacyTemplate = await readJson(
		join(repoRoot, "config", "opencode-legacy.json"),
	);
	const modernTemplate = await readJson(
		join(repoRoot, "config", "opencode-modern.json"),
	);
	const legacyModels = Object.keys(
		legacyTemplate?.provider?.openai?.models || {},
	);
	const modernModels = Object.keys(
		modernTemplate?.provider?.openai?.models || {},
	);
	return new Set([...legacyModels, ...modernModels]);
}

function formatJson(obj) {
	return `${JSON.stringify(obj, null, 2)}\n`;
}

const JSONC_PARSE_OPTIONS = { allowTrailingComma: true, disallowComments: false };
const JSONC_FORMAT_OPTIONS = { insertSpaces: true, tabSize: 2, eol: "\n" };

function resolveConfigPath() {
	if (existsSync(configPathJsonc)) {
		return configPathJsonc;
	}
	if (existsSync(configPathJson)) {
		return configPathJson;
	}
	return configPathJsonc;
}

async function readJson(filePath) {
	const content = await readFile(filePath, "utf-8");
	return JSON.parse(content);
}

async function readJsonc(filePath) {
	const content = await readFile(filePath, "utf-8");
	const errors = [];
	const data = parse(content, errors, JSONC_PARSE_OPTIONS);
	if (errors.length) {
		const formatted = errors
			.map((error) => printParseErrorCode(error.error))
			.join(", ");
		throw new Error(`Invalid JSONC (${formatted})`);
	}
	return { content, data: data ?? {} };
}

function applyJsoncUpdates(content, updates) {
	let next = content;
	for (const update of updates) {
		const edits = modify(next, update.path, update.value, {
			formattingOptions: JSONC_FORMAT_OPTIONS,
		});
		next = applyEdits(next, edits);
	}
	return next.endsWith("\n") ? next : `${next}\n`;
}

async function backupConfig(sourcePath) {
	const timestamp = new Date()
		.toISOString()
		.replace(/[:.]/g, "-")
		.replace("T", "_")
		.replace("Z", "");
	const backupPath = `${sourcePath}.bak-${timestamp}`;
	if (!dryRun) {
		await copyFile(sourcePath, backupPath);
	}
	return backupPath;
}

async function removePluginFromCachePackage() {
	if (!existsSync(cachePackageJson)) {
		return;
	}

	let cacheData;
	try {
		cacheData = await readJson(cachePackageJson);
	} catch (error) {
		log(`Warning: Could not parse ${cachePackageJson} (${error}). Skipping.`);
		return;
	}

	const sections = [
		"dependencies",
		"devDependencies",
		"peerDependencies",
		"optionalDependencies",
	];

	let changed = false;
	for (const section of sections) {
		const deps = cacheData?.[section];
		if (deps && typeof deps === "object" && PLUGIN_NAME in deps) {
			delete deps[PLUGIN_NAME];
			changed = true;
		}
	}

	if (!changed) {
		return;
	}

	if (dryRun) {
		log(`[dry-run] Would update ${cachePackageJson} to remove ${PLUGIN_NAME}`);
		return;
	}

	await writeFile(cachePackageJson, formatJson(cacheData), "utf-8");
}

async function clearCache() {
	if (skipCacheClear) {
		log("Skipping cache clear (--no-cache-clear).");
		return;
	}

	if (dryRun) {
		log(`[dry-run] Would remove ${cacheNodeModules}`);
		log(`[dry-run] Would remove ${cacheBunLock}`);
	} else {
		await rm(cacheNodeModules, { recursive: true, force: true });
		await rm(cacheBunLock, { force: true });
	}

	await removePluginFromCachePackage();
}

async function clearPluginArtifacts() {
	if (dryRun) {
		log(`[dry-run] Would remove ${opencodeAuthPath}`);
		log(`[dry-run] Would remove ${pluginConfigPath}`);
		log(`[dry-run] Would remove ${pluginLogDir}`);
	} else {
		await rm(opencodeAuthPath, { force: true });
		await rm(pluginConfigPath, { force: true });
		await rm(pluginLogDir, { recursive: true, force: true });
	}

	const cacheFiles = [
		"codex-instructions.md",
		"codex-instructions-meta.json",
		"codex-max-instructions.md",
		"codex-max-instructions-meta.json",
		"gpt-5.1-instructions.md",
		"gpt-5.1-instructions-meta.json",
		"gpt-5.2-instructions.md",
		"gpt-5.2-instructions-meta.json",
		"gpt-5.2-codex-instructions.md",
		"gpt-5.2-codex-instructions-meta.json",
		"opencode-codex.txt",
		"opencode-codex-meta.json",
	];

	for (const file of cacheFiles) {
		const target = join(opencodeCacheDir, file);
		if (dryRun) {
			log(`[dry-run] Would remove ${target}`);
		} else {
			await rm(target, { force: true });
		}
	}
}

async function main() {
	if (!existsSync(templatePath)) {
		throw new Error(`Config template not found at ${templatePath}`);
	}

	const configPath = resolveConfigPath();
	const configExists = existsSync(configPath);

	if (uninstallRequested) {
		if (!configExists) {
			log("No existing config found. Nothing to uninstall.");
		} else {
			const backupPath = await backupConfig(configPath);
			log(`${dryRun ? "[dry-run] Would create backup" : "Backup created"}: ${backupPath}`);

			try {
				const { content, data } = await readJsonc(configPath);
				const existing = data ?? {};
				const pluginList = removePluginEntries(existing.plugin);

				const provider =
					existing.provider && typeof existing.provider === "object"
						? { ...existing.provider }
						: {};
				const openai =
					provider.openai && typeof provider.openai === "object"
						? { ...provider.openai }
						: {};

				const knownModelIds = await getKnownModelIds();
				const existingModels =
					openai.models && typeof openai.models === "object"
						? { ...openai.models }
						: {};
				for (const modelId of knownModelIds) {
					delete existingModels[modelId];
				}

				if (Object.keys(existingModels).length > 0) {
					openai.models = existingModels;
				} else {
					delete openai.models;
				}

				if (Object.keys(openai).length > 0) {
					provider.openai = openai;
				} else {
					delete provider.openai;
				}

				const updates = [];
				if (pluginList.length > 0) {
					updates.push({ path: ["plugin"], value: pluginList });
				} else {
					updates.push({ path: ["plugin"], value: undefined });
				}

				if (Object.keys(provider).length > 0) {
					updates.push({ path: ["provider"], value: provider });
				} else {
					updates.push({ path: ["provider"], value: undefined });
				}

				if (dryRun) {
					log(`[dry-run] Would write ${configPath} (uninstall)`);
				} else {
					const nextContent = applyJsoncUpdates(content, updates);
					await writeFile(configPath, nextContent, "utf-8");
					log(`Updated ${configPath} (plugin removed)`);
				}
			} catch (error) {
				log(`Warning: Could not parse existing config (${error}). Skipping config update.`);
			}
		}

		await clearCache();
		if (uninstallAll) {
			await clearPluginArtifacts();
		}

		log("\nDone. Restart OpenCode.");
		return;
	}

	const template = await readJson(templatePath);
	template.plugin = [PLUGIN_NAME];

	let nextConfig = template;
	let nextContent = null;

	if (configExists) {
		const backupPath = await backupConfig(configPath);
		log(`${dryRun ? "[dry-run] Would create backup" : "Backup created"}: ${backupPath}`);

		try {
			const { content, data } = await readJsonc(configPath);
			const existing = data ?? {};
			const merged = { ...existing };
			merged.plugin = normalizePluginList(existing.plugin);
			const provider =
				existing.provider && typeof existing.provider === "object"
					? { ...existing.provider }
					: {};
			provider.openai = mergeOpenAIConfig(provider.openai, template.provider.openai);
			merged.provider = provider;
			nextConfig = merged;

			nextContent = applyJsoncUpdates(content, [
				{ path: ["plugin"], value: merged.plugin },
				{ path: ["provider", "openai"], value: merged.provider.openai },
			]);
		} catch (error) {
			log(`Warning: Could not parse existing config (${error}). Replacing with template.`);
			nextConfig = template;
		}
	} else {
		log("No existing config found. Creating new global config.");
	}

	if (dryRun) {
		log(`[dry-run] Would write ${configPath} using ${useLegacy ? "legacy" : "modern"} config`);
	} else {
		await mkdir(configDir, { recursive: true });
		if (nextContent && configExists) {
			await writeFile(configPath, nextContent, "utf-8");
		} else {
			await writeFile(configPath, formatJson(nextConfig), "utf-8");
		}
		log(`Wrote ${configPath} (${useLegacy ? "legacy" : "modern"} config)`);
	}

	await clearCache();

	log("\nDone. Restart OpenCode to (re)install the plugin.");
	log("Example: opencode");
	if (useLegacy) {
		log("Note: Legacy config requires OpenCode v1.0.209 or older.");
	}
}

main().catch((error) => {
	console.error(`Installer failed: ${error instanceof Error ? error.message : error}`);
	process.exit(1);
});
