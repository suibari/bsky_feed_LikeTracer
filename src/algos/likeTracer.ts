import { QueryParams } from '../lexicon/types/app/bsky/feed/getFeedSkeleton.js'
import { AppContext } from '../config.js'
import { FeedViewPost } from '@atproto/api/dist/client/types/app/bsky/feed/defs';
import pLimit from 'p-limit';
import { agent } from '../login.js';

export const shortname = 'likeTracer'

export const handler = async (ctx: AppContext, params: QueryParams, requesterDid: string) => {
  const PAGE_SIZE = Math.min(params.limit ?? 100, 100);
  const limit = pLimit(10); // 同時fetch制限

  const now = new Date();

  // Subscriber登録
  const result = await ctx.db
    .insertInto('subscriber')
    .values({
      did: requesterDid,
      indexedAt: now.toISOString(),
    })
    .onConflict((oc) => oc.doNothing())
    .returning(['did'])
    .execute()

  if (result.length > 0) {
    console.log(`[${requesterDid}] subscriber registered.`);
  }

  // 1. 自分が行ったlikeを取得（3日以内のデータが前提）
  const likeRows = await ctx.db
    .selectFrom('like')
    .select(['likedDid', 'indexedAt'])
    .where('did', '=', requesterDid)
    .orderBy('indexedAt', 'desc')
    .limit(100) // いいね数が多すぎるとスループット低下するので、いったん最新100件いいねのみにする
    .execute();

  // 2. likedDidごとにlike数を集計
  const likeCounts: Record<string, number> = {};
  for (const row of likeRows) {
    likeCounts[row.likedDid] = (likeCounts[row.likedDid] || 0) + 1;
  }

  // 3. ポスト取得（各likedDidごとにlike数分）
  const responses = await Promise.all(
    Object.entries(likeCounts).map(([likedDid, count]) =>
      limit(() =>
        agent
          .getAuthorFeed({
            actor: likedDid,
            limit: 100,
            filter: "posts_and_author_threads", // リプライ除外かつスレッド先頭ポスト含む
          })
          .then((res) => ({
            likedDid,
            feed: res.data.feed
              .filter((item) => !item.reason)
              .slice(0, count),
          }))
          .catch((err) => {
            console.error(`Failed to fetch feed for likedDid ${likedDid}:`, err);
            return { likedDid, feed: [] };
          })
      )
    )
  );

  // 4. 全ポストをまとめて時系列ソート
  let allPosts: FeedViewPost[] = [];
  for (const { feed } of responses) {
    allPosts.push(...feed);
  }
  allPosts.sort((a, b) => new Date(b.post.indexedAt).getTime() - new Date(a.post.indexedAt).getTime());

  // 5. cursorによる時系列スライス処理
  if (params.cursor) {
    const decoded = new Date(Buffer.from(params.cursor, 'base64').toString());
    allPosts = allPosts.filter((post) => new Date(post.post.indexedAt) < decoded);
  }

  // 6. ページサイズに合わせてスライスし、次のカーソルを生成
  let nextCursor: string | undefined = undefined;
  if (allPosts.length > PAGE_SIZE) {
    const next = allPosts[PAGE_SIZE - 1].post.indexedAt;
    nextCursor = Buffer.from(next).toString('base64');
    allPosts = allPosts.slice(0, PAGE_SIZE);
  }

  // 返却
  console.log(`[${requesterDid}] like targets: ${Object.keys(likeCounts).length}, total posts: ${allPosts.length}, cursor: ${nextCursor}`);
  return {
    cursor: nextCursor,
    feed: allPosts.map((item) => ({
      post: item.post.uri,
    }))
  };
};
