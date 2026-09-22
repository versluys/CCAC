declare global {
  interface Env {
    DB: D1Database;
    ASSETS: Fetcher;

    /** Zero Trust team: "acme" or "acme.cloudflareaccess.com". */
    CF_ACCESS_TEAM_DOMAIN: string;
    /** Application Audience (AUD) tag from the Access application. */
    CF_ACCESS_AUD: string;
    /** Optional comma-separated allow-list, e.g. "christschapelrec.org". */
    ALLOWED_EMAIL_DOMAINS?: string;

    ENVIRONMENT?: string;
    /** Honoured only when ENVIRONMENT === "development". */
    ACCESS_DEV_EMAIL?: string;
  }
}

export {};
