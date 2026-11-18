# config.py
import os
import logging
import sys
from pathlib import Path

import yaml

BASE_DIR = Path(__file__).resolve().parent


def load_env_file(path: Path | str = BASE_DIR / "private" / ".env"):
    if not Path(path).exists():
        return
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            os.environ[key] = value


def load_config_from_yaml(path: Path | str = BASE_DIR / "config.yaml"):
    with open(path, "r", encoding="utf-8") as file:
        raw_yaml = file.read()
        for key, value in os.environ.items():
            raw_yaml = raw_yaml.replace(f"${{{key}}}", value)
        config = yaml.safe_load(raw_yaml)
    return config


def setup_logging(logs_file: str = "info.log"):
    """Логи в файл ``data/<logs_file>`` и в stdout (systemd/journal, консоль).

    Вывод в stdout отключается ``LOG_TO_CONSOLE=0`` — например, если
    журнал не нужен и не хочется дублировать строки.
    """
    log_path = BASE_DIR / "data" / logs_file
    log_path.parent.mkdir(parents=True, exist_ok=True)

    if log_path.exists() and log_path.stat().st_size > 1024 * 10:
        log_path.write_text("", encoding="utf-8")

    formatter = logging.Formatter(
        "%(asctime)s\t| %(levelname)s\t| %(name)s\t| %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )

    handlers: list[logging.Handler] = []
    file_handler = logging.FileHandler(log_path, encoding="utf-8")
    file_handler.setFormatter(formatter)
    handlers.append(file_handler)

    if (os.environ.get("LOG_TO_CONSOLE") or "").strip() not in ("0", "false", "no"):
        stream = logging.StreamHandler(sys.stdout)
        stream.setFormatter(formatter)
        handlers.append(stream)

    logging.basicConfig(level=logging.INFO, handlers=handlers, force=True)


setup_logging()

load_env_file()
CONFIG = load_config_from_yaml()
