// ── Auth validation schemas (TypeBox) ─────────────────────────────────────────

import { Type, type Static } from '@sinclair/typebox';

// ── Request schemas ──────────────────────────────────────────────────────────

export const OAuthSignInBody = Type.Object({
  provider: Type.Union([Type.Literal('github'), Type.Literal('google')]),
  redirectTo: Type.Optional(Type.String({ format: 'uri' })),
});
export type OAuthSignInBody = Static<typeof OAuthSignInBody>;

export const OAuthCallbackQuery = Type.Object({
  code: Type.String(),
  next: Type.Optional(Type.String()),
});
export type OAuthCallbackQuery = Static<typeof OAuthCallbackQuery>;

export const RefreshBody = Type.Object({
  refresh_token: Type.String(),
});
export type RefreshBody = Static<typeof RefreshBody>;

// ── Response schemas ─────────────────────────────────────────────────────────

export const AuthUrlResponse = Type.Object({
  url: Type.String({ format: 'uri' }),
});
export type AuthUrlResponse = Static<typeof AuthUrlResponse>;

export const SessionResponse = Type.Object({
  user: Type.Object({
    id: Type.String(),
    email: Type.String(),
    fullName: Type.Union([Type.String(), Type.Null()]),
    avatarUrl: Type.Union([Type.String(), Type.Null()]),
    githubUsername: Type.Union([Type.String(), Type.Null()]),
  }),
  accessToken: Type.String(),
  refreshToken: Type.String(),
  expiresAt: Type.Number(),
});
export type SessionResponse = Static<typeof SessionResponse>;

export const ProfileResponse = Type.Object({
  id: Type.String(),
  email: Type.String(),
  fullName: Type.Union([Type.String(), Type.Null()]),
  avatarUrl: Type.Union([Type.String(), Type.Null()]),
  githubUsername: Type.Union([Type.String(), Type.Null()]),
  emailDigestEnabled: Type.Boolean(),
});
export type ProfileResponse = Static<typeof ProfileResponse>;

export const UpdateProfileBody = Type.Object({
  fullName: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  avatarUrl: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  emailDigestEnabled: Type.Optional(Type.Boolean()),
});
export type UpdateProfileBody = Static<typeof UpdateProfileBody>;
