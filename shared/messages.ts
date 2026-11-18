import { z } from 'zod';

export const messageTextSchema = z.string().trim().min(1).max(4000);
export const userMessageSchema = z.object({
  id: z.string().uuid(), text: messageTextSchema, createdAt: z.number().int().nonnegative(),
}).strict();
export const userMessagesSchema = z.object({ messages: z.array(userMessageSchema) }).strict();
export type UserMessage = z.infer<typeof userMessageSchema>;
export const sendMessageSchema = z.object({
  text: messageTextSchema, userId: z.string().uuid().nullable(), confirm: z.literal(true),
  /** Also sends a notification to the subscribed devices of the recipients. */
  push: z.boolean().optional(),
}).strict();
export const sentMessageSchema = z.object({
  id: z.string().uuid(), recipients: z.number().int().positive(),
  /** Number of recipients with at least one notification device. */
  pushed: z.number().int().nonnegative().optional(),
}).strict();
export const messageIdSchema = z.object({ id: z.string().uuid() }).strict();
