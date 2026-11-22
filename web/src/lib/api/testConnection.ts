import { errorMessage } from '#lib/api/errorMessage.ts';
import type { ConnectionTestResult } from '#lib/shared.ts';

export async function testConnection(run: () => Promise<ConnectionTestResult>): Promise<ConnectionTestResult> {
  try {
    return await run();
  } catch (error) {
    return { ok: false, message: errorMessage(error), version: null };
  }
}
