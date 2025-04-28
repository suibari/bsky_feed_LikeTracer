export type DatabaseSchema = {
  like: Like
  sub_state: SubState
}

export type Like = {
  did: string
  uri: string
  cid: string
  indexedAt: string
}

export type SubState = {
  service: string
  cursor: number
}
