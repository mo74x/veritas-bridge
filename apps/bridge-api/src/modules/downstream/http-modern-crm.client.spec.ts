import { ConflictException } from '@nestjs/common';
import { CanonicalOrderRecord } from '@veritas/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PermanentDownstreamError, TransientDownstreamError } from './downstream-crm.port';
import { HttpModernCrmClient } from './http-modern-crm.client';

const sampleOrder: CanonicalOrderRecord = {
  externalOrderRef: 'ORD-1001',
  vendorName: 'Acme Supplies',
  currency: 'USD',
  amountCents: 25000,
  orderDate: '2026-11-16T00:00:00.000Z',
  lineItems: [{ sku: 'SKU-1', description: 'Widget', quantity: 2, unitPriceCents: 12500 }],
};

describe('HttpModernCrmClient', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('sends PUT with Idempotency-Key and Bearer token on upsertOrder', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          beforeState: null,
          afterState: { id: 'CRM-ORD-1001', ...sampleOrder },
        }),
        { status: 200, headers: { etag: '"v1"' } },
      ),
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    const client = new HttpModernCrmClient('https://crm.example.com', 'secret-token');
    const result = await client.upsertOrder(sampleOrder, 'idem-123');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://crm.example.com/orders/CRM-ORD-1001');
    expect(init.method).toBe('PUT');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer secret-token');
    expect((init.headers as Record<string, string>)['Idempotency-Key']).toBe('idem-123');
    expect(result.targetRecordId).toBe('CRM-ORD-1001');
    expect(result.afterState.etag).toBe('"v1"');
  });

  it('throws PermanentDownstreamError on 400 Bad Request', async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValue(new Response('invalid payload', { status: 400 })) as unknown as typeof fetch;

    const client = new HttpModernCrmClient('https://crm.example.com', 'secret-token');
    await expect(client.upsertOrder(sampleOrder, 'idem-123')).rejects.toBeInstanceOf(
      PermanentDownstreamError,
    );
  });

  it('throws TransientDownstreamError on 503 Service Unavailable', async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValue(new Response('unavailable', { status: 503 })) as unknown as typeof fetch;

    const client = new HttpModernCrmClient('https://crm.example.com', 'secret-token');
    await expect(client.upsertOrder(sampleOrder, 'idem-123')).rejects.toBeInstanceOf(
      TransientDownstreamError,
    );
  });

  it('sends If-Match on restoreSnapshot when expectedAfterState has etag', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    global.fetch = fetchMock as unknown as typeof fetch;

    const client = new HttpModernCrmClient('https://crm.example.com', 'secret-token');
    await client.restoreSnapshot('CRM-ORD-1001', null, { etag: '"v1"' }, 'rb-1');

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe('DELETE');
    expect((init.headers as Record<string, string>)['If-Match']).toBe('"v1"');
  });

  it('throws ConflictException when pre-rollback GET shows remote state differs', async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ id: 'CRM-ORD-1001', amountCents: 99999 }), { status: 200 }),
      ) as unknown as typeof fetch;

    const client = new HttpModernCrmClient('https://crm.example.com', 'secret-token');
    await expect(
      client.restoreSnapshot(
        'CRM-ORD-1001',
        null,
        { id: 'CRM-ORD-1001', amountCents: 25000 },
        'rb-1',
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});
