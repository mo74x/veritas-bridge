import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { CanonicalOrderRecord } from '@veritas/contracts';
import {
  DownstreamCrmPort,
  DownstreamSyncResult,
  PermanentDownstreamError,
  TransientDownstreamError,
} from './downstream-crm.port';

const HTTP_TIMEOUT_MS = 10_000;

@Injectable()
export class HttpModernCrmClient implements DownstreamCrmPort {
  private readonly logger = new Logger(HttpModernCrmClient.name);
  private readonly baseUrl: string;
  private readonly apiToken: string;

  constructor(baseUrl?: string, apiToken?: string) {
    this.baseUrl = (baseUrl ?? process.env.CRM_BASE_URL ?? '').replace(/\/+$/, '');
    this.apiToken = apiToken ?? process.env.CRM_API_TOKEN ?? '';
  }

  async upsertOrder(
    record: CanonicalOrderRecord,
    idempotencyKey?: string,
  ): Promise<DownstreamSyncResult> {
    const targetRecordId = `CRM-${record.externalOrderRef}`;
    const url = `${this.baseUrl}/orders/${encodeURIComponent(targetRecordId)}`;

    const response = await this.executeFetch(url, {
      method: 'PUT',
      headers: this.buildHeaders(idempotencyKey),
      body: JSON.stringify(record),
    });

    if (!response.ok) {
      throw await this.classifyHttpError(response, `PUT ${url}`);
    }

    const body = (await this.parseJsonSafe(response)) as Record<string, unknown> | null;
    const etag = response.headers.get('etag');

    const beforeState =
      body && typeof body.beforeState === 'object'
        ? (body.beforeState as Record<string, unknown> | null)
        : null;

    const afterBase: Record<string, unknown> =
      body && typeof body.afterState === 'object' && body.afterState !== null
        ? { ...(body.afterState as Record<string, unknown>) }
        : body && !('beforeState' in body)
          ? { ...body }
          : { id: targetRecordId, ...record };

    if (etag) {
      afterBase.etag = etag;
    }

    this.logger.log(`Upserted ${targetRecordId} into downstream Modern CRM API.`);

    return {
      targetRecordId,
      beforeState,
      afterState: afterBase,
    };
  }

  async restoreSnapshot(
    targetRecordId: string,
    beforeState: Record<string, unknown> | null,
    expectedAfterState?: Record<string, unknown> | null,
    idempotencyKey?: string,
  ): Promise<void> {
    const url = `${this.baseUrl}/orders/${encodeURIComponent(targetRecordId)}`;
    const headers = this.buildHeaders(idempotencyKey);
    const expectedEtag =
      expectedAfterState && typeof expectedAfterState.etag === 'string'
        ? expectedAfterState.etag
        : undefined;

    if (expectedEtag) {
      headers['If-Match'] = expectedEtag;
    } else if (expectedAfterState) {
      await this.assertNoRemoteDrift(url, beforeState, expectedAfterState);
    }

    const response =
      beforeState === null
        ? await this.executeFetch(url, { method: 'DELETE', headers })
        : await this.executeFetch(url, {
            method: 'PUT',
            headers,
            body: JSON.stringify(beforeState),
          });

    if (beforeState === null && response.status === 404) {
      this.logger.warn(`Rollback ${targetRecordId}: remote record already absent (404).`);
      return;
    }

    if (response.status === 409 || response.status === 412) {
      throw new ConflictException(
        `Rollback conflict for ${targetRecordId}: downstream record was modified.`,
      );
    }

    if (!response.ok) {
      throw await this.classifyHttpError(response, `restoreSnapshot ${url}`);
    }

    this.logger.warn(
      beforeState === null
        ? `Rolled back ${targetRecordId}: deleted newly created record.`
        : `Rolled back ${targetRecordId}: restored prior snapshot.`,
    );
  }

  private async assertNoRemoteDrift(
    url: string,
    beforeState: Record<string, unknown> | null,
    expectedAfterState: Record<string, unknown>,
  ): Promise<void> {
    const current = await this.executeFetch(url, {
      method: 'GET',
      headers: this.buildHeaders(),
    });

    if (current.status === 404) {
      if (beforeState === null) {
        return;
      }
      throw new ConflictException(`Rollback conflict for ${url}: remote record no longer exists.`);
    }

    if (!current.ok) {
      throw await this.classifyHttpError(current, `GET ${url}`);
    }

    const remoteBody = (await this.parseJsonSafe(current)) as Record<string, unknown> | null;
    if (!remoteBody) {
      return;
    }

    const expectedComparable = { ...expectedAfterState };
    delete expectedComparable.etag;
    const remoteComparable = { ...remoteBody };
    delete remoteComparable.etag;

    if (JSON.stringify(remoteComparable) !== JSON.stringify(expectedComparable)) {
      throw new ConflictException(
        `Rollback conflict for ${url}: fetched remote state differs from expectedAfterState.`,
      );
    }
  }

  private buildHeaders(idempotencyKey?: string): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.apiToken) {
      headers.Authorization = `Bearer ${this.apiToken}`;
    }
    if (idempotencyKey) {
      headers['Idempotency-Key'] = idempotencyKey;
    }
    return headers;
  }

  private async executeFetch(url: string, init: RequestInit): Promise<Response> {
    try {
      return await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new TransientDownstreamError(`Network or timeout error calling ${url}: ${message}`);
    }
  }

  private async classifyHttpError(response: Response, context: string): Promise<Error> {
    const bodyText = await response.text().catch(() => '');
    const message = `${context} failed with HTTP ${response.status}${bodyText ? `: ${bodyText}` : ''}`;

    if (response.status === 408 || response.status === 429 || response.status >= 500) {
      return new TransientDownstreamError(message, response.status);
    }
    return new PermanentDownstreamError(message, response.status);
  }

  private async parseJsonSafe(response: Response): Promise<unknown> {
    const text = await response.text();
    if (!text) {
      return null;
    }
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }
}
