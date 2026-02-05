![Image 1: opencode-openai-multi-auth](assets/readme-hero.svg)

[![npm version](https://img.shields.io/npm/v/opencode-openai-multi-auth.svg)](https://www.npmjs.com/package/opencode-openai-multi-auth)
[![Tests](https://github.com/dkraemerwork/opencode-openai-multi-auth/actions/workflows/ci.yml/badge.svg)](https://github.com/dkraemerwork/opencode-openai-multi-auth/actions)
[![npm downloads](https://img.shields.io/npm/dm/opencode-openai-multi-auth.svg)](https://www.npmjs.com/package/opencode-openai-multi-auth)

# Multi-Account ChatGPT OAuth for OpenCode

**Use multiple ChatGPT Plus/Pro personal or organization accounts with OpenCode. Never hit rate limits again.**

```
┌────────────────────────────────────────────────────────────────┐
│                                                                │
│   Account 1 (rate limited) ──┐                                 │
│   Account 2 (rate limited) ──┼──► Auto-rotate ──► Keep coding  │
│   Account 3 (available) ─────┘                                 │
│                                                                │
└────────────────────────────────────────────────────────────────┘
```

## Why Multi-Account?

| Problem | Solution |
|---------|----------|
| Hit ChatGPT rate limits while coding | Add multiple accounts, auto-rotate when limited |
| Team members share one subscription | Each person adds their own account |
| Different orgs have separate subscriptions | Use accounts from multiple organizations |
| One account gets throttled | Seamlessly switch to next available account |

---

## Quick Start

```bash
# Install
npx -y opencode-openai-multi-auth@latest

# Add your first account
opencode auth login
# Select "ChatGPT Plus/Pro (Codex Subscription)"

# Add more accounts (optional but recommended)
opencode auth login
# Select "Add Another OpenAI Account"

# Start coding - accounts rotate automatically on rate limits
opencode run "write hello world to test.txt" --model=openai/gpt-5.2 --variant=medium
```

---

## How Multi-Account Works

### Adding Accounts

```bash
# First account
opencode auth login
# → Select "ChatGPT Plus/Pro (Codex Subscription)"
# → Browser opens, login with ChatGPT
# → Account saved

# Second account (different email/org)
opencode auth login
# → Select "Add Another OpenAI Account"
# → Login with different ChatGPT account
# → Account added to rotation pool

# Repeat for as many accounts as you have
```

### Automatic Rotation

When you hit a rate limit:

1. Plugin detects 429 (rate limited) response
2. Marks current account as limited for that model
3. Switches to next available account
4. Retries your request automatically
5. Shows toast notification: `Switched to account2@example.com`

### Account Selection Strategies

| Strategy | Behavior | Best For |
|----------|----------|----------|
| `sticky` (default) | Stay with one account until rate limited | Single user, predictable usage |
| `round-robin` | Rotate through accounts on each request | Distribute load evenly |
| `hybrid` | Sticky within session, rotate across sessions | Multiple terminal sessions |

Set via environment variable:
```bash
OPENCODE_OPENAI_STRATEGY=round-robin opencode run "task"
```

### Team Usage

Each team member can add their own ChatGPT account:

```bash
# Developer 1 adds their account
opencode auth login  # logs in as dev1@company.com

# Developer 2 adds their account  
opencode auth login  # → "Add Another OpenAI Account" → dev2@company.com

# Developer 3 adds their account
opencode auth login  # → "Add Another OpenAI Account" → dev3@company.com
```

All accounts are pooled - when one person's account is rate limited, the plugin uses the next available.

---

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `OPENCODE_OPENAI_QUIET=1` | Disable toast notifications | Off |
| `OPENCODE_OPENAI_DEBUG=1` | Enable debug logging | Off |
| `OPENCODE_OPENAI_STRATEGY` | Account selection strategy | `sticky` |
| `OPENCODE_OPENAI_PID_OFFSET=1` | Offset account selection by PID | Off |

---

## Account Management

### View Accounts
```bash
cat ~/.config/opencode/openai-accounts.json | jq '.accounts[] | {email, planType}'
```

### Remove All Accounts
```bash
rm ~/.config/opencode/openai-accounts.json
```

### Check Rate Limit Status
```bash
cat ~/.config/opencode/openai-accounts.json | jq '.accounts[] | {email, rateLimitResets}'
```

### Slash Commands (TUI)
```text
/codex-status
```
Shows usage status for all configured accounts.

---

## Models

All GPT-5.2 and GPT-5.1 models with reasoning variants:

- **gpt-5.2** (none/low/medium/high/xhigh)
- **gpt-5.2-codex** (low/medium/high/xhigh)
- **gpt-5.1-codex-max** (low/medium/high/xhigh)
- **gpt-5.1-codex** (low/medium/high)
- **gpt-5.1-codex-mini** (medium/high)
- **gpt-5.1** (none/low/medium/high)

Note: The model selector reflects what the ChatGPT OAuth backend advertises. API-only models (like gpt-5-mini/nano) may not appear until the backend exposes them.

---

## Configuration

- **Modern** (OpenCode v1.0.210+): `config/opencode-modern.json`
- **Legacy** (v1.0.209 and below): `config/opencode-legacy.json`

```bash
# Modern install
npx -y opencode-openai-multi-auth@latest

# Legacy install
npx -y opencode-openai-multi-auth@latest --legacy

# Uninstall
npx -y opencode-openai-multi-auth@latest --uninstall
```

---

## Features

- **Multi-account rotation** - Add unlimited ChatGPT accounts, auto-rotate on rate limits
- **Per-model rate tracking** - Each model's limits tracked separately per account
- **Toast notifications** - Visual feedback when accounts switch
- **OAuth authentication** - Same secure flow as official Codex CLI
- **22 model presets** - All GPT-5.2/5.1 variants pre-configured
- **Automatic token refresh** - Never manually re-authenticate
- **Multimodal support** - Image input enabled for all models

---

## Documentation

- [Getting Started](docs/getting-started.md)
- [Configuration Guide](docs/configuration.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Architecture](docs/development/ARCHITECTURE.md)

---

## Credits

**Maintained by [ZenysTX](https://x.com/zenysTX)**
**Original implementation by [Numman Ali](https://x.com/nummanali)**
**Inspired by [opencode-google-antigravity-auth](https://github.com/shekohex/opencode-google-antigravity-auth)**

[![Twitter Follow](https://img.shields.io/twitter/follow/zenysTX?style=social)](https://x.com/zenysTX)
[![Twitter Follow](https://img.shields.io/twitter/follow/nummanali?style=social)](https://x.com/nummanali)

---

## Usage Notice

This plugin is for **personal development use** with your own ChatGPT Plus/Pro subscriptions.
