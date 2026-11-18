// Cloudflare Worker: прокси к Google AI Studio (Gemini).
//
// Зачем: Google отклоняет запросы с адресов, которые считает
// неподдерживаемыми («User location is not supported for the API use»),
// в том числе с части VPS-хостингов. Запросы из Cloudflare Google
// принимает, поэтому парсер на hp-server ходит в Gemini через этот воркер.
//
// Использование:
//   GEMINI_API_BASE=https://gemini-proxy.<account>.workers.dev
// Путь (/v1beta/...), query и заголовки, включая x-goog-api-key,
// пересылаются в Google как есть. Ключ в воркере не хранится.

const UPSTREAM = 'https://generativelanguage.googleapis.com';
const BUILD = 'gemini-proxy 1';

export default {
    async fetch(request) {
        const url = new URL(request.url);

        if (url.pathname === '/' || url.pathname === '/health') {
            return json({ ok: true, build: BUILD, upstream: UPSTREAM });
        }

        if (!url.pathname.startsWith('/v1beta/')) {
            return json({ error: 'not found', hint: 'use /v1beta/...' }, 404);
        }

        // Без ключа запрос всё равно не пройдёт, но так воркер нельзя
        // использовать как открытый релей для посторонних.
        if (!request.headers.get('x-goog-api-key')) {
            return json({ error: 'missing x-goog-api-key' }, 403);
        }

        const target = new URL(url.pathname + url.search, UPSTREAM);

        const headers = new Headers(request.headers);
        for (const name of [
            'host',
            'cf-connecting-ip',
            'cf-ipcountry',
            'cf-ray',
            'cf-visitor',
            'x-forwarded-proto',
            'x-real-ip',
        ]) {
            headers.delete(name);
        }

        const init = { method: request.method, headers, redirect: 'follow' };
        if (request.method !== 'GET' && request.method !== 'HEAD') {
            init.body = request.body;
        }

        let response;
        try {
            response = await fetch(target, init);
        } catch (error) {
            return json({ error: 'upstream failed', detail: String(error) }, 502);
        }

        const out = new Headers(response.headers);
        out.set('x-proxy-build', BUILD);
        return new Response(response.body, {
            status: response.status,
            headers: out,
        });
    },
};

function json(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { 'content-type': 'application/json; charset=utf-8' },
    });
}
