# ChatGPT DOM Virtualizer

CDV is a userscript for ChatGPT that keeps a compact live viewport, virtualizes the conversation DOM, and stores turn snapshots so the page stays usable even on long threads.

## What it is

- It is a userscript, not a browser extension.
- It runs only on `chatgpt.com` and `chat.openai.com`.
- It keeps ChatGPT usable on long threads by virtualizing older turns.

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
