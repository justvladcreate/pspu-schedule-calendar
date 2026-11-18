"""Google API через SOCKS-прокси: разбор настроек и отключение."""
import google_services


def _clear(monkeypatch):
    for name in (
        "HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy", "GOOGLE_USE_PROXY",
    ):
        monkeypatch.delenv(name, raising=False)


def test_socks_proxy(monkeypatch):
    _clear(monkeypatch)
    monkeypatch.setenv("ALL_PROXY", "socks5h://127.0.0.1:1080")

    info = google_services._proxy_info()

    assert info is not None
    assert info.proxy_host == "127.0.0.1"
    assert info.proxy_port == 1080
    assert info.proxy_rdns is True


def test_http_proxy(monkeypatch):
    _clear(monkeypatch)
    monkeypatch.setenv("HTTPS_PROXY", "http://proxy.example:8080")

    info = google_services._proxy_info()

    assert info is not None
    assert info.proxy_host == "proxy.example"
    assert info.proxy_port == 8080


def test_no_proxy_settings(monkeypatch):
    _clear(monkeypatch)
    assert google_services._proxy_info() is None


def test_proxy_can_be_disabled(monkeypatch):
    _clear(monkeypatch)
    monkeypatch.setenv("ALL_PROXY", "socks5h://127.0.0.1:1080")
    monkeypatch.setenv("GOOGLE_USE_PROXY", "0")

    assert google_services._proxy_info() is None


def test_authorized_http_without_proxy(monkeypatch):
    _clear(monkeypatch)
    assert google_services._authorized_http(creds=None) is None
