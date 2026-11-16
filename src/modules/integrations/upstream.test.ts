import { expect, test } from 'bun:test';
import { upstreamFetch } from './upstream.ts';

function failingFetch(message: string, code: string): () => Promise<Response> {
  return async () => {
    throw Object.assign(new TypeError(message), { code });
  };
}

test('upstreamFetch - an untrusted certificate points at NODE_EXTRA_CA_CERTS', async () => {
  const request = upstreamFetch({
    service: 'Radarr',
    url: 'https://radarr.lan/api/v3/system/status',
    fetch: failingFetch('self signed certificate', 'DEPTH_ZERO_SELF_SIGNED_CERT'),
  });
  await expect(request).rejects.toMatchObject({
    code: 'upstream',
    message:
      'Radarr GET /api/v3/system/status: unreachable (self signed certificate); to trust a self-signed or private CA certificate, set NODE_EXTRA_CA_CERTS (see README)',
    details: { status: null },
  });
});

test('upstreamFetch - other network errors carry no certificate hint', async () => {
  const request = upstreamFetch({
    service: 'Radarr',
    url: 'https://radarr.lan/api/v3/system/status',
    fetch: failingFetch('Unable to connect', 'ConnectionRefused'),
  });
  await expect(request).rejects.toMatchObject({
    message: 'Radarr GET /api/v3/system/status: unreachable (Unable to connect)',
  });
});
