# Security Policy

## Supported versions

Only the latest release receives security fixes. Please update to the latest version from the [Releases page](https://github.com/dxvro/WorldFoundry/releases) before reporting, and check that the problem still exists there.

## Reporting a vulnerability

Please do not report security problems in public issues, discussions or pull requests.

Use GitHub's private vulnerability reporting instead:

1. Open <https://github.com/dxvro/WorldFoundry/security/advisories/new> (or go to the **Security** tab of the repository and click **Report a vulnerability**).
2. Describe the problem, the affected version and how to reproduce it. Include logs or proof-of-concept code if you have them, but no real passwords or tokens.

If you cannot use GitHub, you can send the report by email to <worldfoundry0@gmail.com> instead. GitHub private vulnerability reporting is preferred, because it keeps the report, the discussion and the fix together. Do not put real passwords or tokens in an email either.

You will get a reply as soon as possible. After the problem is confirmed, a fix is prepared in a private advisory and released together with a security advisory. Please give a reasonable time to fix the problem before you publish details.

## Scope and deployment notes

WorldFoundry is meant for a home network or another trusted network. The web interface is unencrypted (HTTP) and can start programs, so it must never be exposed directly to the internet (see [docs/CONFIGURATION.md](docs/CONFIGURATION.md)). Reports about exposing the web port to the internet are therefore a deployment problem, not a vulnerability. Weaknesses that work inside the intended setup (authentication, path handling, archive imports, updates and their signatures) are in scope.
