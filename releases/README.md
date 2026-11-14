# MConnect Desktop releases

Keep the public release manifest here. The backend exposes the stable download
route at `/download/windows` and redirects to the installer listed in
`windows.json`.

The Windows installer is published as an asset on the backend GitHub repository's
GitHub Release, rather than committed here. The current installer is about 122 MB,
which exceeds GitHub's 100 MB per-file limit for ordinary Git pushes.

For a new desktop release:

1. Build the installer from the frontend with `npm run build:windows`.
2. Upload `desktop/release/MConnect-Setup-<version>.exe` to a GitHub Release on
   `amanikbt2/MoiConnect`.
3. Update `windows.json` with the release version, filename, size, SHA-256, and
   latest-download URL, then deploy the backend.
4. Update the About page's desktop version metadata if the displayed version
   changes.
