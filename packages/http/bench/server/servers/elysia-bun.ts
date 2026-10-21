import { elysiaApp } from './elysia-app.ts'; import { PORT, ready } from './shared.ts';
elysiaApp().listen(PORT, ready);
