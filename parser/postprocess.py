import re

_NAME_RE = re.compile(
    r"([А-ЯЁA-Z][а-яёa-z]+(?:-[А-ЯЁA-Z][а-яёa-z]+)?)"
    r"\s+"
    r"([А-ЯЁA-Z])\.\s*"
    r"([А-ЯЁA-Z])\.?"
)


def remove_academic_titles(text: str) -> str:
    if not text or not isinstance(text, str):
        return text

    result: list[str] = []
    seen: set[str] = set()

    for m in _NAME_RE.finditer(text):
        surname = m.group(1)
        i1 = m.group(2)
        i2 = m.group(3)
        full = f"{surname} {i1}.{i2}."
        if full not in seen:
            seen.add(full)
            result.append(full)

    return ", ".join(result)