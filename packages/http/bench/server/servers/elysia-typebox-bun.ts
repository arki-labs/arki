import { elysiaTypeboxApp } from './elysia-app.ts'; import { PORT, ready } from './shared.ts';
elysiaTypeboxApp().listen(PORT, ready);
