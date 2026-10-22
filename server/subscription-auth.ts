import { randomUUID } from 'node:crypto';
import { Firestore } from '@google-cloud/firestore';
import { GoogleAuth } from 'google-auth-library';
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex';
import { z } from 'zod';

const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
const oauth = openaiCodexProvider().auth!.oauth!;
const CredentialSchema = z.object({
  type: z.literal('oauth'), access: z.string().min(1).max(65536),
  refresh: z.string().min(1).max(16384), expires: z.number().finite().positive(),
}).passthrough();
const ClaimsSchema = z.object({ exp: z.number().finite().positive(), 'https://api.openai.com/auth': z.object({ chatgpt_account_id: z.string().min(1) }) });
type Credential = z.infer<typeof CredentialSchema>;

function tokenInfo(credential: Credential) {
  if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(credential.access)) throw new Error('Invalid subscription credential.');
  const claims = ClaimsSchema.parse(JSON.parse(Buffer.from(credential.access.split('.')[1]!, 'base64url').toString('utf8')));
  return { account: claims['https://api.openai.com/auth'].chatgpt_account_id, expires: Math.min(credential.expires, claims.exp * 1000) };
}

async function readCredential(secret: string, signal: AbortSignal): Promise<Credential> {
  const response = await auth.request<{ payload: { data: string } }>({
    url: `https://secretmanager.googleapis.com/v1/${secret}/versions/latest:access`,
    signal, timeout: 10_000, retry: false, maxContentLength: 128 * 1024,
  });
  const encoded = response.data.payload?.data;
  if (typeof encoded !== 'string' || encoded.length > 128 * 1024) throw new Error('Invalid subscription secret.');
  return CredentialSchema.parse(JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')));
}

async function resolveCredential(secret: string, deadline: number, signal: AbortSignal, caller: AbortSignal): Promise<string> {
  const checkWindow = () => {
    signal.throwIfAborted();
    if (Date.now() >= deadline) throw new Error('The subscription demo has ended.');
  };
  const usable = (credential: Credential) => tokenInfo(credential).expires > Math.min(deadline, Date.now() + 60_000);
  checkWindow();
  caller.throwIfAborted();
  const initial = await readCredential(secret, signal);
  checkWindow();
  if (usable(initial)) return initial.access;

  const projectId = process.env.FIRESTORE_PROJECT_ID;
  if (!projectId) throw new Error('Durable subscription renewal requires the hosted store.');
  const firestore = new Firestore({ projectId });
  const lease = firestore.collection('labAuth').doc('codex-refresh');
  const owner = randomUUID();
  let acquired = false;
  try {
    await firestore.runTransaction(async transaction => {
      checkWindow();
      const current = (await transaction.get(lease)).data();
      if (current && typeof current.until === 'number' && current.until > Date.now()) throw new Error('Subscription renewal is already in progress.');
      transaction.set(lease, { owner, until: Date.now() + 60_000 });
    });
    acquired = true;
    checkWindow();
    // Re-read under the lease: another instance may already have rotated the credential.
    const current = await readCredential(secret, signal);
    checkWindow();
    if (usable(current)) return current.access;
    caller.throwIfAborted();
    const renewed = CredentialSchema.parse(await oauth.refresh(current, signal));
    checkWindow();
    if (tokenInfo(renewed).account !== tokenInfo(current).account || !usable(renewed)) throw new Error('Invalid renewed subscription credential.');
    await auth.request({
      url: `https://secretmanager.googleapis.com/v1/${secret}:addVersion`, method: 'POST',
      data: { payload: { data: Buffer.from(JSON.stringify(renewed)).toString('base64') } },
      signal, timeout: 10_000, retry: false, maxContentLength: 128 * 1024,
    });
    checkWindow();
    return renewed.access;
  } finally {
    try {
      if (acquired) await firestore.runTransaction(async transaction => {
        if ((await transaction.get(lease)).data()?.owner === owner) transaction.delete(lease);
      });
    } finally { await firestore.terminate(); }
  }
}

export async function hostedSubscriptionKey(secret: string, deadline: number, signal = new AbortController().signal): Promise<string> {
  // Persist rotated credentials even when their initiating browser disconnects.
  const renewal = AbortSignal.timeout(Math.max(1, Math.min(30_000, deadline - Date.now())));
  const bounded = AbortSignal.any([signal, renewal]);
  const canceled = Promise.withResolvers<never>();
  const onAbort = () => canceled.reject(bounded.reason);
  bounded.addEventListener('abort', onAbort, { once: true });
  try {
    bounded.throwIfAborted();
    return await Promise.race([resolveCredential(secret, deadline, renewal, signal), canceled.promise]);
  } finally { bounded.removeEventListener('abort', onAbort); }
}
