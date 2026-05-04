# Security Policy

## Supported Versions

Security fixes are handled for the current public release line. If you are
using an older build, update to the latest release before reporting an issue
unless the issue reproduces there too.

## Reporting a Vulnerability

Please report security issues privately by opening a GitHub security advisory
for this repository, or by contacting the project maintainer directly if
advisories are not available on the repository.

Do not publish proof-of-concept exploit details publicly until the issue has
been triaged and a fix or mitigation is available.

Helpful reports include:

- The affected app version and operating system.
- Exact steps to reproduce the issue.
- Whether the issue involves local parameter files, metadata loading, saved
  OpenAI API keys, exports, or AI requests.
- Any relevant logs or screenshots with secrets removed.

## Secret Handling

Never include real OpenAI API keys, private parameter files, or flight logs in
public issues. If a reproduction needs sensitive files, describe the shape of
the data first so the maintainer can suggest a safer way to share it.
