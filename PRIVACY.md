# Privacy

ArduPilot Param Compare is a desktop app for comparing local ArduPilot
parameter files. The comparison itself runs locally in the app.

## Local Files

Selected parameter files and local metadata files are read by the app on your
computer. They are used to build the comparison table, inspector details,
exports, and optional AI context. The app does not upload these files unless you
choose to use the AI assistant.

## Metadata Fetching

By default, the app fetches ArduPilot parameter metadata from the configured
metadata URL. The default source is ArduPilot's public autotest metadata. Fetched
metadata may be cached in the app renderer storage by URL so repeat comparisons
can work when the network is unavailable.

## OpenAI Assistant

The AI assistant is optional. If you connect it with an OpenAI API key, the app
sends your question and relevant comparison context to the configured OpenAI API
base URL. That context can include parameter names, old and new values, decoded
values, metadata descriptions, selected/focused rows, file names, metadata
source, and firmware/version references.

The default OpenAI API base URL is:

```text
https://api.openai.com/v1
```

You can override it with the `OPENAI_BASE_URL` environment variable before
starting the app.

## OpenAI API Keys

If you enter an API key without saving it, the key is kept in backend memory for
the current app session and cleared when you disconnect or close the app.

If you choose to remember the key, the desktop app stores it under the app's
user data directory using Electron `safeStorage` encryption when that feature is
available on your operating system. You can clear the saved key from the app's
AI settings.

## Exports

CSV and HTML exports are created locally from the currently visible comparison
rows. You control where those exported files are saved.

## Flight Safety

AI output is assistance, not flight-safety authority. Check important parameter
changes against official ArduPilot documentation, firmware metadata, source
code, and controlled validation before flight.
