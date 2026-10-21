import { z } from 'zod';

export const PORT = Number(process.env['PORT'] ?? 3000);
export const NewItem = z.object({
  name: z.string().min(1),
  qty: z.number().int().positive(),
  tags: z.array(z.string()),
});
export const JSON_HEADERS = { 'content-type': 'application/json' };

export const ping = () => ({ ok: true });
export const user = (id: string) => ({ id, name: 'item' });
export function createItem(raw: unknown): { status: number; body: unknown } {
  const parsed = NewItem.safeParse(raw);
  if (!parsed.success) return { status: 400, body: { error: 'invalid' } };
  return { status: 200, body: { ok: true, name: parsed.data.name } };
}
export const NOT_FOUND = { status: 404, body: { error: 'not found' } };
export function ready(): void {
  process.on('SIGUSR2', () => {
    const { user, system } = process.cpuUsage();
    console.log(`CPU ${user + system}`);
  });
  console.log(`READY ${PORT}`);
}
