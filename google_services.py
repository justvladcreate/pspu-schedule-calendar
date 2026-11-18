import logging
import os
from pathlib import Path
from urllib.parse import urlsplit

import httplib2
from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from google_auth_httplib2 import AuthorizedHttp
from google_auth_oauthlib.flow import InstalledAppFlow
from googleapiclient.discovery import build

logger = logging.getLogger(__name__)

# --- пути ---
BASE_DIR     = Path(__file__).resolve().parent
PRIVATE_DIR  = BASE_DIR / "private"
SHEETS_DIR   = PRIVATE_DIR / "sheets"

# --- scopes ---
SHEETS_SCOPES   = ["https://www.googleapis.com/auth/drive.readonly"]

# --- id ресурсов ---
SPREADSHEET_ID = "1_fsm-OxH9E9LgHnLC0iju5OlaHIv0agmM87GLvRKIAg"

# ---------------------------------------------------------------- proxy

def _proxy_info():
    """Прокси из окружения (ALL_PROXY / HTTPS_PROXY) для httplib2.

    Google с этого сервера доступен нестабильно, поэтому запросы к
    Sheets/Drive при необходимости идут через тот же SOCKS-туннель,
    что и Gemini. ``GOOGLE_USE_PROXY=0`` отключает это поведение.
    """
    if (os.environ.get("GOOGLE_USE_PROXY") or "").strip() in ("0", "false", "no"):
        return None

    raw = (
        os.environ.get("HTTPS_PROXY")
        or os.environ.get("https_proxy")
        or os.environ.get("ALL_PROXY")
        or os.environ.get("all_proxy")
        or ""
    ).strip()
    if not raw:
        return None

    try:
        parts = urlsplit(raw if "://" in raw else f"http://{raw}")
        scheme = (parts.scheme or "http").lower()
        host = parts.hostname
        if not host:
            return None

        if scheme.startswith("socks"):
            import socks  # PySocks

            proxy_type = (
                socks.PROXY_TYPE_SOCKS5
                if scheme.startswith("socks5")
                else socks.PROXY_TYPE_SOCKS4
            )
            port = parts.port or 1080
            rdns = scheme.endswith("h") or scheme == "socks5"
        else:
            import socks

            proxy_type = socks.PROXY_TYPE_HTTP
            port = parts.port or 8080
            rdns = True

        return httplib2.ProxyInfo(
            proxy_type=proxy_type,
            proxy_host=host,
            proxy_port=port,
            proxy_rdns=rdns,
            proxy_user=parts.username,
            proxy_pass=parts.password,
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("Не удалось разобрать прокси %r: %s", raw, exc)
        return None


def _authorized_http(creds: Credentials):
    """AuthorizedHttp с прокси, если он задан, иначе None (как раньше)."""
    proxy = _proxy_info()
    if proxy is None:
        return None
    logger.info("Google API: использую прокси %s:%s", proxy.proxy_host, proxy.proxy_port)
    return AuthorizedHttp(creds, http=httplib2.Http(proxy_info=proxy))


def _build(service: str, version: str, creds: Credentials):
    http = _authorized_http(creds)
    if http is None:
        return build(service, version, credentials=creds, cache_discovery=False)
    return build(service, version, http=http, cache_discovery=False)

# ---------------------------------------------------------------- core

def _load_credentials(credentials_file: Path, token_file: Path, scopes: list[str]) -> Credentials:
    """
    Загружает токен из token_file; если его нет / истёк — обновляет или запускает OAuth-flow.
    После успешной авторизации сохраняет токен в JSON.
    """
    creds: Credentials | None = None

    if token_file.exists():
        try:
            creds = Credentials.from_authorized_user_file(str(token_file), scopes)
        except Exception as e:
            logger.warning(f"Не удалось прочитать {token_file}: {e}. Переавторизация.")

    if not creds or not creds.valid:
        if creds and creds.expired and creds.refresh_token:
            creds.refresh(Request())
        else:
            if not credentials_file.exists():
                raise FileNotFoundError(
                    f"Нет файла credentials: {credentials_file}. "
                    f"Скачай его из Google Cloud Console (Desktop App)."
                )
            flow = InstalledAppFlow.from_client_secrets_file(str(credentials_file), scopes)
            creds = flow.run_local_server(port=0)

        token_file.parent.mkdir(parents=True, exist_ok=True)
        token_file.write_text(creds.to_json(), encoding="utf-8")

    return creds


# ---------------------------------------------------------------- public

def get_drive_service():
    """Сервис Google Drive API v3 (для скачивания Excel)."""
    creds = _load_credentials(
        credentials_file=SHEETS_DIR / "credentials.json",
        token_file=SHEETS_DIR / "token.json",
        scopes=SHEETS_SCOPES,
    )
    return _build("drive", "v3", creds)


def get_sheets_service():
    """Сервис Google Sheets API v4 (для метаданных листов)."""
    creds = _load_credentials(
        credentials_file=SHEETS_DIR / "credentials.json",
        token_file=SHEETS_DIR / "token.json",
        scopes=SHEETS_SCOPES,
    )
    return _build("sheets", "v4", creds)


def get_drive_and_sheets_services():
    """
    Оба сервиса за один проход OAuth — использует один и тот же token.json.
    Удобно, если в одном месте нужны и Drive, и Sheets: не грузим креды дважды.
    """
    creds = _load_credentials(
        credentials_file=SHEETS_DIR / "credentials.json",
        token_file=SHEETS_DIR / "token.json",
        scopes=SHEETS_SCOPES,
    )
    drive  = _build("drive",  "v3", creds)
    sheets = _build("sheets", "v4", creds)
    return drive, sheets