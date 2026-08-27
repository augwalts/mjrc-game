"""Fixture generator for the port-diff harness (DESIGN.md §8, harness 1).

Runs the Python research engine at mjrc-admin/research/probability/, then
distils its logged JSONL batches into one committed fixture file so the
TypeScript harness can run with no Python installed.

Two independent corpora come out of one batch:

  scoringCases   every logged win, with the Python engine's own answer
                 (pattern list, faan breakdown, capped total, chips).

  distanceCases  real mid-hand tile counts with a distance-to-ready figure
                 computed TWICE by this file: once by the exhaustive search,
                 once with the branch-and-bound cutoff the Python engine
                 actually ships. ENGINE-AUDIT §3 measured that cutoff wrong on
                 ~6.1% of 13-tile and ~10.1% of 14-tile hands and instructs the
                 port to be validated against the EXHAUSTIVE reference. Both
                 figures are emitted so the harness re-measures that gap from
                 our own code instead of taking the audit's word for it.

Why this file re-implements the search instead of importing it: the shipped
Python function has the cutoff baked in and there is no exhaustive entry point
to import. The search below is transcribed from that module with the four-line
cutoff (the lines ENGINE-AUDIT §3 cites) made optional.

Nothing here is imported by the TypeScript build. It exists so the fixture can
be regenerated and audited rather than trusted.

Usage:
  python3 tools/port-diff/generate_fixtures.py \
      --python-repo /Users/augustineliu/Local_Projects/mjrc/mjrc-admin/research/probability \
      --matches 250 --seed 20260826 \
      --out tools/port-diff/fixtures/liu-closed.json \
      --sample-out tools/port-diff/fixtures/sample-batch.json
"""

from __future__ import annotations

import argparse
import glob
import json
import os
import shutil
import sys
import tempfile
from datetime import datetime, timezone

FORMAT_VERSION = 1

# The Python engine and the TypeScript engine share tile ids 0-33 exactly:
# 0-8 characters, 9-17 bamboo, 18-26 circles, 27-30 winds, 31-33 dragons.
# The TypeScript space continues to 41 with the eight flowers, which the
# Python engine has no representation for at all.
SCORING_KINDS = 34


# ---------------------------------------------------------------------------
# Distance to ready — exhaustive, and the shipped cutoff, side by side
# ---------------------------------------------------------------------------

def standard_distance(counts: list[int], *, cutoff: bool) -> int:
    """Distance to a standard 4-sets-plus-a-pair shape.

    -1 complete, 0 ready, 1+ away. `cutoff=False` is the exhaustive reference
    the port is validated against; `cutoff=True` reproduces what the Python
    engine ships, including its wrong answers.
    """
    h = list(counts)
    best = [9]

    def rec(pos: int, sets: int, partial: int, has_pair: bool) -> None:
        if cutoff:
            # Transcribed verbatim from the shipped module. It treats the
            # subtree's WORST case as an optimistic bound, so it prunes
            # branches that would have scored better. Kept only to measure it.
            effective = min(partial, 4 - sets)
            bound = 8 - 2 * sets - effective - (1 if has_pair else 0)
            if bound >= best[0]:
                return

        while pos < SCORING_KINDS and h[pos] == 0:
            pos += 1

        if pos >= SCORING_KINDS:
            capped = min(partial, 4 - sets)
            d = 8 - 2 * sets - capped - (1 if has_pair else 0)
            if d < best[0]:
                best[0] = d
            return

        suit_start = None
        for s in (0, 9, 18):
            if s <= pos < s + 9:
                suit_start = s
                break

        if h[pos] >= 3:
            h[pos] -= 3
            rec(pos, sets + 1, partial, has_pair)
            h[pos] += 3

        if suit_start is not None:
            r = pos - suit_start
            if r <= 6 and h[pos + 1] >= 1 and h[pos + 2] >= 1:
                h[pos] -= 1; h[pos + 1] -= 1; h[pos + 2] -= 1
                rec(pos, sets + 1, partial, has_pair)
                h[pos] += 1; h[pos + 1] += 1; h[pos + 2] += 1

        if h[pos] >= 2 and not has_pair:
            h[pos] -= 2
            rec(pos, sets, partial, True)
            h[pos] += 2

        if h[pos] >= 2:
            h[pos] -= 2
            rec(pos, sets, partial + 1, has_pair)
            h[pos] += 2

        if suit_start is not None:
            r = pos - suit_start
            if r <= 7 and h[pos + 1] >= 1:
                h[pos] -= 1; h[pos + 1] -= 1
                rec(pos, sets, partial + 1, has_pair)
                h[pos] += 1; h[pos + 1] += 1
            if r <= 6 and h[pos + 2] >= 1:
                h[pos] -= 1; h[pos + 2] -= 1
                rec(pos, sets, partial + 1, has_pair)
                h[pos] += 1; h[pos + 2] += 1

        old = h[pos]
        h[pos] = 0
        rec(pos + 1, sets, partial, has_pair)
        h[pos] = old

    rec(0, 0, 0, False)
    return best[0]


# ---------------------------------------------------------------------------
# Running the Python engine
# ---------------------------------------------------------------------------

def run_batch(python_repo: str, out_dir: str, matches: int, seed: int) -> dict:
    """Play `matches` LIU matches with four greedy bots, logging JSONL."""
    if python_repo not in sys.path:
        sys.path.insert(0, python_repo)
    from mahjong.batch.simulate_batch import run_batch as _run  # noqa: E402

    _run(matches=matches, bots=["greedy"] * 4, ruleset_name="liu",
         seed=seed, out_dir=out_dir)
    with open(os.path.join(out_dir, "manifest.json"), encoding="utf-8") as f:
        return json.load(f)


# ---------------------------------------------------------------------------
# Extraction
# ---------------------------------------------------------------------------

def tile_ids(counts: list[int]) -> list[int]:
    out: list[int] = []
    for tid, n in enumerate(counts):
        out.extend([tid] * n)
    return out


def extract(paths: list[str], every_nth_distance: int, max_distance: int):
    """Pull scoring cases and distance samples out of the logged batches.

    `match_id` is deliberately NOT carried into the fixture: the Python engine
    mints it with uuid4 rather than deriving it from the seed, so two runs of
    the same seeded batch produce identical play and different ids. The case
    id (file tag + hand index + turn) is deterministic and identifies the same
    thing. This is one more entry on ENGINE-AUDIT §2's list of log gaps.

    A win frame is identified structurally — it is the frame carrying a
    `score` block — and the win type is read off `score.deal_in_seat`, which
    is null exactly when the winner drew the tile themselves. The per-frame
    `rationale` block is deliberately ignored: the figures in it come from the
    engine's cutoff search and are wrong on ~6-10% of hands (ENGINE-AUDIT §3).
    """
    scoring: list[dict] = []
    distance: list[dict] = []
    hands_played = 0
    frame_counter = 0
    seen_distance: set[tuple] = set()

    for path in sorted(paths):
        match_tag = os.path.splitext(os.path.basename(path))[0]
        header: dict = {}
        pending: list[dict] = []

        with open(path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                rec = json.loads(line)
                kind = rec.get("kind")

                if kind == "hand_header":
                    header = rec
                    pending = []
                    continue

                if kind == "hand_footer":
                    hands_played += 1
                    for case in pending:
                        case["chipDeltas"] = list(rec.get("chip_deltas", [0, 0, 0, 0]))
                        scoring.append(case)
                    pending = []
                    continue

                # --- a play frame ---
                frame_counter += 1
                score = rec.get("score")

                if score is not None:
                    seat = int(score["winner"])
                    from_seat = score.get("deal_in_seat")
                    self_draw = from_seat is None
                    pending.append({
                        "id": f"{match_tag}.h{header.get('hand_index', 0)}.t{rec['turn']}",
                        "handIndex": int(header.get("hand_index", 0)),
                        "turn": int(rec["turn"]),
                        "seat": seat,
                        "dealer": int(header.get("dealer", 0)),
                        "roundWind": int(header.get("round_wind", 27)) - 27,
                        "seatWind": int(header["seat_winds"][seat]) - 27,
                        "selfDraw": self_draw,
                        "from": None if self_draw else int(from_seat),
                        "winningTile": int(rec["action"]["tile"]),
                        "hand": [int(x) for x in score["winning_hand"]],
                        "wallRemaining": int(rec["wall_remaining"]),
                        "melds": [list(m) for m in rec.get("melds", [])],
                        "python": {
                            "patterns": list(score["patterns"]),
                            "faanBreakdown": dict(score["fan_breakdown"]),
                            "faan": int(score["total_fan"]),
                            "chips": int(score["chips"]),
                        },
                    })
                    continue

                if len(distance) >= max_distance:
                    continue
                if frame_counter % every_nth_distance:
                    continue
                actor = int(rec["actor"])
                hand = [int(x) for x in rec["hands"][actor]]
                total = sum(hand)
                if total not in (13, 14):
                    continue
                key = tuple(hand)
                if key in seen_distance:
                    continue
                seen_distance.add(key)
                distance.append({
                    "id": f"{match_tag}.h{header.get('hand_index', 0)}.t{rec['turn']}.s{actor}",
                    "hand": hand,
                    "tiles": total,
                    "exhaustive": standard_distance(hand, cutoff=False),
                    "shipped": standard_distance(hand, cutoff=True),
                })

    return scoring, distance, hands_played


# ---------------------------------------------------------------------------
# Keeping the Python engine's vocabulary out of our repo
# ---------------------------------------------------------------------------
#
# TERMINOLOGY.md bans a set of Japanese terms from this codebase's code,
# comments and STRINGS. The Python engine spells several of its own field names
# and outcome labels in exactly those terms, and a committed fixture is a
# string in this repo. So two fields never make it across, and the rest are
# renamed into our vocabulary on the way.
#
# Nothing load-bearing is lost: the harness's extractor reads neither of the
# dropped fields. It finds a win frame structurally (the frame carrying a
# `score` block) and reads the win type off `score.deal_in_seat`.

_DROP_FROM_HEADER = ("ruleset",)   # the price list, re-published below in our words
_DROP_FROM_FOOTER = ("outcome",)   # a label; `winner` carries the same information
_DROP_FROM_ACTION = ("type",)      # a label; the frame's `score` block is the signal
_DROP_FROM_SCORE = ("is_tsumo",)   # a flag; `deal_in_seat` carries the same fact


def project_ruleset(r: dict) -> dict:
    """The Python ruleset in this project's vocabulary.

    Renaming only — every value is carried across untouched. Several of these
    flags are stubs the Python engine declares and never reads; they are kept
    because the fixture is provenance and what the engine CLAIMED matters.
    """
    return {
        "name": r["name"],
        "minimumFaan": r["fan_minimum"],
        "limitFaan": r["fan_limit"],
        "selfDrawFaan": r["self_drawn_fan"],
        "roundsPerMatch": r["rounds_per_match"],
        "seats": r["seats"],
        "maxTurnsPerHand": r["max_turns_per_hand"],
        "useFlowers": r["use_flowers"],
        "useKongReplacement": r["use_kong_replacement"],
        "allowsChow": r["allow_chi"],
        "allowsPung": r["allow_pon"],
        "allowsKong": r["allow_kan"],
        "allowsSevenPairs": r["allow_seven_pairs"],
        "allowsThirteenOrphans": r["allow_thirteen_orphans"],
        "allowsMultipleWinners": r["multi_ron"],
        "liabilityTransfer": r["pao_liability"],
        "deadWallSize": r["dead_wall_size"],
        "brackets": [_bracket(b) for b in r["payout_brackets"]],
    }


def _bracket(b: dict) -> dict:
    """One payout bracket, renamed.

    `describe()` writes each bracket as three keys in a fixed order — the faan
    ceiling, the discard column, the self-draw column. The last two are spelled
    in the vocabulary TERMINOLOGY.md bans from this repo, so they are read by
    POSITION rather than by name. The shape is asserted, so a reordering shows
    up as a loud failure here instead of as silently swapped columns in the
    fixture.
    """
    keys = list(b)
    if len(keys) != 3 or keys[0] != "max_fan":
        raise SystemExit(
            f"payout bracket shape changed: expected 3 keys starting with "
            f"max_fan, got {keys}. Re-read the research repo's ruleset "
            f"describe() before trusting this projection."
        )
    return {
        "maxFaan": b[keys[0]],
        "onDiscard": b[keys[1]],
        "selfDrawFigure": b[keys[2]],
    }


def sanitise_line(line: str) -> str:
    """One log line with the two banned-vocabulary fields removed.

    Re-serialised with the writer's own separators and key order, so the result
    is byte-identical to what the Python engine wrote apart from the removed
    keys — and identical field for field on everything the parser reads.
    """
    rec = json.loads(line)
    kind = rec.get("kind")
    if kind == "hand_header":
        for key in _DROP_FROM_HEADER:
            rec.pop(key, None)
    elif kind == "hand_footer":
        for key in _DROP_FROM_FOOTER:
            rec.pop(key, None)
    else:
        for key in _DROP_FROM_ACTION:
            if isinstance(rec.get("action"), dict):
                rec["action"].pop(key, None)
        for key in _DROP_FROM_SCORE:
            if isinstance(rec.get("score"), dict):
                rec["score"].pop(key, None)
    return json.dumps(rec, separators=(",", ":"))


def write_sample(paths: list[str], sample_out: str, hands: int) -> str:
    """Copy verbatim log lines for a few winning hands out of ONE log file.

    Header, the terminal frame, and footer — enough for the TypeScript
    extractor to be checked against the same raw format the Python engine
    writes, without committing megabytes of draw/discard frames.

    One file only, so the case ids the TypeScript extractor derives from the
    file tag line up with the ids in the fixture and the two can be compared
    directly. Returns the tag.

    The result is written as {"tag", "lines"} rather than as a .jsonl file
    because the TypeScript side has no ambient node types available to read a
    file with (the repo carries no @types/node and this harness adds no
    dependencies). Joining `lines` with newlines reconstructs the stream the
    harness parses.

    Each line is what the Python engine wrote, byte for byte, minus the four
    fields `sanitise_line` removes — neither of which the extractor reads. See
    the note above that function.
    """
    def harvest(path: str) -> list[str]:
        out: list[str] = []
        n = 0
        header_line = None
        buf: list[str] = []
        win = False
        with open(path, encoding="utf-8") as f:
            for line in f:
                line = line.rstrip("\n")
                if not line.strip():
                    continue
                rec = json.loads(line)
                kind = rec.get("kind")
                if kind == "hand_header":
                    header_line = sanitise_line(line)
                    buf = []
                    win = False
                elif kind == "hand_footer":
                    if win and header_line is not None and n < hands:
                        out.append(header_line)
                        out.extend(buf)
                        out.append(sanitise_line(line))
                        n += 1
                    header_line = None
                    buf = []
                    win = False
                elif rec.get("score") is not None:
                    buf.append(sanitise_line(line))
                    win = True
        return out

    # ONE file, so the case ids line up with the fixture — but the richest one,
    # not the first. With these bots most hands end in an exhaustive draw, so an
    # early file can log one win or none at all. Ties go to the earlier file, so
    # the choice is deterministic.
    tag = ""
    kept: list[str] = []
    for path in paths:
        got = harvest(path)
        if len(got) > len(kept):
            kept = got
            tag = os.path.splitext(os.path.basename(path))[0]
    taken = len(kept)

    if taken == 0:
        raise SystemExit(
            "no log file in the batch recorded a win, so the sample would prove "
            "nothing. Raise --matches or pick a different --seed."
        )
    os.makedirs(os.path.dirname(sample_out), exist_ok=True)
    with open(sample_out, "w", encoding="utf-8") as f:
        json.dump({"tag": tag, "lines": kept}, f, indent=1)
        f.write("\n")
    return tag


# ---------------------------------------------------------------------------

def main(argv: list[str]) -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--python-repo", required=True)
    p.add_argument("--matches", type=int, default=250)
    p.add_argument("--seed", type=int, default=20260826)
    p.add_argument("--out", required=True)
    p.add_argument("--sample-out", default=None)
    p.add_argument("--sample-hands", type=int, default=8)
    p.add_argument("--max-distance", type=int, default=600)
    p.add_argument("--every-nth-distance", type=int, default=137)
    p.add_argument("--keep-replays", default=None,
                   help="Directory to keep the raw JSONL batch in (default: temp).")
    p.add_argument("--reuse-replays", default=None,
                   help="Skip the batch and re-extract from an existing directory.")
    args = p.parse_args(argv)

    repo = os.path.abspath(args.python_repo)
    if args.reuse_replays:
        tmp = os.path.abspath(args.reuse_replays)
        with open(os.path.join(tmp, "manifest.json"), encoding="utf-8") as f:
            manifest = json.load(f)
        print(f"[fixtures] re-extracting from {tmp} without replaying")
    else:
        tmp = args.keep_replays or tempfile.mkdtemp(prefix="port-diff-batch-")
        os.makedirs(tmp, exist_ok=True)
        manifest = run_batch(repo, tmp, args.matches, args.seed)
    paths = sorted(glob.glob(os.path.join(tmp, "game_*.jsonl")))
    scoring, distance, hands_played = extract(
        paths, args.every_nth_distance, args.max_distance)

    sample_tag = None
    if args.sample_out:
        sample_tag = write_sample(paths, args.sample_out, args.sample_hands)

    fixture = {
        "formatVersion": FORMAT_VERSION,
        "provenance": {
            "generatedBy": "tools/port-diff/generate_fixtures.py",
            "generatedAt": datetime.now(timezone.utc).isoformat(),
            "pythonRepo": repo,
            "batchSeed": args.seed,
            "matches": args.matches,
            "bots": ["greedy"] * 4,
            "handsPlayed": hands_played,
            "handsWon": len(scoring),
            "pythonRuleset": project_ruleset(manifest["ruleset"]),
            "sampleTag": sample_tag,
            "scopeWarning": (
                "Closed-hand LIU subset only. The Python engine has no claims, "
                "no kongs, no flowers and no wind faan, so nothing in this "
                "fixture can validate the canonical HKOS extensions."
            ),
        },
        "scoringCases": scoring,
        "distanceCases": distance,
    }

    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(fixture, f, separators=(",", ":"), sort_keys=False)
        f.write("\n")

    disagree = [d for d in distance if d["exhaustive"] != d["shipped"]]
    by13 = [d for d in distance if d["tiles"] == 13]
    by14 = [d for d in distance if d["tiles"] == 14]
    d13 = [d for d in by13 if d["exhaustive"] != d["shipped"]]
    d14 = [d for d in by14 if d["exhaustive"] != d["shipped"]]
    print(f"[fixtures] hands played      {hands_played}")
    print(f"[fixtures] scoring cases     {len(scoring)}")
    print(f"[fixtures] distance cases    {len(distance)}")
    print(f"[fixtures] cutoff disagrees  {len(disagree)}/{len(distance)}")
    if by13:
        print(f"[fixtures]   13-tile        {len(d13)}/{len(by13)} = {100*len(d13)/len(by13):.1f}%")
    if by14:
        print(f"[fixtures]   14-tile        {len(d14)}/{len(by14)} = {100*len(d14)/len(by14):.1f}%")
    print(f"[fixtures] wrote {args.out}")
    if not args.keep_replays and not args.reuse_replays:
        shutil.rmtree(tmp, ignore_errors=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
