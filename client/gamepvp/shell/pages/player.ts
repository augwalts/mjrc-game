/**
 * One player's page (`/players/:id`) — reached by tapping a name anywhere
 * (the Players list, a table, the match-end scoreboard).
 *
 * Header per players-lab.html §3, which is identical on every surface:
 *   identity   52px avatar, name, @handle (or "not linked") and the status
 *   actions    Invite to table · Message · star
 *   ranks      Hong Kong · Taiwan · offline HK · offline TW, "—" when null —
 *              the ONE place every format is shown at once
 *   record     games · win · dealt in · worth/hand
 * then the player's own stats content below it.
 *
 * Two reads, because no single route carries all of it: `GET /api/stats/
 * record` is the record and the rating, and the Players list is where a
 * handle, a live status and the caller's star live. The list has no by-id
 * filter (it is a list), so it is asked for the name the first read just
 * returned and the row is picked out of the answer.
 */
import { getPlayers, getStatsRecord, starFriend, unstarFriend, type PlayerSummary, type StatsRecordRow } from "../../net.js";
import type { PageMount } from "../router.js";
import { esc, identity } from "../session.js";
import { S, t } from "../strings.js";
import { avatarHtml, navHtml, pageTop, secCard, wireNav } from "../ui.js";

const num = (v: number | null | undefined): string => (v === null || v === undefined ? "—" : String(v));
const pct = (v: number | null | undefined): string => (v === null || v === undefined ? "—" : `${Math.round(v * 100)}%`);
const worth = (v: number | null | undefined): string =>
  v === null || v === undefined ? "—" : `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(2)}`;

function statusHtml(p: PlayerSummary | null): string {
  if (p === null) return "";
  const st = p.status;
  if (st.state === "online") return `<span class="pl-pres"><i></i>${esc(t(S.statusOnline))}</span>`;
  if (st.state === "queue") return `<span class="pl-pres"><i class="q"></i>${esc(t(S.statusQueue))} · ${esc(st.queue ?? "?/4")}</span>`;
  if (st.state === "playing") {
    const hand = st.hand === undefined ? "" : ` · ${t(S.handWord)} ${st.hand + 1}/${st.handsBase ?? "?"}`;
    return `<span class="pl-pres"><i></i>${esc(t(S.statusPlaying) + hand)}</span>`;
  }
  return `<span class="pl-pres"><i class="off"></i>${esc(t(S.statusOffline))}</span>`;
}

function headerHtml(id: string, row: StatsRecordRow | null, p: PlayerSummary | null): string {
  const name = p?.displayName ?? row?.displayName ?? id;
  const avatar = p?.avatar ?? row?.avatar ?? null;
  const handle = p === null ? "" : p.handle !== null ? `@${esc(p.handle)}` : esc(t(S.notLinkedName));
  const sub = [handle, statusHtml(p)].filter((s) => s !== "").join(" · ");
  /* Only Hong Kong online is a real ladder here; the other three slots are
   * the shape the site will fill in (Taiwanese online play does not exist,
   * and the two offline estimates live on the Almanac side). */
  const ranks: [string, number | null][] = [
    [t(S.rankHongKong), p?.ranks.hk ?? row?.rating ?? null],
    [t(S.rankTaiwan), p?.ranks.tw ?? null],
    [t(S.rankOfflineHk), p?.ranks.offlineHk ?? null],
    [t(S.rankOfflineTw), p?.ranks.offlineTw ?? null],
  ];
  const record: [string, string][] = [
    [t(S.tileGames), num(row?.games ?? 0)],
    [t(S.tileWin), pct(row?.winPct)],
    [t(S.tileDealtIn), pct(row?.inPct)],
    [t(S.tileWorth), worth(row?.worthPerHand)],
  ];
  const starred = p?.starred === true;
  const isMe = id === identity?.playerId;
  return `<div class="card pl-hdr">
    <div class="pl-idrow">
      <div class="pl-pid lg ${p === null || p.linked ? "" : "unlinked"}">${avatarHtml(name, avatar)}<span class="pl-nm"><b>${esc(name)}</b><small>${sub}</small></span></div>
      ${isMe ? "" : `<div class="pl-acts">
        <button class="pri" disabled title="${esc(t(S.inviteComingSoon))}">${esc(t(S.inviteToTableBtn))}</button>
        <button data-nav="/messages/${esc(id)}">${esc(t(S.messageWord))}</button>
        <button class="star ${starred ? "on" : ""}" data-star="${esc(id)}" aria-label="star">${starred ? "★" : "☆"}</button>
      </div>`}
    </div>
    <div class="pl-tilerows">
    <div class="pl-tiles">${ranks.map(([label, v]) => `<div><b>${v ?? "—"}</b><small>${esc(label)}</small></div>`).join("")}</div>
    <div class="pl-tiles">${record.map(([label, v]) => `<div><b>${esc(v)}</b><small>${esc(label)}</small></div>`).join("")}</div>
    </div>
  </div>`;
}

/** What the header does NOT already show — the rest of this player's record.
 *  (games / win / dealt in / worth/hand moved up into the header's second
 *  tile row, so repeating them here would be the same four numbers twice.) */
function statsCardHtml(row: StatsRecordRow | null): string {
  if (row === null) return `<p class="empty">${esc(t(S.nothingHere))}</p>`;
  return `<div class="stats"><div class="tiles">
    <div><b>${row.hands}</b><small>hands</small></div>
    <div><b>${row.netPerHand === null ? "—" : row.netPerHand.toFixed(1)}</b><small>net/hand</small></div>
    <div><b>${row.avgWinFan === null ? "—" : row.avgWinFan.toFixed(1)}</b><small>avg win fan</small></div>
    <div><b>${row.placements.join("·")}</b><small>1st·2nd·3rd·4th</small></div>
  </div></div>`;
}

export const mount: PageMount = (container, params, router) => {
  let alive = true;
  const id = params.id!;
  const token = identity?.deviceToken ?? "";
  let row: StatsRecordRow | null = null;
  let summary: PlayerSummary | null = null;

  const paint = (): void => {
    if (!alive) return;
    container.innerHTML = `
      ${pageTop(row?.displayName ?? summary?.displayName ?? id, { back: "/players", displayName: identity?.displayName ?? "", unread: 0 })}
      ${headerHtml(id, row, summary)}
      ${secCard(t(S.titleStats), "green", statsCardHtml(row))}
      ${navHtml("/players")}`;
    wireNav(container, router);
    const star = container.querySelector<HTMLElement>("[data-star]");
    if (star !== null) {
      star.onclick = async (e) => {
        e.preventDefault(); e.stopPropagation();
        const on = star.classList.contains("on");
        star.classList.toggle("on", !on);
        star.textContent = on ? "☆" : "★";
        if (summary !== null) summary.starred = !on;
        try { if (on) await unstarFriend(token, id); else await starFriend(token, id); }
        catch {
          star.classList.toggle("on", on);
          star.textContent = on ? "★" : "☆";
          if (summary !== null) summary.starred = on;
        }
      };
    }
  };

  container.innerHTML = `<div class="spinner">${esc(t(S.loading))}</div>`;
  void (async () => {
    try {
      row = (await getStatsRecord(token, { player: id }))[0] ?? null;
    } catch { row = null; }
    if (!alive) return;
    paint();
    /* Second pass: the list row for the handle, the live status and the star.
     * Best effort — the header renders without it. */
    try {
      const rows = await getPlayers(token, { q: row?.displayName ?? "" });
      summary = rows.find((p) => p.id === id) ?? null;
    } catch { summary = null; }
    if (!alive || summary === null) return;
    paint();
  })();
  return () => { alive = false; };
};
