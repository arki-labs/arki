import { z } from '@arki/contracts';

import type { UserId } from '../types';

// Login output type
export type LoginOutput = {
  success: boolean;
  user: {
    id: UserId;
    name: string | null;
    email: string;
    image: string | null;
  };
  sessionToken: string;
};

// Registration output type
export type RegisterOutput = {
  success: boolean;
  userId: UserId;
};

// Password reset request output type
export type PasswordResetRequestOutput = {
  success: boolean;
};

// Password reset output type
export type PasswordResetOutput = {
  success: boolean;
};

// Logout output type
export type LogoutOutput = {
  success: boolean;
};

// Email verification output type
export type VerifyEmailOutput = {
  success: boolean;
};

// Profile update output type
export type UpdateProfileOutput = {
  success: boolean;
  user: {
    id: UserId;
    name: string | null;
    email: string;
    image: string | null;
  };
};

// Registration schema
export const registerSchema = z.object({
  email: z.email(),
  name: z.string().min(2).max(50),
  password: z.string().min(8).max(100),
});

export type RegisterInput = z.infer<typeof registerSchema>;

// Login schema
export const passwordLoginSchema = z.object({
  email: z.email(),
  password: z.string(),
});

export type PasswordLoginInput = z.infer<typeof passwordLoginSchema>;

// Password reset request schema
export const passwordResetRequestSchema = z.object({
  email: z.email(),
});

export type PasswordResetRequestInput = z.infer<typeof passwordResetRequestSchema>;

// Password reset schema
export const passwordResetSchema = z.object({
  token: z.string(),
  password: z.string().min(8).max(100),
});

export type PasswordResetInput = z.infer<typeof passwordResetSchema>;

// Update profile schema
export const updateProfileSchema = z.object({
  name: z.string().min(2).max(50).optional(),
  bio: z.string().max(500).optional(),
  avatarUrl: z.url().nullable().optional(),
});

export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;
