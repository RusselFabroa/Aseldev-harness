# @deepseek-ai/dsh-client-ui-artifacts

AselDev addition. Live previews like Claude's artifacts:

- **Chat card** for the `artifact` tool: title, type, version, Open and Download (later versions show a compact "updated to version N" row).
- **Artifacts button** in the sidebar launcher list (under Asel's Brain) with the artifact count.
- **Viewer**: versions, Preview / Code, desktop / phone width, Copy code, Download, Open in a new tab. Pages load in an iframe from the host's `/aseldev-artifacts/view/…` route, which is served with a `Content-Security-Policy: sandbox` header and loaded without `allow-same-origin`, so a page cannot reach the harness, its API or your sign-ins.
- **Library**: every saved artifact, filtered by type and searched by title.

This package is presentation only. The `artifact` tool, the version store (`$DSH_HOME/artifacts`) and the page routes live in the host plugin `aseldev-plugins/artifacts/host.ts`, loaded from the profile patch.

## Model Experience

This browser package adds nothing to model requests. The host plugin adds one tool, `artifact` (create/update an HTML, Markdown, SVG or Mermaid artifact); its schema and description join every agent's tool list, and each call's full content is part of the logged tool arguments.
