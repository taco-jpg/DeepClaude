# DeepClaude — Claude‑skin overlay for chat.deepseek.com

> Transform DeepSeek’s interface into a full‑featured, dark/light Claude.ai clone.  
> DeepSeek’s auth, streaming, and API keep running underneath – the script just wraps it with Anthropic’s design, model mapping, and quality‑of‑life tools.

![Claude Dark Skin](https://img.shields.io/badge/theme-dark%20%2F%20light-1F1F1E?logo=claude)  
![DeepSeek](https://img.shields.io/badge/under%20the%20hood-DeepSeek-4A6A9C)  
![Userscript](https://img.shields.io/badge/Tampermonkey%20%7C%20Violentmonkey-ready-0046A3)

## ✨ What it does

- **Complete visual replacement** – Hides DeepSeek’s DOM and paints a pixel‑perfect Claude.ai interface (sidebar, chat bubbles, input dock, model menu, incognito mode, etc.).
- **Full model & effort mapping** –  
  `Opus 4.8` → `deepseek-reasoner` + thinking  
  `Sonnet 4.6` → `deepseek-chat` + optional thinking  
  `Haiku 4.5` → `deepseek-chat` (no thinking, fast)
- **Effort levels** (Low / Medium / High / Extra / Max) – inject reasoning intensity prompts and toggle DeepThink automatically.
- **System prompts per model** – Separate role directives for Opus / Sonnet / Haiku.
- **Web search toggle** – Mirrors DeepSeek’s web search switch.
- **Real‑time message mirroring** – Streamed tokens appear instantly, with full Markdown + KaTeX + table support.
- **Message actions** – Copy / Retry / Edit (branching) / Version arrows (‹ N/M ›).
- **Sidebar integration** – Recents list (rename / pin / delete from context menu).
- **Chats history panel** – Full‑page searchable conversation list (⌘/Ctrl+K style).
- **Incognito / temporary chat** – One‑click ghost mode; chats are auto‑deleted on exit/reload.
- **System prompt editor** – Per‑model, prepended as a hidden persona directive.
- **Dark / Light / System theme** – Follows DeepSeek’s theme or override manually.
- **Favicon & title rewriting** – Shows Claude’s sparkle icon and “... - Claude” tab name.

## 🚀 Installation

1. **Install a userscript manager**  
   [Tampermonkey](https://www.tampermonkey.net/) (Chrome, Firefox, Edge, Safari)  
   [Violentmonkey](https://violentmonkey.github.io/) (Chrome, Firefox)

2. **Add the script**  
   - **Drag & drop** `deepseek-model-router.user.js` onto your extensions page, or  
   - Click “Create a new script” and paste the full content.

3. **Visit** `https://chat.deepseek.com/` – the interface will instantly turn into Claude.

> ✅ The script persists your preferences (model, effort, thinking, web search, system prompts, theme) across reloads.

## 🧩 Usage

### Model selector
- Click the model button (e.g. “Sonnet 4.6 · High”) near the send icon.  
- Pick **Opus / Sonnet / Haiku**.  
- Hover “Effort” for a sub‑menu – choose intensity.  
- Toggle **Thinking** on/off.

### Web search
- Press the **`+`** button left of the textarea → “Web search”.

### System prompts
- Sidebar → **“System prompt”** (pencil icon).  
- Edit per model independently. Saved instantly.

### Incognito chat
- Top‑right ghost button (`👻`).  
- Turns the whole app into a rounded frame with “Incognito chat” bar.  
- No conversation is saved – exiting deletes the session.

### Message toolbar
- Hover any **user or assistant bubble** to reveal:  
  **Copy** · **Retry** (regenerate) · **Edit** (user messages) · **Version arrows** (when multiple branches exist).

### Sidebar & Recents
- **New chat** – starts a fresh conversation.  
- **Chats** – opens the full‑page history panel (searchable).  
- **Code / Write / Learn** – shortcuts that pre‑fill the input.

### Account menu
- Click your avatar at the bottom left.  
- Switch theme, open DeepSeek’s settings / help / download, or log out.

## ⌨️ Keyboard shortcuts

| Key                       | Action                                  |
| ------------------------- | --------------------------------------- |
| `Enter`                   | Send message                            |
| `Shift + Enter`           | New line                                |
| `⌘ / Ctrl + K`            | Open the searchable Chats panel         |
| `⌘ / Ctrl + Shift + O`    | New chat                                |
| `Esc`                     | Close any open menu / panel             |

## 🎨 Theme behaviour

The script respects DeepSeek’s theme setting (light/dark/system) by default.  
Override manually via the **account menu** → “Light mode” / “Dark mode”.

## ⚠️ Notes

- The script **does not** alter your DeepSeek account, API keys, or data. It only overlays and bridges the UI.
- All messages are still processed by DeepSeek’s models – the mapping simply changes which internal model is called.
- Some DeepSeek‑specific features (e.g. “Upload image” text extraction) work fine but appear as native Claude‑style file chips.
- If you see any styling glitches, try reloading the page – the script re‑applies its CSS instantly.

## 🔧 Troubleshooting

| Problem                          | Likely fix                                       |
| -------------------------------- | ------------------------------------------------ |
| Script doesn’t load              | Check Tampermonkey is enabled and the script’s `@match` is `*://chat.deepseek.com/*`. |
| Messages not appearing           | Wait 1–2 seconds – DeepSeek’s virtual list may be lazy‑loading. Scroll up slightly. |
| Model selector has no effect     | Open browser console – verify no fetch interception errors. The script rewrites API bodies. |
| Theme doesn’t match system       | Toggle “Light mode” once from the account menu, then set back to “Auto”. |
| Incognito bar stays after exit   | Refresh the page – the temporary session is cleaned up on load. |

## 📄 License

MIT – feel free to fork and adapt.

---

**Built with** ❤️ for Anthropic’s design and DeepSeek’s powerful models.  
*Not affiliated with Anthropic or DeepSeek.*
