# ChatGPT DOM Virtualizer

CDV is a userscript that makes long ChatGPT conversations stay usable.

In practice, it keeps only a small live portion of the chat mounted in the page, stores older turns locally, and reloads them when needed so the page does not become slow or visually bloated.

## What it is

- It is a userscript, not a browser extension.
- It runs only on `chatgpt.com` and `chat.openai.com`.
- It runs in your browser, on your machine.
- It does not change ChatGPT itself or the answers it generates.

## What it does

- Keeps a compact live tail of the conversation on screen.
- Virtualizes older turns by replacing them with lightweight placeholders, then restores them when needed.
- Stores turn snapshots locally in the browser so they can be restored later.
- Keeps a floating diagnostics panel in the bottom-right corner.
- Helps ChatGPT stay responsive on long threads and image-heavy chats.

## What it does not do

- It does not send your conversation to another service.
- It does not replace ChatGPT or its UI.
- It does not change your account, model, or prompts.
- It does not make ChatGPT faster on its own; it mainly reduces DOM bloat on very long threads.

## How it looks

- Small green dot in the bottom-right: compact launcher.
- Click it once: open the compact panel.
- Click `Detalhes`: show the diagnostic details.
- Click `Atualizar`: ask CDV to rescan the current chat.
- Click `Ir ao fim`: jump to the latest visible turn.

## Install

1. Install a userscript manager such as Tampermonkey or Violentmonkey.
2. Install `chatgpt-dom-virtualizer.user.js` into that manager.
3. Open ChatGPT normally and let the script attach.

### Chrome / Chromium note

If you are using Chrome or Chromium and the manager shows a screen like the one in your screenshot:

1. Open `chrome://extensions`.
2. Turn on `Developer mode` if the browser is hiding advanced extension controls.
3. Open the userscript manager details.
4. Enable `Allow user scripts` / `Permitir scripts do utilizador` if it is currently off.

You do **not** need to load this repo as an unpacked extension. The only file you normally install is the userscript itself.

## License

MIT. See [LICENSE](./LICENSE).
