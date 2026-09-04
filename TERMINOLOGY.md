# Terminology — Hong Kong only

This project is HK Old Style. **Japanese terms are banned from code, tests, UI and docs**,
including in variable names and comments. They leak a different game's rules into ours and
they are wrong for our audience.

Romanization is Jyutping-ish and standardised here once (DESIGN.md §7 asks for exactly this).

## Banned → use instead

| Never say | Use in code | Use in UI | Cantonese |
|---|---|---|---|
| shanten | `distanceToReady` | "N away from ready" | 上聽 *soeng ting* |
| tenpai | `isReady` | "ready" | 聽牌 *ting paai* |
| ukeire | `liveTiles` | "live tiles" | 有效牌 *jau haau paai* |
| tsumogiri | `drawAndCut` | "drew and cut" | 摸切 *mo cit* |
| ron | `winOnDiscard` | "win" | 食糊 *sik wu* |
| han | `faan` | "faan" | 番 *faan* |
| yaku | `pattern` | "pattern" | 牌型 *paai jing* |
| hanchan | `round` | "wind round" | 圈 *hyun* |
| kanchan | `closedWait` | "closed wait" | 坎張 *ham zoeng* |
| ankan | `concealedKong` | "concealed kong" | 暗槓 *am gong* |
| minkan | `exposedKong` | "exposed kong" | 明槓 *ming gong* |
| riichi · furiten · dora | — | — | no such rule in Hong Kong mahjong |

The **Cantonese** column is the only place characters appear without an English
gloss beside them, because the adjacent columns already carry it. Everywhere
else, follow the house style below.

## Kept — these are Cantonese, not borrowed

| Term | Characters | Meaning |
|---|---|---|
| `selfDraw` / zi mo | self-draw 自摸 zi mo | won on your own draw (Japanese borrowed this from Chinese) |
| chow | 上 *soeng* | run claimed from the left-hand player |
| pung | 碰 *pung* | triplet claimed from any discard |
| kong | 槓 *gong* | quad |
| faan | 番 | the scoring unit |
| flower | 花 *faa* | bonus tile |
| limit | the limit 爆棚 baau paang *baau paang* | the 13-faan cap |
| exhaustive draw | exhaustive draw 流局 lau guk *lau guk* | wall exhausted, no winner |

## House style

**English leads. Cantonese supports. Never Chinese alone.**

This product is English-first (DESIGN.md §1) — the audience is diaspora players
and learners, many of whom do not read Chinese. A bare All Honours 字一色 zi jat sik communicates
nothing to them. The Cantonese is there to be *learned*, which means it always
arrives attached to something the reader already understands.

Applies to UI, documents, comments, commit messages and conversation alike:

| Context | Form |
|---|---|
| UI label, two lines | **All Honours** on top, `All Honours 字一色 zi jat sik zi jat sik` beneath |
| UI button, tight | **Pong** with `碰` beneath |
| Prose, first mention | All Honours (All Honours 字一色 zi jat sik *zi jat sik*) |
| Prose, later mentions | All Honours — the characters have done their job |
| Code identifier | `allHonours` — English only, never romanized Cantonese |
| Code comment | `// All Honours 字一色 zi jat sik — every tile an honour` |

The one exception: where the Cantonese IS the content — the expression and
table-talk system, where the whole point is hearing win 食糊 sik wu shouted at you. Even
there a gloss is available on demand.

**Never write a Chinese term with no English anywhere near it.** If a reader has
to look it up, the terminology-first goal has failed — it teaches nothing and
just excludes.

- Comments never use a banned term, even to say "the equivalent of X".
