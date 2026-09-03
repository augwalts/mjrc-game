/** Account (`/me/account`) — the lab's own list, each row a stub until the
 *  site's account section exists (lobby-lab.html's own note: "verify the
 *  list against the live site before building"). The profile picture row
 *  (owner request 2026-09-03) is the one row here that is actually wired:
 *  crop-to-square/resize/encode happens entirely client-side, then
 *  `POST /api/identity`'s `avatar` field does the save (net.ts `identify`,
 *  worker/src/index.ts `parseAvatarField`). */
import { identify as apiIdentify } from "../../net.js";
import type { PageMount } from "../router.js";
import { esc, identity, setIdentity, tzOffsetMin } from "../session.js";
import { S, t } from "../strings.js";
import { avatarHtml, navHtml, pageTop, wireNav } from "../ui.js";

/** Final size (schema.sql players.avatar's own limit is the byte cap; 128×128
 *  is plenty for a 28-44px on-screen avatar at any device pixel ratio worth
 *  bothering with). */
const AVATAR_SIDE = 128;
const AVATAR_MAX_BYTES = 12 * 1024;
/** Tried in order until one lands under the byte cap — JPEG quality, not
 *  resolution: a blurrier 128×128 still reads fine at 28-44px on screen,
 *  where re-shrinking the canvas would not buy back much and complicates the
 *  crop math for no reason. */
const AVATAR_QUALITIES = [0.8, 0.65, 0.5];

class AvatarError extends Error {
  constructor(public readonly reason: "decode" | "too_big") { super(reason); }
}

/** File → a centred-square, 128×128, JPEG data URI under 12 KB, or throws
 *  `AvatarError`. Never touches the network — this is pure client-side
 *  image work, same "the client does the crop, the server just stores
 *  bytes" split `worker/src/index.ts`'s `parseAvatarField` doc comment
 *  describes from the other side. */
async function fileToAvatarDataUri(file: File): Promise<string> {
  const objectUrl = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new AvatarError("decode"));
      el.src = objectUrl;
    });
    const side = Math.min(img.naturalWidth, img.naturalHeight);
    if (side <= 0) throw new AvatarError("decode");
    const sx = (img.naturalWidth - side) / 2;
    const sy = (img.naturalHeight - side) / 2;
    const canvas = document.createElement("canvas");
    canvas.width = AVATAR_SIDE;
    canvas.height = AVATAR_SIDE;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new AvatarError("decode");
    ctx.drawImage(img, sx, sy, side, side, 0, 0, AVATAR_SIDE, AVATAR_SIDE);
    for (const quality of AVATAR_QUALITIES) {
      const dataUri = canvas.toDataURL("image/jpeg", quality);
      const b64 = dataUri.slice(dataUri.indexOf(",") + 1);
      const pad = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
      const bytes = Math.floor((b64.length * 3) / 4) - pad;
      if (bytes > 0 && bytes <= AVATAR_MAX_BYTES) return dataUri;
    }
    throw new AvatarError("too_big");
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

export const mount: PageMount = (container, _params, router) => {
  let busy = false;
  let error: string | null = null;

  const paint = (): void => {
    const name = identity?.displayName ?? "";
    container.innerHTML = `
      ${pageTop(t(S.titleAccount), { back: "/me", displayName: name, unread: 0 })}
      <div class="card">
        <div class="listrow">
          <span>${esc(t(S.profilePicture))}</span>
          <span class="avatar-lg avatar-pick">${avatarHtml(name, identity?.avatar)}</span>
        </div>
        <div class="row" style="gap:8px;padding:2px 0 8px">
          <button class="sit sm" id="avatarChoose" ${busy ? "disabled" : ""}>${esc(busy ? t(S.pictureSaving) : t(S.choosePicture))}</button>
          ${identity?.avatar ? `<button class="sit sm ghost" id="avatarRemove" ${busy ? "disabled" : ""}>${esc(t(S.removePicture))}</button>` : ""}
          <input type="file" accept="image/*" capture="environment" id="avatarFile" hidden>
        </div>
        <p class="mut" style="font-size:11px;margin:0 0 8px">${esc(t(S.pictureSizeHint))}</p>
        ${error ? `<p style="color:var(--red);font-size:12px;margin:0 0 8px">${esc(error)}</p>` : ""}
        <div class="listrow"><span>${esc(t(S.displayName))}</span><b>${esc(identity?.displayName ?? "—")} ›</b></div>
        <div class="listrow"><span>${esc(t(S.handle))}</span><b>@${esc((identity?.displayName ?? "you").toLowerCase().replace(/\s+/g, ""))} ›</b></div>
        <div class="listrow"><span>${esc(t(S.signIn))}</span><b class="mut">${esc(t(S.notLinked))} · Google ›</b></div>
        <div class="listrow"><span>${esc(t(S.devicesWithAccess))}</span><b>this device ›</b></div>
        <div class="listrow"><span>${esc(t(S.almanacProfile))}</span><b class="mut">${esc(t(S.notLinked))} ›</b></div>
        <div class="listrow"><span>${esc(t(S.exportData))}</span><b>›</b></div>
        <div class="listrow"><span>${esc(t(S.deleteAccount))}</span><b style="color:var(--red)">›</b></div>
      </div>
      <p class="mut" style="margin-top:8px;font-size:12px">${esc(t(S.accountFooter))}</p>
      ${navHtml("/")}`;
    wireNav(container, router);

    const fileInput = container.querySelector<HTMLInputElement>("#avatarFile");
    const chooseBtn = container.querySelector<HTMLButtonElement>("#avatarChoose");
    const removeBtn = container.querySelector<HTMLButtonElement>("#avatarRemove");

    chooseBtn?.addEventListener("click", () => fileInput?.click());

    fileInput?.addEventListener("change", () => {
      const file = fileInput.files?.[0] ?? null;
      fileInput.value = "";
      if (!file || busy) return;
      busy = true; error = null; paint();
      void (async () => {
        try {
          const dataUri = await fileToAvatarDataUri(file);
          const next = await apiIdentify(null, tzOffsetMin(), dataUri);
          setIdentity(next);
        } catch (e) {
          error = e instanceof AvatarError && e.reason === "too_big" ? t(S.pictureTooBig) : t(S.pictureUploadFailed);
        } finally {
          busy = false; paint();
        }
      })();
    });

    removeBtn?.addEventListener("click", () => {
      if (busy) return;
      busy = true; error = null; paint();
      void (async () => {
        try {
          const next = await apiIdentify(null, tzOffsetMin(), null);
          setIdentity(next);
        } catch {
          error = t(S.pictureUploadFailed);
        } finally {
          busy = false; paint();
        }
      })();
    });
  };

  paint();
};
