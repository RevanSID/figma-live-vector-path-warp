# Contributing

## Local setup

```bash
npm install
npm run typecheck
npm run build
```

Import `manifest.json` into Figma as a development plugin. The plugin uses the committed `dist/` output, so rebuild after source changes.

## Pull requests

- Keep changes focused on one behavior or bug.
- Describe how the change affects vector geometry and paint handling.
- Include a minimal reproduction for path or stroke issues.
- Do not commit `node_modules`, credentials, local Figma exports, or generated screenshots.
- Keep the plugin independent of network services and API keys.
