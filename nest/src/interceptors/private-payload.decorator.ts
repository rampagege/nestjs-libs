import { SetMetadata } from '@nestjs/common';

/** Suppress request payloads, URLs and exception payloads in generic request logs.
 * Business code may still emit explicit aggregate metrics for these operations.
 */
export const PRIVATE_PAYLOAD = 'logging:private-payload';
export const PrivatePayload = () => SetMetadata(PRIVATE_PAYLOAD, true);
