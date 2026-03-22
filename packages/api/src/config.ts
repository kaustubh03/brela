// ── Environment configuration ────────────────────────────────────────────────
// Reads from process.env with sensible defaults for development.

function required(key: string): string {
  const value = process.env[key];
  if (!value) {
    console.log(process.env.SUPABASE_URL);

    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

function optional(key: string, fallback: string): string {
  return process.env[key] ?? fallback;
}

export const config = {
  // ── Server ──────────────────────────────────────────────────────────────────
  port: parseInt(optional('PORT', '3001'), 10),
  host: optional('HOST', '0.0.0.0'),
  nodeEnv: optional('NODE_ENV', 'development'),
  get isDev() {
    return this.nodeEnv === 'development';
  },
  get isProd() {
    return this.nodeEnv === 'production';
  },

  // ── Supabase ────────────────────────────────────────────────────────────────
  supabase: {
    get url() {
      return required('SUPABASE_URL');
    },
    get anonKey() {
      return required('SUPABASE_ANON_KEY');
    },
    get serviceRoleKey() {
      return required('SUPABASE_SERVICE_ROLE_KEY');
    },
  },

  // ── Email / SMTP ────────────────────────────────────────────────────────────
  smtp: {
    host: optional('SMTP_HOST', ''),
    port: parseInt(optional('SMTP_PORT', '587'), 10),
    user: optional('SMTP_USER', ''),
    pass: optional('SMTP_PASS', ''),
    from: optional('SMTP_FROM', 'noreply@brela.dev'),
  },

  // ── App URLs ────────────────────────────────────────────────────────────────
  appUrl: optional('APP_URL', 'http://localhost:3000'),
  apiUrl: optional('API_URL', 'http://localhost:3001'),
} as const;
