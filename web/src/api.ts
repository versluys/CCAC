/**
 * API client. Cloudflare Access sits in front of every request, so there is
 * no token to manage here: the browser already carries the Access cookie.
 * A 403 means the session lapsed and the page needs a reload to re-challenge.
 */

import type {
  Attender, Candidate, Centroid, Contact, DataQuality, Growth, Household, Note, Weights,
} from './types';

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const resp = await fetch(path, {
    ...init,
    headers: { ...(init?.body ? { 'Content-Type': 'application/json' } : {}), ...(init?.headers ?? {}) },
  });
  if (!resp.ok) {
    let message = `${resp.status} ${resp.statusText}`;
    try {
      const body = (await resp.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(message, resp.status);
  }
  return (await resp.json()) as T;
}

export const api = {
  me: () => call<{ email: string; environment: string }>('/api/me'),

  households: () =>
    call<{
      households: Household[];
      attenders: Attender[];
      summary: Record<string, number>;
      privacy_note: string;
    }>('/api/households'),

  centroids: () => call<{ default_method: string | null; centroids: Centroid[] }>('/api/centroids'),

  dataQuality: () => call<DataQuality>('/api/data-quality'),

  driveShare: (lat: number, lon: number) =>
    call<{ bands: Record<string, { share: number; count: number; total: number }>; source: string }>(
      `/api/drive-share?lat=${lat}&lon=${lon}`,
    ),

  candidates: (params: Record<string, string> = {}) => {
    const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v));
    return call<{ count: number; candidates: Candidate[] }>(
      `/api/candidates${qs.toString() ? `?${qs}` : ''}`,
    );
  },

  candidate: (id: string) =>
    call<{ candidate: Candidate; notes: Note[]; contacts: Contact[] }>(
      `/api/candidates/${encodeURIComponent(id)}`,
    ),

  createCandidate: (body: Record<string, unknown>) =>
    call<{ candidate: Candidate }>('/api/candidates', { method: 'POST', body: JSON.stringify(body) }),

  patchCandidate: (id: string, body: Record<string, unknown>) =>
    call<{ candidate: Candidate; rejected: string[] }>(`/api/candidates/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),

  addNote: (id: string, body: string, kind: string) =>
    call<{ note: Note }>(`/api/candidates/${encodeURIComponent(id)}/notes`, {
      method: 'POST',
      body: JSON.stringify({ body, kind }),
    }),

  addContact: (id: string, contact: Record<string, unknown>) =>
    call<{ contact: Contact }>(`/api/candidates/${encodeURIComponent(id)}/contacts`, {
      method: 'POST',
      body: JSON.stringify(contact),
    }),

  settings: () => call<{ weights: Weights; growth: Growth; screen: Record<string, number> }>('/api/settings'),

  putWeights: (w: Weights) => call<Weights>('/api/settings/weights', { method: 'PUT', body: JSON.stringify(w) }),

  putGrowth: (g: Growth) => call<Growth>('/api/settings/growth', { method: 'PUT', body: JSON.stringify(g) }),
};
