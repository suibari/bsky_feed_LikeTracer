import { InvalidRequestError } from '@atproto/xrpc-server'
import { Server } from '../lexicon/index.js'
import { AppContext } from '../config.js'
import algos from '../algos/index.js'
import { validateAuth } from '../auth.js'
import { AtUri } from '@atproto/syntax'

export default function (server: Server, ctx: AppContext) {
  server.app.bsky.feed.getFeedSkeleton(async ({ params, req }) => {
    const feedUri = new AtUri(params.feed)
    const algo = algos[feedUri.rkey]
    if (
      feedUri.hostname !== ctx.cfg.publisherDid ||
      feedUri.collection !== 'app.bsky.feed.generator' ||
      !algo
    ) {
      throw new InvalidRequestError(
        'Unsupported algorithm',
        'UnsupportedAlgorithm',
      )
    }
    
    let requesterDid: string
    if (process.env.NODE_ENV === 'development') {
      requesterDid = process.env.FEEDGEN_PUBLISHER_DID ?? '';
    } else {
      requesterDid = await validateAuth(
        req,
        ctx.cfg.serviceDid,
        ctx.didResolver,
      )
    }
    
    const body = await algo(ctx, params, requesterDid)
    return {
      encoding: 'application/json',
      body: body,
    }
  })
}
