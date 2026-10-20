import { z } from 'zod';

export const VERIFICATION_SECONDS = 0.5;
export const VerificationReceiptSchema = z.strictObject({
  checkedThroughSeconds: z.number().finite().min(VERIFICATION_SECONDS).max(VERIFICATION_SECONDS + 0.001),
});
export type VerificationReceipt = z.infer<typeof VerificationReceiptSchema>;
