import { z } from 'zod';

const DemoSchema = z.object({
  expiresAt: z.iso.datetime(),
  credentialSecret: z.string().regex(/^projects\/[A-Za-z0-9-]+\/secrets\/[A-Za-z0-9_-]+$/),
});

export function hostedDemo() {
  if (!process.env.PUBLIC_ORIGINS?.trim() || process.env.PHYSICS_LAB_CONNECTED_GPT !== '1') return null;
  const parsed = DemoSchema.safeParse({
    expiresAt: process.env.LAB_DEMO_EXPIRES_AT,
    credentialSecret: process.env.CONNECTED_GPT_SECRET,
  });
  if (!parsed.success) throw new Error('Hosted subscription demos require an expiry and a credential secret.');
  return { ...parsed.data, deadline: Date.parse(parsed.data.expiresAt) };
}
