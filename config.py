# config.py
import os
import logging
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


# ... setup_logging тоже поправь ...

def setup_logging(logs_file: str = "info.log"):
    log_path = BASE_DIR / "data" / logs_file
    log_path.parent.mkdir(parents=True, exist_ok=True)

    logging.basicConfig(
        level=logging.INFO,
        encoding="utf-8",
        filename=log_path,
        format="%(asctime)s\t| %(levelname)s\t| %(name)s\t| %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )
    if log_path.exists() and log_path.stat().st_size > 1024 * 10:
        log_path.write_text("", encoding="utf-8")


setup_logging()

load_env_file()
CONFIG = load_config_from_yaml()
