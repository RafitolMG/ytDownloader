import { z } from 'zod'

/**
 * Runtime schemas for the API boundary.
 *
 * Scoped deliberately to the small, stable, high-value responses where a silent
 * contract drift is most harmful — auth. A malformed auth response would
 * otherwise flow into the app as a bad type and fail confusingly far from the
 * cause; validating here turns it into a clear error at the edge.
 *
 * The larger feed/list responses aren't validated yet: their schemas are big and
 * easy to make stricter than reality (which would break a working app), so they
 * should be added incrementally and checked against the live backend. `json()`
 * takes an optional schema, so extending coverage is just passing one in.
 */

export const whoamiSchema = z.object({
  user_id: z.string(),
  username: z.string(),
  role: z.enum(['ADMIN', 'USER']),
})
export type Whoami = z.infer<typeof whoamiSchema>

export const mediaTokenSchema = z.object({
  token: z.string(),
  expires_in: z.number(),
})
