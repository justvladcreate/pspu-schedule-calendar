import asyncio

import parser.ai as ai_module
from parser.prompts import USER_PROMPT


def test_prompt_has_input_placeholder():
    rendered = USER_PROMPT.format(data="[1] Физическая культура")
    assert "[1] Физическая культура" in rendered
    assert "[<enumerator>]" in rendered


def test_ask_ai_splits_response(monkeypatch):
    class FakeClient:
        def __init__(self, *args, **kwargs):
            pass

        async def chat(self, model, messages):
            return {"message": {"content": "[1];-;-;-;-;A;лек.;-;Y;-\n[1];-;-;-;-;B;прак.;-;Y;-"}}

    monkeypatch.setattr(ai_module, "AsyncClient", FakeClient)
    lines = asyncio.run(ai_module.ask_ai("prompt"))
    assert lines == [
        "[1];-;-;-;-;A;лек.;-;Y;-",
        "[1];-;-;-;-;B;прак.;-;Y;-",
    ]
