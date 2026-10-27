# parser/ai.py
import os

from ollama import AsyncClient

OLLAMA_HOST = os.environ.get('OLLAMA_HOST', 'http://localhost:11434')


async def ask_ai(prompt: str = '', model: str = 'gemma4:31b-cloud') -> list[str]:
    # cloud api client
    client = AsyncClient(
        host=OLLAMA_HOST,
        headers={'Authorization': 'Bearer ' + os.environ.get('OLLAMA_API_KEY')}
    )

    messages = [
        {
            'role': 'user',
            'content': prompt
        },
    ]
    response = await client.chat(model, messages=messages)

    return response['message']['content'].split("\n")