![Image 1: opencode-openai-multi-auth](assets/readme-hero.svg)

**Maintained by [ZenysTX](https://x.com/zenysTX)**
**Most of the work and original implementation by [Numman Ali](https://x.com/nummanali)**
**Inspired by [opencode-google-antigravity-auth](https://github.com/shekohex/opencode-google-antigravity-auth)**
[![Twitter Follow](https://img.shields.io/twitter/follow/zenysTX?style=social)](https://x.com/zenysTX)





[![Twitter Follow](https://img.shields.io/twitter/follow/nummanali?style=social)](https://x.com/nummanali)
[![npm version](https://img.shields.io/npm/v/@zenystx-org/opencode-openai-multi-auth.svg)](https://www.npmjs.com/package/@zenystx-org/opencode-openai-multi-auth)
[![Tests](https://github.com/dkraemerwork/opencode-openai-multi-auth/actions/workflows/ci.yml/badge.svg)](https://github.com/dkraemerwork/opencode-openai-multi-auth/actions)
[![npm downloads](https://img.shields.io/npm/dm/@zenystx-org/opencode-openai-multi-auth.svg)](https://www.npmjs.com/package/@zenystx-org/opencode-openai-multi-auth)
**One install. Every Codex model. Multi-account ready.**
[Install](#-quick-start) · [Models](#-models) · [Configuration](#-configuration) · [Docs](#-docs)

---

## 💡 Philosophy

> **"One config. Every model."**
> OpenCode should feel effortless. This plugin keeps the setup minimal while giving you full GPT‑5.x + Codex access via ChatGPT OAuth across multiple accounts
> from different organizations.

```
┌─────────────────────────────────────────────────────────┐
│                                                         │
│  ChatGPT OAuth → Codex backend → OpenCode               │
│  One command install, full model presets, done.         │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

---

## 🚀 Quick Start

```bash
npx -y @zenystx-org/opencode-openai-multi-auth@latest
```

Then:

```bash
opencode auth login
opencode run "write hello world to test.txt" --model=openai/gpt-5.2 --variant=medium
```

Legacy OpenCode (v1.0.209 and below):

```bash
npx -y opencode-openai-multi-auth@latest --legacy
opencode run "write hello world to test.txt" --model=openai/gpt-5.2-medium
```

Uninstall:

```bash
npx -y opencode-openai-multi-auth@latest --uninstall
npx -y opencode-openai-multi-auth@latest --uninstall --all
```

---

## 📦 Models

- **gpt-5.2** (none/low/medium/high/xhigh)
- **gpt-5.2-codex** (low/medium/high/xhigh)
- **gpt-5.1-codex-max** (low/medium/high/xhigh)
- **gpt-5.1-codex** (low/medium/high)
- **gpt-5.1-codex-mini** (medium/high)
- **gpt-5.1** (none/low/medium/high)

---

## 🧩 Configuration

- Modern (OpenCode v1.0.210+): `config/opencode-modern.json`
- Legacy (OpenCode v1.0.209 and below): `config/opencode-legacy.json`

Minimal configs are not supported for GPT‑5.x; use the full configs above.
---

## ✅ Features

- **Multi-account support** with automatic rotation on rate limits
- ChatGPT Plus/Pro OAuth authentication (official flow)
- 22 model presets across GPT‑5.2 / GPT‑5.2 Codex / GPT‑5.1 families
- Variant system support (v1.0.210+) + legacy presets
- Multimodal input enabled for all models
- Toast notifications for account switches and rate limits
- Usage‑aware errors + automatic token refresh

---

## 🔄 Multi-Account Support

Add multiple ChatGPT accounts and automatically rotate between them when rate limited:

```bash
# Add first account
opencode auth login
# Select "ChatGPT Plus/Pro (Codex Subscription)"

# Add additional accounts
opencode auth login
# Select "Add Another OpenAI Account"
```

**Features:**
- Automatic rotation when an account hits rate limits
- Per-model rate limit tracking
- Toast notifications showing active account
- Seamless failover between accounts
- Imports existing tokens from OpenCode auth

**Environment Variables:**
| Variable | Description |
|----------|-------------|
| `OPENCODE_OPENAI_QUIET=1` | Disable toast notifications |
| `OPENCODE_OPENAI_DEBUG=1` | Enable debug logging |
| `OPENCODE_OPENAI_STRATEGY` | Account selection: `sticky` (default), `round-robin`, `hybrid` |

**Accounts storage:** `~/.config/opencode/openai-accounts.json`

---

## 📚 Docs

- Getting Started: `docs/getting-started.md`
- Configuration: `docs/configuration.md`
- Troubleshooting: `docs/troubleshooting.md`
- Architecture: `docs/development/ARCHITECTURE.md`

---

## ⚠️ Usage Notice

This plugin is for **personal development use** with your own ChatGPT Plus/Pro subscriptions.

**Built for developers who value simplicity.**
