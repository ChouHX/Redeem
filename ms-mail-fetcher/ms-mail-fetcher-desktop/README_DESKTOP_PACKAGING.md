# MS Mail Fetcher Desktop Packaging (Windows)

## 1. Install dependencies

At repo root, install desktop packaging dependencies:

```bash
pip install -r ms-mail-fetcher-desktop/requirements.txt
```

## 2. Build frontend assets

Desktop runtime serves static files from:

- `ms-mail-fetcher-desktop/template/index.html`

Recommended one-click script from repo root:

```bash
build_desktop.bat
```

## 3. Run desktop app locally (dev verify)

```bash
python ms-mail-fetcher-desktop/desktop_main.py
```

This will:

- start embedded FastAPI on `127.0.0.1` with available port
- open pywebview desktop window

## 4. Package with PyInstaller

```bash
cd ms-mail-fetcher-desktop
python -m PyInstaller --clean ms-mail-fetcher-desktop.spec
```

Output:

- `ms-mail-fetcher-desktop/dist/ms-mail-fetcher/ms-mail-fetcher.exe`

## 5. Runtime config

Desktop executable reads config from:

- `ms-mail-fetcher-desktop/server.config.json`

Main fields:

- `port`
- `auto_port_fallback`
- `port_retry_count`

## 6. Data location

User data is persisted under:

- `%LOCALAPPDATA%/ms-mail-fetcher/ms_mail_fetcher.db`
- `%LOCALAPPDATA%/ms-mail-fetcher/ui_preferences.json`
- `%LOCALAPPDATA%/ms-mail-fetcher/webview2/`

So app upgrades do not overwrite user data.

