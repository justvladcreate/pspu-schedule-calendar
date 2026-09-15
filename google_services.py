import logging
from pathlib import Path

from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow
from googleapiclient.discovery import build

logger = logging.getLogger(__name__)

# --- пути ---
BASE_DIR     = Path(__file__).resolve().parent
PRIVATE_DIR  = BASE_DIR / "private"
CALENDAR_DIR = PRIVATE_DIR / "calendar"
SHEETS_DIR   = PRIVATE_DIR / "sheets"

# --- scopes ---
CALENDAR_SCOPES = ["https://www.googleapis.com/auth/calendar"]
SHEETS_SCOPES   = ["https://www.googleapis.com/auth/drive.readonly"]

# --- id ресурсов ---
SPREADSHEET_ID = "1_fsm-OxH9E9LgHnLC0iju5OlaHIv0agmM87GLvRKIAg"

from config import CONFIG
CALENDAR_ID = CONFIG.get("calendar_id") or "primary"
TEST_CALENDAR_ID = CONFIG.get("test_calendar_id")
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

def get_calendar_service():
    """Сервис Google Calendar API v3."""
    creds = _load_credentials(
        credentials_file=CALENDAR_DIR / "credentials.json",
        token_file=CALENDAR_DIR / "token.json",
        scopes=CALENDAR_SCOPES,
    )
    return build("calendar", "v3", credentials=creds, cache_discovery=False)


def get_drive_service():
    """Сервис Google Drive API v3 (для скачивания Excel)."""
    creds = _load_credentials(
        credentials_file=SHEETS_DIR / "credentials.json",
        token_file=SHEETS_DIR / "token.json",
        scopes=SHEETS_SCOPES,
    )
    return build("drive", "v3", credentials=creds, cache_discovery=False)


def get_sheets_service():
    """Сервис Google Sheets API v4 (для метаданных листов)."""
    creds = _load_credentials(
        credentials_file=SHEETS_DIR / "credentials.json",
        token_file=SHEETS_DIR / "token.json",
        scopes=SHEETS_SCOPES,
    )
    return build("sheets", "v4", credentials=creds, cache_discovery=False)


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
    drive  = build("drive",  "v3", credentials=creds, cache_discovery=False)
    sheets = build("sheets", "v4", credentials=creds, cache_discovery=False)
    return drive, sheets