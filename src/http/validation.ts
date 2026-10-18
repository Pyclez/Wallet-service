import { z } from "zod";
import { InvalidRequestError } from "../shared/application/errors";

const MoneySchema = z.object({
  amount: z.string(),
  currency: z.string(),
});

export const WagerTransactionRequestSchema = z.object({
  providerId: z.string().min(1).max(64),
  externalTransactionId: z.string().min(1).max(128),
  playerId: z.uuid(),
  walletId: z.uuid(),
  roundId: z.string().min(1).max(128),
  gameId: z.string().min(1).max(128),
  kind: z.string().min(1),
  money: MoneySchema,
  referenceExternalTransactionId: z.string().min(1).max(128).optional(),
});

export const IdempotencyKeySchema = z.string().min(1).max(255);

export const WagerTransactionMessageSchema = z.object({
  messageId: z.string().min(1).max(128),
  type: z.literal("WagerTransactionRequested"),
  occurredAt: z.string(),
  data: WagerTransactionRequestSchema.extend({ idempotencyKey: IdempotencyKeySchema }),
});

export const OpenWalletRequestSchema = z.object({
  playerId: z.uuid(),
  initialBalance: MoneySchema,
});

export function parseWith<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new InvalidRequestError(
      "payload inválido",
      result.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
    );
  }
  return result.data;
}

export function assertUuid(value: string, field: string): string {
  return parseWith(z.uuid({ message: `${field} deve ser um UUID` }), value);
}
