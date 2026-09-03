/**
 * Every user-facing string in the shell, in one table (task brief §11.6):
 * "English with 中文 slots, so a Hong Kong listing is a translation job, not
 * a rewrite." `zh` is `null` wherever nobody has translated it yet — `t()`
 * falls back to `en` for those, and the fallback is silent (never shows a
 * key or an empty string), so shipping this file half-translated is safe.
 *
 * Not covered here: prose that is already bilingual by nature (hand names,
 * ruleset labels, the tile art) — those live where they always have
 * (table.ts's `AWARDS`/`RULE_PICKS`), since translating "清一色" would be
 * translating the game, not the UI around it.
 */
import { SETTINGS } from "./session.js";

export interface Str { en: string; zh: string | null; }
const s = (en: string, zh: string | null = null): Str => ({ en, zh });

export const S = {
  /* nav */
  navHome: s("Home", "首頁"),
  navRooms: s("Rooms", "房間"),
  navFriends: s("Friends", "好友"),
  navStats: s("Stats", "數據"),

  /* page titles */
  titleHome: s("香港麻雀 · MJRC"),
  titleRooms: s("Rooms", "房間"),
  titleFriends: s("Friends", "好友"),
  titleStats: s("Stats", "數據"),
  titleMessages: s("Messages", "訊息"),
  titleProfile: s("Profile", "個人資料"),
  titleAccount: s("Account", "帳戶"),
  titleSettings: s("Game settings", "遊戲設定"),

  /* home */
  playNow: s("Play now", "開局"),
  playNowSub: s("pick a room, rules, speed and seats"),
  joinByCode: s("Join by code", "輸入代碼加入"),
  joinByCodeSub: s("a table or a room"),
  secFriends: s("Friends", "好友"),
  secYourNumbers: s("Your numbers", "你的數據"),
  secYourGames: s("Your recent games", "你最近的對局"),
  allFriends: (n: number) => s(`all ${n} friends ›`),
  allGames: s("all games ›"),

  /* rooms */
  searchOrCode: s("join by code, or search rooms", "輸入代碼或搜尋房間"),
  go: s("Go", "前往"),
  openHall: s("Open hall", "公開大廳"),
  starred: s("Starred", "已收藏"),
  allRooms: (n: number) => s(`All rooms · ${n}`),
  createRoom: s("create a room ›", "建立房間 ›"),
  quiet: s("quiet", "冷清"),
  online: s("online", "在線"),
  live: s("live", "進行中"),

  /* room */
  members: s("members", "成員"),
  roomChat: s("Room chat", "房間聊天"),
  admin: s("Admin", "管理"),
  here: s("Here", "在場"),
  tables: s("Tables", "枱"),

  /* friends */
  filterOnline: s("Online", "在線"),
  filterAll: s("All", "全部"),
  filterOffline: s("Offline", "離線"),
  offlineLinkNote: s("link your Almanac name to see offline friends", "連結你的通勝帳戶以查看離線好友"),
  addFriendPlaceholder: s("add a friend by name or code"),
  lobbyChat: s("Lobby chat", "大廳聊天"),

  /* stats */
  filterRanked: s("Ranked", "排位"),
  filterCasual: s("Casual", "休閒"),
  filterLast10: s("Last 10", "近10局"),
  filterLast5: s("Last 5", "近5局"),
  secRecentGames: s("Recent games · tap one for its own stats", "最近對局 · 點擊查看詳情"),
  secHistogram: s("Hand histogram — winning fan", "自摸番數分佈"),
  secLeaderboard: s("Leaderboard", "排行榜"),
  secProgression: s("Score progression · you, across games", "積分走勢 · 跨對局"),
  secForm: s("Recent form", "近期表現"),
  secHandSizes: s("Hand sizes by game", "每局牌局長度"),
  secRating: s("Rating", "評分"),
  secDecisions: s("Decisions", "決策分析"),
  secFeeds: s("Feeds · by points", "餵牌 · 按分數"),
  secHandType: s("Hand type × fan", "牌型 × 番數"),
  fullLeaderboard: s("full leaderboard ›", "完整排行榜 ›"),

  /* game detail */
  secResult: s("Result", "結果"),
  secHandByHand: s("Hand by hand", "逐局明細"),
  secYourHands: s("Your hands this game", "你這局的牌"),
  secYourDecisions: s("Your decisions · desktop", "你的決策 · 桌面版"),
  secChatFromGame: s("Chat from this game", "這局的聊天"),
  replay: s("replay", "重播"),
  share: s("share", "分享"),

  /* messages / dm */
  filterInvites: s("Invites", "邀請"),
  filterResults: s("Results", "戰績"),
  sit: s("Sit", "入座"),
  open: s("Open", "開啟"),
  dismiss: s("dismiss", "忽略"),
  sendMessage: s("send", "傳送"),
  inviteToTable: s("invite to table", "邀請入枱"),
  profile: s("profile", "個人資料"),
  messagePlaceholder: (name: string) => s(`message ${name}`),

  /* profile / account */
  gearAccount: s("account", "帳戶"),
  gearSettings: s("game settings", "遊戲設定"),
  placementsByRuleset: s("Placements by ruleset", "各規則名次"),
  displayName: s("Display name", "顯示名稱"),
  handle: s("Handle", "帳號"),
  signIn: s("Sign in", "登入"),
  devicesWithAccess: s("Devices with access", "已授權裝置"),
  almanacProfile: s("Almanac profile", "通勝個人檔案"),
  exportData: s("Export my data", "匯出我的資料"),
  deleteAccount: s("Delete account", "刪除帳戶"),
  notLinked: s("not linked", "未連結"),
  accountFooter: s(
    "Same options as mahjongresearch.com/account, shown here so nobody leaves the game to manage them.",
  ),

  /* game settings */
  tileSize: s("Tile size", "麻將牌大小"),
  sound: s("Sound", "音效"),
  haptics: s("Haptics", "震動回饋"),
  countTilesOnTap: s("Count tiles on hover/tap", "點擊顯示剩餘張數"),
  coachingDesktop: s("Coaching (desktop only)", "提示 (只限桌面版)"),
  language: s("Language", "語言"),
  theme: s("Theme", "主題"),
  themeSystem: s("System", "跟隨系統"),
  themeLight: s("Light", "淺色"),
  themeDark: s("Dark", "深色"),
  notYou: s("not you? start a new player ›", "不是你？建立新玩家 ›"),
  on: s("on", "開"),
  off: s("off", "關"),

  /* misc */
  comingSoon: s("Creating rooms is coming soon — the admin is still building this. For now, ask for a room code to join one.", "建立房間功能即將推出，管理員仍在製作中。暫時請向朋友索取房間代碼加入。"),
  inboxWelcomeTitle: s("Welcome to MJRC 麻雀研究社", "歡迎來到麻雀研究社"),
  inboxWelcome: s("Invites to sit down, room news, game results and direct messages all land here. Play a game and your first result will show up.", "入座邀請、房間消息、對局結果和私人訊息都會在這裡出現。打一局，你的第一個結果就會出現。"),
  close: s("close", "關閉"),
  loading: s("loading…", "載入中…"),
  nothingHere: s("nothing here yet", "暫時未有內容"),
  couldNotReach: s("could not reach the server", "無法連線至伺服器"),
  yourName: s("What should we call you?"),
  continue_: s("continue ▸", "繼續 ▸"),
} as const;

export type StringKey = keyof typeof S;

/** `t(S.navHome)` — reads the current language from `SETTINGS.language`,
 *  falling back to English whenever a `zh` slot hasn't been filled in yet.
 *  Deliberately a function of the LIVE settings (never memoised) so a
 *  language change repaints correctly the next time a page renders. */
export function t(entry: Str): string {
  if (SETTINGS.language === "zh" && entry.zh) return entry.zh;
  return entry.en;
}
