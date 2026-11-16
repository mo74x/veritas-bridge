import { InjectQueue } from '@nestjs/bullmq';
import { BadRequestException, Body, Controller, Post } from '@nestjs/common';
import { LegacyRawRowSchema } from '@veritas/contracts';
import { Queue } from 'bullmq';
import { z } from 'zod';
import { RAW_MUTATION_QUEUE } from '../sync-engine/sync.processor';

const BatchIngestSchema = z.object({
  rows: z.array(LegacyRawRowSchema).min(1),
});

@Controller('ingest')
export class IngestController {
  constructor(@InjectQueue(RAW_MUTATION_QUEUE) private readonly syncQueue: Queue) {}

  @Post('rows')
  async ingestRows(@Body() body: unknown) {
    const parsed = BatchIngestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.flatten());
    }

    const jobs = await this.syncQueue.addBulk(
      parsed.data.rows.map((row) => ({
        name: 'sync-legacy-row',
        data: row,
        opts: {
          attempts: 3,
          backoff: { type: 'exponential', delay: 1000 },
          removeOnComplete: true,
        },
      })),
    );

    return {
      accepted: jobs.length,
      queue: RAW_MUTATION_QUEUE,
    };
  }
}