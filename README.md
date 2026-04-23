# ArduPilot Param Compare

Static browser app for comparing two ArduCopter parameter files in an ArduPilot WebTools-style workflow.

## Run locally

From the repo root:

```bash
python -m http.server 8000
```

Then open [http://127.0.0.1:8000/](http://127.0.0.1:8000/).

## What it does

- Compares two parameter files entirely in the browser
- Loads ArduPilot metadata from the published `autotest.ardupilot.org` JSON, with XML fallback
- Supports versioned metadata such as `4.5.7`, `stable-4.5.7`, or `Copter-4.5.7`
- Highlights changed, added, removed, and unchanged parameters
- Shows descriptions on hover and in the inspector panel
- Exports filtered results as HTML or CSV

## Notes

- If remote metadata fetch is blocked or a version is unavailable, load a local `apm.pdef.json` or `apm.pdef.xml` file.
- This repo is now a static web tool rather than a desktop Python app.
