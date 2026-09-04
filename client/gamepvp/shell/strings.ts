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
  navPlayers: s("Players", "玩家"),
  navStats: s("Stats", "數據"),

  /* page titles */
  titleHome: s("香港麻雀 · MJRC"),
  titleRooms: s("Rooms", "房間"),
  titlePlayers: s("Players", "玩家"),
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
  allPlayers: s("all players ›", "所有玩家 ›"),
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
  liveTables: s("Live tables", "進行中嘅枱"),
  noLiveTables: s("no live tables — open one from a room, or Play now on Home", "暫時冇枱 — 喺房間開一枱，或者喺主頁撳「即刻玩」"),

  /* players (players-lab.html round 3) */
  filterOnline: s("Online", "在線"),
  filterAll: s("All", "全部"),
  filterOffline: s("Offline", "離線"),
  filterFriends: s("Friends", "好友"),
  offlineLinkNote: s("link your Almanac name to see offline friends", "連結你的通勝帳戶以查看離線好友"),
  lobbyChat: s("Lobby chat", "大廳聊天"),
  searchPlayers: s("search players 搜尋", "搜尋玩家"),
  colPlayer: s("player", "玩家"),
  colStatus: s("status", "狀態"),
  colRank: s("rank", "排名"),
  colGames: s("games", "對局"),
  colWinPct: s("win%", "勝率"),
  colWorth: s("worth/hand", "每局價值"),
  groupShow: s("show", "顯示"),
  groupRank: s("rank", "排名"),
  groupGames: s("games", "對局"),
  groupSort: s("sort", "排序"),
  rankHk: s("Hong Kong", "香港"),
  rankTw: s("Taiwan", "台灣"),
  rankOffline: s("Offline", "線下"),
  sortRecent: s("recent", "最近"),
  sortRank: s("rank", "排名"),
  sortGames: s("games", "對局"),
  sortWorth: s("worth/hand", "每局價值"),
  filterTitle: s("Filter", "篩選"),
  filterReset: s("reset", "重設"),
  sheetRank: s("rank · 排名", "排名 · rank"),
  sheetGames: s("games counted · 對局", "計算對局 · games"),
  sheetSort: s("sort · 排序", "排序 · sort"),
  showNPlayers: (n: number) => s(`Show ${n} players`, `顯示 ${n} 位玩家`),
  nPlayers: (n: number) => s(`${n} players`, `${n} 位玩家`),
  nGames: (n: number) => s(`${n} games`, `${n} 局`),
  statusOnline: s("online", "在線"),
  statusQueue: s("queue", "候位"),
  statusPlaying: s("playing", "進行中"),
  statusOffline: s("offline", "離線"),
  handWord: s("hand", "第"),
  notLinkedName: s("not linked", "未連結"),

  /* player page (players-lab §3) */
  rankHongKong: s("Hong Kong", "香港"),
  rankTaiwan: s("Taiwan", "台灣"),
  rankOfflineHk: s("offline HK", "線下香港"),
  rankOfflineTw: s("offline TW", "線下台灣"),
  tileGames: s("games", "對局"),
  tileWin: s("win", "勝出"),
  tileDealtIn: s("dealt in", "出銃"),
  tileWorth: s("worth/hand", "每局價值"),
  inviteToTableBtn: s("Invite to table", "邀請入枱"),
  inviteComingSoon: s("coming soon", "即將推出"),
  messageWord: s("Message", "訊息"),

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

  /* sign-in + sign-up (ACCOUNTS-GAME-SIGNIN-2026-09-04 §4) */
  siteMark: s("麻雀研究社 · MJRC"),
  signInLede: s(
    "Sign in to play. A Google account is required; no anonymous players.",
    "登入即可開局。必須使用 Google 帳戶，不設匿名玩家。",
  ),
  signInWithGoogle: s("Sign in with Google", "以 Google 帳戶登入"),
  termsWord: s("terms", "服務條款"),
  privacyWord: s("privacy policy", "私隱政策"),
  termsLink: s("Terms", "服務條款"),
  privacyLink: s("Privacy", "私隱政策"),
  signupTitle: s("Set up your player", "設定你的玩家"),
  signupLede: s(
    "One screen, then you're in. Your handle is how other players find you.",
    "填好這一頁就可以開局。其他玩家會用你的帳號找你。",
  ),
  handleRule: s("3–20 characters · a–z, 0–9 and _", "3–20 個字元 · a–z、0–9 及 _"),
  handleChecking: s("checking…", "檢查中…"),
  handleAvailable: s("available", "可以使用"),
  handleTaken: s("taken", "已被使用"),
  handleReserved: s("reserved", "保留字"),
  handleInvalid: s("not a valid handle", "格式不正確"),
  handleTakenJust: s("that handle was just taken", "這個帳號剛剛被人取用"),
  pictureFromGoogle: s(
    "From your Google account. You can change it on the Account page.",
    "來自你的 Google 帳戶，稍後可在「帳戶」頁更改。",
  ),
  /* `{terms}` / `{privacy}` are replaced with real links by signup.ts. */
  consentLabel: s("I agree to the {terms} and the {privacy}", "我同意{terms}及{privacy}"),
  marketingLabel: s("Email me about MJRC events", "以電郵通知我 MJRC 活動"),
  startPlaying: s("Start playing ▸", "開始遊戲 ▸"),
  signupNeedName: s("Pick a display name.", "請輸入顯示名稱。"),
  signupNeedHandle: s("Pick a handle that is available.", "請選一個可用的帳號。"),
  signupNeedConsent: s("Please agree to the terms and the privacy policy.", "請先同意服務條款及私隱政策。"),
  signupFailed: s("Could not finish sign-up", "無法完成註冊"),
  signingUp: s("Setting up…", "設定中…"),
  signedInAs: s("Signed in as", "已登入"),
  memberNo: (n: number) => s(`member #${n}`, `會員 #${n}`),
  signOut: s("Sign out", "登出"),
  guestOnDevice: s("Guest player on this device. Sign in with Google to keep this player and its history.", "此裝置上的訪客玩家。以 Google 帳戶登入即可保留此玩家及其紀錄。"),
  signingOut: s("Signing out…", "登出中…"),
  deleteAccountWarn: s(
    "This deletes your account and your player. Games you have already played stay on the server without your name. This cannot be undone.",
    "此操作會刪除你的帳戶及玩家資料。已完成的對局會保留在伺服器，但不再顯示你的名字。刪除後無法復原。",
  ),
  deleteAccountConfirm: s("Delete permanently", "永久刪除"),
  deleting: s("Deleting…", "刪除中…"),
  cancel: s("Cancel", "取消"),

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
  on: s("on", "開"),
  off: s("off", "關"),

  /* table interactions */
  tapAgainToDiscard: s("tap again to discard", "再點一次打出"),
  doubleTapDiscardDesktop: s("Double tap to discard · desktop", "雙擊打牌 · 桌面版"),
  doubleTapDiscardPhone: s("Double tap to discard · phone", "雙擊打牌 · 手機"),

  /* quit and rejoin (2026-09-03) */
  quitTitle: s("Leave the table?", "離開牌桌？"),
  quitBody: s("A bot plays your seat until you come back. Your seat and your tiles are kept — rejoin from Home or from the room page.",
    "你返嚟之前由電腦代打。你嘅座位同手牌會保留，可以喺主頁或房間頁面返回牌桌。"),
  quitStay: s("stay", "留低"),
  quitLeave: s("leave — a bot plays for me", "離開 — 由電腦代打"),
  rejoin: s("rejoin", "返回牌桌"),
  quitEndAll: s("end the table for everyone", "結束成張枱"),
  quitEndAllHint: s("You opened this table. Ending it stops the game for all four seats and shows the final standings — the hand in play is void.",
    "呢張枱係你開嘅。結束會即刻停止四個位嘅牌局並顯示最終名次 — 進行中嗰鋪唔計。"),
  quitEndConfirm: s("end it now", "即刻結束"),
  quitKick: s("remove a player", "請走一個玩家"),
  quitKickHint: s("A bot plays their seat for the rest of the match; they cannot come back to it.", "之後嗰個位由電腦代打，佢唔可以再返嚟。"),
  quitKickConfirm: s("tap again to remove", "再撳一次確認"),
  quitKicked: s("removed", "已請走"),

  /* the menu behind the gear (2026-09-03) */
  menuTitle: s("Menu", "選單"),
  menuTab_game: s("game", "牌局"),
  menuTab_rules: s("rules", "規則"),
  menuTab_table: s("table", "牌枱"),
  menuTab_coach: s("coach", "教練"),
  menuTab_app: s("app", "程式"),
  menuLeave: s("leave the table", "離開牌桌"),
  menuDone: s("done", "完成"),
  menuGameHint: s("Pause holds every seat's clock; anyone can resume. Auto lets a bot play your seat until you turn it off — you keep the seat.",
    "暫停會停晒四個位嘅計時，任何人都可以繼續。自動代打會由電腦幫你打，直到你關閉為止 — 你嘅座位會保留。"),
  menuHostCap: s("you opened this table", "呢張枱係你開嘅"),
  menuFormat: s("length", "長度"),
  menuSpeed: s("speed", "速度"),
  menuSpeedFixed: s("set when the table was opened", "開枱嗰陣已經定咗"),
  menuScoringRef: s("full scoring reference", "完整計分參考"),
  menuOwnHandOnly: s("your own hand only", "只係你自己嘅手牌"),
  menuDoubleTapHint: s("First tap lifts the tile and reads it, second tap throws it — a thrown tile cannot be taken back.",
    "第一下撳起張牌同埋睇資料，第二下先打出 — 打咗出去就收唔返。"),
  menuHandOrder: s("hand order", "手牌次序"),
  menuCoachIntro: s("Training wheels. Each only tells you what a careful player could work out from the table — nothing hidden is revealed.",
    "輔助輪。每一項都只係話你知一個細心嘅玩家可以由枱面推算到嘅嘢 — 唔會透露任何隱藏資料。"),
  menuCount: s("count tiles", "數牌"),
  menuCountHint: s("tap or hover any tile to light up every copy on the table", "撳或者指住任何一隻牌，枱面上所有相同嘅牌都會亮起"),
  menuCalling: s("calling read", "聽牌提示"),
  menuCallingHint: s("whether you are 聽牌, what you wait on, how many are live", "你有冇聽牌、聽咩牌、仲剩幾多隻"),
  menuWhatIf: s("what-if", "如果打呢隻"),
  menuWhatIfHint: s("lift a tile to see what cutting it leaves you waiting on", "撳起一隻牌，睇下打咗佢之後你會聽咩"),
  menuTileLabels: s("tile labels", "牌面標示"),
  menuTileLabelsHint: s("1–9 on the suits, E S W N on the winds, Rd Gn Wh on the dragons — in the corner of every tile", "三門數牌標 1–9、風牌標 E S W N、三元牌標 Rd Gn Wh — 每隻牌角落都有"),
  menuDev: s("dev mode", "開發者模式"),
  menuDevHint: s("show how the champion would rank your discards and claims", "顯示冠軍程式點樣評你嘅出牌同叫牌"),
  menuTheme: s("theme", "主題"),
  menuAccount: s("account", "帳戶"),
  menuAccountLink: s("profile, picture, sign out", "個人資料、相片、登出"),
  /* start card, pause, fatal on the modal (2026-09-03) */
  startPayments: s("payments", "計分"),
  startEmptySeat: s("empty seat", "空位"),
  startYou: s("you", "你"),
  startIn: s("starting in", "即將開始"),
  startNow: s("start now", "即刻開始"),
  startReady: s("ready", "準備好"),
  pauseTitle: s("Paused", "已暫停"),
  pauseBy: s("Paused by", "暫停者："),
  pauseSomeone: s("a player", "一位玩家"),
  pauseSince: s("since", "由"),
  pauseHint: s("Every seat's clock is held. Anyone at the table can resume.", "四家嘅計時都停咗。任何一家都可以繼續。"),
  pauseResume: s("resume", "繼續"),
  fatalTitle: s("Something needs a reload", "需要重新載入"),
  fatalReload: s("reload", "重新載入"),
  /* the hand-end reveal on the modal (2026-09-03) */
  revealNextIn: s("next hand in", "下一鋪"),
  revealNextHand: s("next hand", "下一鋪"),
  revealWaitingOthers: s("waiting for others…", "等緊其他人…"),
  revealContinue: s("continue", "繼續"),
  revealBackLobby: s("back to lobby", "返回大廳"),
  /* rules tab — the payment scheme (2026-09-03) */
  rulesFaan: s("faan", "番"),
  rulesFlowers: s("flowers count", "計花"),
  rulesNoFlowers: s("no flowers", "唔計花"),
  rulesSettle: s("self-draw", "自摸"),
  rulesPerPlayer: s("each of the three losers pays the self-draw figure; on a discard the discarder pays it all (全銃)", "自摸三家各付自摸數；出銃全銃"),
  rulesTotal: s("the self-draw total is split three ways; on a discard the discarder pays it all (全銃)", "自摸總數三家分攤；出銃全銃"),
  rulesOnDiscard: s("discard · loser pays", "出銃 · 銃家付"),
  rulesOnSelfDraw: s("self-draw · each pays", "自摸 · 每家付"),
  rulesFaanTable: s("faan table", "番數表"),
  /* the waiting room (2026-09-03, modal restyle) */
  waitTitle: s("Waiting for the table", "等緊開枱"),
  waitCode: s("join code", "入枱碼"),
  waitCopy: s("copy invite link", "複製邀請連結"),
  waitBot: s("bot", "電腦"),
  waitConnected: s("connected", "已連線"),
  waitWaiting: s("waiting…", "等緊…"),
  waitNeeded: (n: number) => s(`waiting for ${n} more player${n === 1 ? "" : "s"}`, `仲爭 ${n} 位玩家`),
  waitAllHere: s("everyone is here — starting", "人齊晒 — 即將開始"),
  waitLeave: s("leave", "離開"),
  waitStartNow: s("start now · fill empty seats with bots", "即刻開始 · 空位由電腦補上"),
  kickedNotice: s("The host removed you from this table — a bot plays your seat and you cannot rejoin it.", "枱主已經請你離開呢張枱 — 你嘅位由電腦代打，你唔可以再返嚟。"),
  rejoinTitle: s("You have a seat at a live table", "你喺牌桌仲有個位"),
  hostingTitle: s("You are hosting a table", "你正在主持一張枱"),
  watchTable: s("watch", "觀看"),
  sortHand: s("sort", "整理"),
  sortHandTitle: s("put your hand back in the default order", "回復預設排序"),

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

  /* stats + friends */
  statsHelpTiles: s("Your overall record for the selected filter: games and hands played, how often you win, and how often you deal in. Worth per hand prices your net points against that ruleset's average winning hand, so different rulesets compare. Applies whichever filter is selected above (online/offline, ranked/casual, ruleset, or last N games)."),
  statsHelpRecent: s("Your most recent matches, newest first, with place, chip change, and whether the match was ranked or casual. Tap a game to open its own page with the full hand-by-hand detail. Not affected by the filters above — this always shows your latest games."),
  statsHelpHistogram: s("How many of your winning hands landed at each fan value, split by ruleset (see the legend for which line is which). A higher fan means a bigger hand. Applies whichever filter is selected above."),
  statsHelpProgression: s("Your points swing hand by hand within a game — one faint line per game, with your average across games in bold. Shows the shape of a session, not just the final score. Applies whichever filter is selected above."),
  statsHelpFeeds: s("Who you win the most points off when they discard into your hand, and who wins the most points off you the same way. Points only, not hand counts — a short bar can still mean a big feeder if their discards are expensive. Applies whichever filter is selected above."),
  statsHelpForm: s("Your net worth per hand across your most recent games, oldest to newest. Above the zero line is a winning game on balance, below is a losing one. Applies whichever filter is selected above."),
  statsHelpSizes: s("The winning fan values across each of your recent games, one faint line per game. Shows whether your games tend to end in small quick hands or long high-value ones. Applies whichever filter is selected above."),
  statsHelpHandType: s("Every hand pattern you've won with, most-won first, with how many times you've won it and its average fan. Applies whichever filter is selected above."),
  statsHelpRating: s("Your ranked rating over time — only online, move-validated games count toward it. The number beside the title is your current rating and how much it has moved across the games shown. Offline is always empty here; ruleset and last-N filters still narrow the games counted."),
  statsHelpLeaderboard: s("Ranked players sorted by rating, minimum 5 games to qualify; (p) marks a provisional rating that hasn't seen enough games yet. Server-wide — not scoped to the filters above."),
  statsEmptyTiles: s("no games yet — play a table to start your numbers"),
  statsEmptyRecent: s("no games yet — play a table to see your match history"),
  statsEmptyHistogram: s("no wins yet — win a hand to start the histogram"),
  statsEmptyProgression: s("no games yet — your score swings appear after your first game"),
  statsEmptyFeeds: s("no hands yet — feed and discard patterns appear after your first game"),
  statsEmptyForm: s("no games yet — recent form appears after your first result"),
  statsEmptySizes: s("no games yet — hand sizes appear after your first game"),
  statsEmptyHandType: s("no wins yet — winning hands will group here by type"),
  statsEmptyRating: s("no ranked games yet — play a four-human table to get rated"),
  statsEmptyLeaderboard: s("no leaderboard yet — needs 5+ ranked games to qualify"),

  /* avatar */
  profilePicture: s("Profile picture", "個人頭像"),
  choosePicture: s("Choose a picture", "選擇圖片"),
  removePicture: s("Remove", "移除"),
  pictureSizeHint: s("Cropped to a square, resized to 128×128, under 12 KB.", "會裁切成正方形，縮至 128×128，少於 12 KB。"),
  pictureTooBig: s("That picture is too detailed to fit under 12 KB even at low quality — try a simpler or lower-resolution photo.", "這張圖片即使降低畫質仍超過 12 KB — 請試試較簡單或解像度較低的相片。"),
  pictureUploadFailed: s("Could not read that picture — try another one.", "無法讀取該圖片，請嘗試其他圖片。"),
  pictureSaving: s("Saving…", "儲存中…"),
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

/** The line in the OTHER language, or null when nobody has translated it.
 *  Used only where BOTH languages belong on screen at once — the sign-in
 *  screen, which is the one page shown before anybody has told us what they
 *  read (`SETTINGS.language` is still a browser guess there). */
export function tAlt(entry: Str): string | null {
  return SETTINGS.language === "zh" ? entry.en : entry.zh;
}
