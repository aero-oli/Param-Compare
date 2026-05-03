# ArduPilot Param Compare

Browser-based ArduPilot parameter diff tool for comparing two ArduCopter
parameter files with metadata decode, filtering, exports, and an optional
OpenAI-powered parameter assistant.

## Features

- Compare old and new `.param`, `.parm`, `.params`, `.txt`, `.cfg`, or log-style
  parameter files in the browser
- Highlight changed, added, removed, and unchanged parameters
- Decode metadata from ArduPilot `apm.pdef.json` or `apm.pdef.xml`
- Load latest ArduCopter metadata, versioned metadata, or a local metadata file
- Search and filter by parameter name, value, enum, notes, or description
- Inspect descriptions, ranges, units, enum values, bitmasks, and reboot notes
- Export the visible comparison as CSV or HTML
- Focus selected parameters and ask an optional AI assistant about the loaded
  comparison context

## Requirements

- Node.js with built-in `fetch`, `FormData`, and `Blob` support
- npm
- Optional: an OpenAI API key for the AI assistant

## Install

```bash
npm install
```

## Run Locally

```bash
npm start
```

Then open [http://127.0.0.1:8000/](http://127.0.0.1:8000/).

To use a different port:

```bash
PORT=8080 npm start
```

## Run as a Desktop App

```bash
npm run desktop
```

The Electron app starts the existing Express server on a random local loopback
port and opens it in a native desktop window.

Desktop builds can remember the optional OpenAI API key on the current device.
Saved keys are encrypted with Electron's `safeStorage` support and stored under
the app's user data directory. The browser version still keeps pasted keys in
backend memory only.

## Build Desktop Packages

```bash
npm run pack
npm run dist
```

`npm run pack` creates an unpacked app for local inspection. `npm run dist`
creates the configured Windows, macOS, or Linux package for the host platform in
`release/`.

For public signed releases, provide platform signing credentials through
electron-builder's standard environment variables before running `npm run dist`.
Windows builds use the NSIS target. macOS builds use hardened runtime and require
Developer ID signing plus notarization credentials for distribution outside a
development machine.

## Run Tests

```bash
npm test
```

## Comparison Workflow

1. Select the old parameter file and the new parameter file.
2. Leave metadata on the default latest ArduCopter source, enter a version/ref,
   or choose a local metadata file.
3. Optionally enter ignored parameter names such as `FORMAT_VERSION` or
   `LOG_LASTFILE`.
4. Click `Compare files`.
5. Search, filter, inspect rows, and export the visible results as needed.

## Metadata Sources

By default the app loads:

```text
https://autotest.ardupilot.org/Parameters/ArduCopter/apm.pdef.json
```

If you enter a version such as `4.5.7`, `stable-4.5.7`, or `Copter-4.5.7`, the
app uses ArduPilot's versioned Copter metadata URL template. If JSON metadata is
unavailable, it tries the matching XML fallback.

You can also load a local `apm.pdef.json` or `apm.pdef.xml` file. Local metadata
is useful when remote fetching is blocked, when a published version is missing,
or when comparing against custom firmware metadata.

Fetched metadata is cached in browser `localStorage` by URL so repeat
comparisons can still work if the network is unavailable.

## AI Assistant

The AI assistant is optional. The comparison tool works without an API key.

To use it:

1. Run a comparison.
2. Open the `AI` drawer.
3. Connect with the server's `OPENAI_API_KEY`, or enter a temporary OpenAI API
   key for the local session.
4. Select a parameter or add rows to `Ask about`.
5. Ask a question from the chat drawer.

The backend keeps the API key in server memory only and stores a session cookie
named `param_compare_ai_session` in the browser. Sessions expire after eight
hours or when you disconnect.

When AI context is prepared, the backend keeps the loaded comparison and metadata
in the local session and exposes it to the model through structured tools.

AI context is prepared automatically after connection, after comparison changes,
and before an answer if the selected rows changed. Advanced settings are hidden
behind the drawer's settings control and include model, reasoning effort,
verbosity, maximum output tokens, service tier, temperature, web search, web
context size, and live web access.

## Environment Variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8000` | Local Express server port |
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` | OpenAI-compatible API base URL |
| `OPENAI_API_KEY` | unset | Optional server-side key for one-click local AI setup |

## Project Structure

```text
.
├── app.js              # Browser comparison UI and client-side parsing/export logic
├── desktop-key-store.js # Electron encrypted desktop settings storage
├── electron-main.js    # Electron shell that hosts the local Express app
├── index.html          # App shell
├── server.js           # Express server and AI assistant endpoints
├── styles.css          # App styling
├── tests/server.test.js
├── package.json
└── README.md
```

## Notes

- Parameter comparison and exports happen in the browser.
- AI calls and in-memory comparison context go through the local Express server.
- Treat AI output as assistance, not flight-safety certainty. Check important
  changes against official ArduPilot documentation, metadata, source, and
  controlled validation.
