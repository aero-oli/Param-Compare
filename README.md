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
3. Enter an OpenAI API key in `Setup` and connect.
4. Focus one or more rows with the focus controls.
5. Prepare context if it has not already been prepared.
6. Ask a question from the chat tab.

The backend keeps the API key in server memory only and stores a session cookie
named `param_compare_ai_session` in the browser. Sessions expire after eight
hours or when you disconnect.

When AI context is prepared, the backend uploads summarized comparison and
metadata documents to an OpenAI vector store so the assistant can answer against
the loaded files. Disconnecting calls cleanup for the uploaded context and clears
the local session.

AI settings exposed in the drawer include model, reasoning effort, verbosity,
maximum output tokens, service tier, temperature, web search, web context size,
and live web access.

## Environment Variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8000` | Local Express server port |
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` | OpenAI-compatible API base URL |

## Project Structure

```text
.
├── app.js              # Browser comparison UI and client-side parsing/export logic
├── index.html          # App shell
├── server.js           # Express server and AI assistant endpoints
├── styles.css          # App styling
├── tests/server.test.js
├── package.json
└── README.md
```

## Notes

- Parameter comparison and exports happen in the browser.
- AI calls and vector-store setup go through the local Express server.
- Treat AI output as assistance, not flight-safety certainty. Check important
  changes against official ArduPilot documentation, metadata, source, and
  controlled validation.
