# ArduPilot Param Compare

Desktop ArduPilot parameter diff tool for comparing two ArduCopter parameter
files with metadata decode, filtering, exports, and an optional OpenAI-powered
parameter assistant.

## Features

- Compare old and new `.param`, `.parm`, `.params`, `.txt`, `.cfg`, or log-style
  parameter files
- Highlight changed, added, removed, and unchanged parameters
- Decode metadata from ArduPilot `apm.pdef.json` or `apm.pdef.xml`
- Load latest ArduCopter metadata, versioned metadata, or a local metadata file
- Search and filter by parameter name, value, enum, notes, or description
- Inspect descriptions, ranges, units, enum values, bitmasks, and reboot notes
- Export the visible comparison as CSV or HTML
- Ask an optional AI assistant about selected parameters and row-level changes

## Requirements

- Node.js
- npm
- Optional: an OpenAI API key for the AI assistant

## Install

```bash
npm install
```

## Run Desktop App

```bash
npm run desktop
```

The Electron app starts the private Express backend on a random loopback port and
opens the UI in a native desktop window. The backend is an implementation detail
of the desktop app and is not intended to be run as a standalone browser server.

## Build Desktop Packages

```bash
npm run pack
npm run dist
```

`npm run pack` creates an unsigned unpacked app for local inspection in
`release/`. `npm run dist` creates the configured Windows, macOS, or Linux
package for the host platform and requires signing credentials.

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

Fetched metadata is cached in Electron's renderer storage by URL so repeat
comparisons can still work if the network is unavailable.

## AI Assistant

The AI assistant is optional. The comparison tool works without an API key.

To use it:

1. Run a comparison.
2. Open the `AI` drawer.
3. Use a saved desktop key, or enter an OpenAI API key for the current app
   session.
4. Select a parameter or add rows to `Ask about`.
5. Ask a question from the chat drawer or use a row AI action.

Saved keys are encrypted with Electron's `safeStorage` support and stored under
the app's user data directory. Unsaved keys are held in backend memory for the
current app session and cleared when you disconnect or close the app.

When AI context is prepared, the backend keeps the loaded comparison and metadata
in the local app session and exposes it to the model through structured tools.

AI context is prepared automatically after connection, after comparison changes,
and before an answer if the selected rows changed. Advanced settings are hidden
behind the drawer's settings control and include model, reasoning effort,
verbosity, maximum output tokens, service tier, temperature, web search, web
context size, and live web access.

## Environment Variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` | OpenAI-compatible API base URL |

## Project Structure

```text
.
├── app.js               # Renderer comparison UI and client-side parsing/export logic
├── desktop-key-store.js # Electron encrypted desktop settings storage
├── electron-main.js     # Electron shell that hosts the private Express backend
├── index.html           # App shell
├── server.js            # Private Express backend and AI assistant endpoints
├── styles.css           # App styling
├── tests/server.test.js
├── package.json
└── README.md
```

## Notes

- Parameter comparison and exports happen in the Electron renderer.
- AI calls and in-memory comparison context go through the private Express
  backend hosted by Electron.
- Treat AI output as assistance, not flight-safety certainty. Check important
  changes against official ArduPilot documentation, metadata, source, and
  controlled validation.
