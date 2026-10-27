import pytest

from parser.sources import cloud_mail


HTML = '''
<script>
window.cloudSettings={"request":{"weblink":"folder/01_test.xlsx"}};
"weblink_get":{"count":"1","url":"https://cloclo.example/public/token/g/no"};
</script>
'''


def test_resolve_public_file(monkeypatch):
    monkeypatch.setattr(cloud_mail, "_request", lambda url, **kw: HTML)
    weblink, base = cloud_mail.resolve_public_file(
        "https://cloud.mail.ru/public/folder/01_test.xlsx"
    )
    assert weblink == "folder/01_test.xlsx"
    assert base == "https://cloclo.example/public/token/g/no"


def test_download_rejects_html(monkeypatch, tmp_path):
    monkeypatch.setattr(cloud_mail, "_request", lambda url, **kw: HTML)
    monkeypatch.setattr(cloud_mail, "_remote_meta", lambda weblink: None)
    # Вторая загрузка (бинарная) отдаёт HTML, а не ZIP.
    calls = {"n": 0}

    def fake_request(url, *, binary=False, timeout=90):
        if binary:
            return b"<html>not xlsx</html>"
        return HTML

    monkeypatch.setattr(cloud_mail, "_request", fake_request)
    with pytest.raises(ValueError, match="не XLSX"):
        cloud_mail.download_public_xlsx(
            "https://cloud.mail.ru/public/folder/01_test.xlsx",
            tmp_path / "01.xlsx",
        )


def test_download_writes_zip(monkeypatch, tmp_path):
    monkeypatch.setattr(cloud_mail, "_remote_meta", lambda weblink: None)

    def fake_request(url, *, binary=False, timeout=90):
        return HTML if not binary else b"PK\x03\x04fake-xlsx"

    monkeypatch.setattr(cloud_mail, "_request", fake_request)
    target = tmp_path / "01.xlsx"
    result = cloud_mail.download_public_xlsx(
        "https://cloud.mail.ru/public/folder/01_test.xlsx",
        target,
    )
    assert result == target
    assert target.read_bytes().startswith(b"PK")
