# Vditor note editor vendor

This directory vendors Vditor 3.11.2 for the KityMinder note panel.

- `dist/` is copied from the published `vditor@3.11.2` npm package.
- `vditor-note-adapter.js` exposes `window.VditorNote.createVditorNoteEditor(host, options)`.
- Notes are still persisted as Markdown strings through the existing KityMinder note data.

Source: https://github.com/Vanessa219/vditor
License: MIT, see `LICENSE`.
