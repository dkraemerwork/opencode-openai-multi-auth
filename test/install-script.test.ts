import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse } from 'jsonc-parser';

const SCRIPT_PATH = resolve(process.cwd(), 'scripts', 'install-opencode-codex-auth.js');

const runInstaller = (args: string[], homeDir: string) => {
	execFileSync(process.execPath, [SCRIPT_PATH, ...args], {
		env: { ...process.env, HOME: homeDir },
		stdio: 'pipe',
	});
};

const readJsoncFile = (path: string) => {
	const content = readFileSync(path, 'utf-8');
	return { content, data: parse(content) as Record<string, any> };
};

const makeHome = () => mkdtempSync(join(tmpdir(), 'opencode-install-'));

const writeConfig = (homeDir: string, file: string, content: string) => {
	const configDir = join(homeDir, '.config', 'opencode');
	mkdirSync(configDir, { recursive: true });
	const path = join(configDir, file);
	writeFileSync(path, content);
	return path;
};

describe('Install script', () => {
	it('updates existing JSONC and preserves comments', () => {
		const homeDir = makeHome();
		const configPath = writeConfig(
			homeDir,
			'opencode.jsonc',
			`{
  // My existing config
  "plugin": ["some-other-plugin@1.2.3", "opencode-openai-multi-auth@4.2.0"],
  "provider": {
    "openai": {
      "timeout": 60000,
      "models": { "custom-model": { "name": "Custom" } }
    }
  }
}`,
		);

		runInstaller(['--no-cache-clear'], homeDir);

		const { content, data } = readJsoncFile(configPath);
		expect(content).toContain('// My existing config');
		expect(data.plugin).toContain('opencode-openai-multi-auth');
		expect(data.plugin).toContain('some-other-plugin@1.2.3');
		expect(data.provider.openai.timeout).toBe(60000);
		expect(data.provider.openai.models['custom-model']).toBeDefined();
		expect(data.provider.openai.models['gpt-5.2']).toBeDefined();
	});

	it('prefers JSONC when both jsonc and json exist', () => {
		const homeDir = makeHome();
		const jsoncPath = writeConfig(
			homeDir,
			'opencode.jsonc',
			`{ "plugin": ["opencode-openai-multi-auth@4.2.0"] }`,
		);
		const jsonPath = writeConfig(
			homeDir,
			'opencode.json',
			`{ "plugin": ["should-stay"], "provider": { "openai": { "timeout": 10 } } }`,
		);
		const jsonBefore = readFileSync(jsonPath, 'utf-8');

		runInstaller(['--no-cache-clear'], homeDir);

		const { data } = readJsoncFile(jsoncPath);
		expect(data.plugin).toContain('opencode-openai-multi-auth');
		const jsonAfter = readFileSync(jsonPath, 'utf-8');
		expect(jsonAfter).toBe(jsonBefore);
	});

	it('creates JSONC when no config exists', () => {
		const homeDir = makeHome();
		runInstaller(['--no-cache-clear'], homeDir);
		const configPath = join(homeDir, '.config', 'opencode', 'opencode.jsonc');
		expect(existsSync(configPath)).toBe(true);
		const { data } = readJsoncFile(configPath);
		expect(data.plugin).toContain('opencode-openai-multi-auth');
	});

	it('uninstall removes plugin models but keeps custom config', () => {
		const homeDir = makeHome();
		const configPath = writeConfig(
			homeDir,
			'opencode.jsonc',
			`{
  "plugin": ["some-other-plugin@1.2.3", "opencode-openai-multi-auth@4.2.0"],
  "provider": {
    "openai": {
      "timeout": 60000,
      "models": {
        "custom-model": { "name": "Custom" },
        "gpt-5.2": { "name": "GPT 5.2 (OAuth)" },
        "gpt-5.2-codex": { "name": "GPT 5.2 Codex (OAuth)" }
      }
    },
    "anthropic": { "models": { "claude": { "name": "Claude" } } }
  }
}`,
		);

		runInstaller(['--uninstall', '--no-cache-clear'], homeDir);

		const { data } = readJsoncFile(configPath);
		expect(data.plugin).toEqual(['some-other-plugin@1.2.3']);
		expect(data.provider.openai.timeout).toBe(60000);
		expect(data.provider.openai.models['custom-model']).toBeDefined();
		expect(data.provider.openai.models['gpt-5.2']).toBeUndefined();
		expect(data.provider.openai.models['gpt-5.2-codex']).toBeUndefined();
		expect(data.provider.anthropic).toBeDefined();
	});

	it('uninstall --all removes plugin artifacts', () => {
		const homeDir = makeHome();
		writeConfig(
			homeDir,
			'opencode.jsonc',
			`{ "plugin": ["opencode-openai-multi-auth@4.2.0"] }`,
		);

		const opencodeDir = join(homeDir, '.opencode');
		mkdirSync(join(opencodeDir, 'auth'), { recursive: true });
		mkdirSync(join(opencodeDir, 'logs', 'codex-plugin'), { recursive: true });
		mkdirSync(join(opencodeDir, 'cache'), { recursive: true });
		writeFileSync(join(opencodeDir, 'auth', 'openai.json'), '{}');
		writeFileSync(join(opencodeDir, 'openai-codex-auth-config.json'), '{}');
		writeFileSync(join(opencodeDir, 'logs', 'codex-plugin', 'log.txt'), 'log');
		writeFileSync(join(opencodeDir, 'cache', 'codex-instructions.md'), 'cache');

		runInstaller(['--uninstall', '--all', '--no-cache-clear'], homeDir);

		expect(existsSync(join(opencodeDir, 'auth', 'openai.json'))).toBe(false);
		expect(existsSync(join(opencodeDir, 'openai-codex-auth-config.json'))).toBe(false);
		expect(existsSync(join(opencodeDir, 'logs', 'codex-plugin'))).toBe(false);
		expect(existsSync(join(opencodeDir, 'cache', 'codex-instructions.md'))).toBe(false);
	});
});
