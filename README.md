# Kahoot Test Helper 3.5.1 Hybrid + Host

Tampermonkey userscript for testing your own Kahoot quizzes.

The helper uses two answer sources:

1. **Verified quiz data** when Kahoot exposes current quiz metadata.
2. **Groq AI fallback** using live DOM/HTML text when verified quiz data is unavailable.

Version 3.5.1 also includes a **Host DOM Bridge**. If the player screen only shows Kahoot shapes/colors, the script can read the question and answer text from an open `play.kahoot.it` host tab and share that text with the player tab through Tampermonkey storage.

No screenshot/OCR is required for the AI fallback.

## Features

- Current-session quiz data detection
- No stale quiz/index fallback answers
- Groq AI fallback from DOM text
- Host tab -> player tab DOM bridge
- True/False support
- Standard quiz support
- Multi-select support
- Open-ended/type-answer support
- Puzzle ordering support
- Poll detection
- Answer highlighting
- Optional auto-answer
- AI auto-answer only when confidence is `HIGH`
- Debug panel
- Local AI proxy so the API key is not stored in the userscript

## Files

- `kahoot-hack.user.js` - Tampermonkey userscript
- `ai-server.mjs` - local Groq proxy server
- `start-groq-server.ps1` - Windows PowerShell launcher

## Requirements

- Microsoft Edge / Chrome
- Tampermonkey
- Node.js 18+ (Node 24 tested)
- Groq API key

## Install the userscript

1. Install Tampermonkey.
2. Open `kahoot-hack.user.js`.
3. Install/update the script in Tampermonkey.
4. Disable older Kahoot helper versions so only the latest script runs.

The userscript matches:

- `https://kahoot.it/*`
- `https://play.kahoot.it/*`

## Start the Groq server

Open PowerShell in this repository folder and run:

```powershell
.\start-groq-server.ps1
```

The launcher asks for your Groq API key if `GROQ_API_KEY` is not already set.

You can also set it manually:

```powershell
$env:GROQ_API_KEY="YOUR_GROQ_API_KEY"
$env:GROQ_MODEL="openai/gpt-oss-120b"
node .\ai-server.mjs
```

Keep the PowerShell window open while using the AI helper.

## Check the local server

Open:

```text
http://127.0.0.1:8787/health
```

Expected response:

```json
{"ok":true,"provider":"groq","model":"openai/gpt-oss-120b"}
```

## Recommended panel settings

For the first test:

- **Show answers:** ON
- **Auto answer:** OFF
- **AI fallback (DOM text):** ON
- **AI auto-answer (HIGH only):** OFF
- **Debug:** ON

After confirming the AI answers are correct, you can enable:

- **Auto answer**
- **AI auto-answer (HIGH only)**

## Host DOM Bridge

Some Kahoot player layouts show only colored shapes and do not include the question text in the player DOM.

3.5.1 solves this by using an open Kahoot host tab:

```text
play.kahoot.it host tab
        |
        | DOM question + choice text
        v
Tampermonkey shared storage
        |
        v
kahoot.it player tab
        |
        v
Groq AI fallback
```

The bridge data is short-lived and only used for the current session.

## AI behavior

The local server returns structured results for:

- `choice` - standard, True/False, and multi-select
- `text` - open-ended answers
- `puzzle` - tile ordering
- `poll` - no objectively correct answer
- `none` - insufficient text / low confidence

Automatic AI answering only runs when both:

- **Auto answer** is ON
- **AI auto-answer (HIGH only)** is ON

and the AI result has `high` confidence.

## Security

Do **not** put API keys inside `kahoot-hack.user.js` and do not commit them to GitHub.

This repository ignores common local secret files such as `.env` and `.env.local`.

If an API key has ever been posted publicly, rotate/revoke it in the provider dashboard.

## Notes

- The helper intentionally avoids random answer clicking.
- If a question depends on an image/audio and the answer cannot be inferred from DOM text, the AI should return low confidence or no answer.
- Kahoot can change its DOM/selectors, so future UI changes may require selector updates.

## Version

Current: **3.5.1 Hybrid + Host**
