import dotenv from 'dotenv';
import { QueryParams } from '../lexicon/types/app/bsky/feed/getFeedSkeleton'
import { AppContext } from '../config'
import { AtpAgent } from '@atproto/api'
import { FeedViewPost } from '@atproto/api/dist/client/types/app/bsky/feed/defs';

// 起動時にログイン
dotenv.config();
const agent = new AtpAgent({ service: 'https://bsky.social' })
agent.login({
  identifier: process.env.BSKY_IDENTIFIER ?? "",
  password: process.env.BSKY_APP_PASSWORD ?? ""
});

export const shortname = 'likesBack'

export const handler = async (ctx: AppContext, params: QueryParams, requesterDid: string) => {
  const now = new Date();
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  // 24時間以内のlikeを取得して、likerごとに回数を集計
  const likeRows = await ctx.db
    .selectFrom('like')
    .select(['did'])
    .where('uri', 'like', `at://${requesterDid}/%`)
    .where('indexedAt', '>=', yesterday.toISOString())
    .execute()

  // 集計: likerごとのlike回数
  const likeCounts: Record<string, number> = {}
  for (const row of likeRows) {
    likeCounts[row.did] = (likeCounts[row.did] || 0) + 1
  }

  // likerごとに、その回数分だけ最新ポストを取得
  let posts: FeedViewPost[] = [];
  try {
    const responses = await Promise.all(
      Object.entries(likeCounts).map(([liker, count]) =>
        agent.getAuthorFeed({
          actor: liker,
          limit: count,
          filter: "posts_no_replies",
        }).then(res => ({ liker, feed: res.data.feed }))
          .catch(err => {
            console.error(`Failed to fetch feed for liker ${liker}:`, err)
            return { liker, feed: [] }; // エラーでも空配列で返す
          })
      )
    );
  
    posts = responses.flatMap(res => res.feed);
  } catch (err) {
    console.error("Unexpected error in feed fetching:", err);
  }

  // --- 🧠 ここから cursor 処理
  let feed = posts.sort((a, b) => {
    const dateA = new Date(a.post.indexedAt).getTime()
    const dateB = new Date(b.post.indexedAt).getTime()
    return dateB - dateA // 新しい順
  })

  if (params.cursor) {
    // カーソル（時刻）より前のポストだけに絞る
    const cursorTime = parseInt(params.cursor, 10)
    feed = feed.filter((item) => {
      const itemTime = new Date(item.post.indexedAt).getTime()
      return itemTime < cursorTime
    })
  }

  // 出す件数制限
  const limitedFeed = feed.slice(0, params.limit)

  // 次のカーソルを計算
  let cursor: string | undefined
  if (limitedFeed.length > 0) {
    const lastTime = new Date(limitedFeed[limitedFeed.length - 1].post.indexedAt).getTime()
    cursor = lastTime.toString()
  }

  // 返却
  console.log(`[${requesterDid}] liked by: ${Object.keys(likeCounts).length}, total posts: ${feed.length}`)
  return {
    cursor,
    feed: limitedFeed.map((item) => ({
      post: item.post.uri,
    })),
  }
}