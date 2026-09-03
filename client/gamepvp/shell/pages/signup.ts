/**
 * Sign-up (ACCOUNTS-GAME-SIGNIN-2026-09-04 §4) — one screen, shown to a
 * visitor who HAS a Google session but no `onboarded_at` yet. The router
 * forces every other path here while `authState === "needs-signup"`, so this
 * is the only page that state can reach; there is no way to skip it and no
 * way back except signing out.
 *
 * Rows reuse the New table modal's own `.nt-row`/`.nt-seg` geometry
 * (shell/theme.css) rather than declaring a second form idiom — the two
 * screens should feel like the same app, and the label/control grid is
 * already solved there.
 *
 * The handle field is the only thing here that talks to the network before
 * submit: a 300 ms debounce onto `GET /api/handles/:h`, with a sequence
 * number so a slow early reply can never overwrite a fast later one. The
 * check is advisory — the server takes the handle atomically at
 * `POST /api/signup` and can still answer `handle_taken`, which lands back on
 * this field as "that handle was just taken".
 */
import {
  ApiError, HANDLE_RE, checkHandle, identityFromMe, normaliseHandle, signup, storedIdentity,
  type AccountLanguage,
} from "../../net.js";
import type { PageMount } from "../router.js";
import {
  account, esc, saveSettings, setAccount, setAuthState, setIdentity, SETTINGS,
} from "../session.js";
import { S, t, tAlt } from "../strings.js";
import { avatarHtml } from "../ui.js";
import { PRIVACY_URL, TERMS_URL, safeNext } from "./signin.js";

const DEBOUNCE_MS = 300;

type HandleState = "empty" | "invalid" | "checking" | "available" | "taken" | "reserved";

/** An English label with its 中文 under it — this page is the one place a
 *  player has not told us what they read yet (the language control is ON it),
 *  so both go on screen. */
function label(entry: { en: string; zh: string | null }): string {
  const alt = tAlt(entry);
  return `<span>${esc(t(entry))}${alt ? `<span class="su-zh">${esc(alt)}</span>` : ""}</span>`;
}

export const mount: PageMount = (container, params, router) => {
  const next = safeNext(params.next);
  const source = params.source || undefined;

  const state = {
    displayName: account?.displayName ?? "",
    handle: "",
    language: (SETTINGS.language === "zh" || /^zh/i.test(navigator.language || "") ? "zh" : "en") as AccountLanguage,
    terms: false,
    marketing: false,
    busy: false,
    error: null as string | null,
    handleState: "empty" as HandleState,
  };
  SETTINGS.language = state.language;

  let debounce = 0;
  let checkSeq = 0;
  let alive = true;

  const handleMsg = (): { text: string; cls: string } => {
    switch (state.handleState) {
      case "checking": return { text: t(S.handleChecking), cls: "" };
      case "available": return { text: t(S.handleAvailable), cls: "ok" };
      case "taken": return { text: t(S.handleTaken), cls: "bad" };
      case "reserved": return { text: t(S.handleReserved), cls: "bad" };
      case "invalid": return { text: t(S.handleInvalid), cls: "bad" };
      default: return { text: t(S.handleRule), cls: "" };
    }
  };

  const paintHandleMsg = (): void => {
    const el = container.querySelector<HTMLElement>("#suHandleMsg");
    if (!el) return;
    const m = handleMsg();
    el.className = `su-status ${m.cls}`;
    el.textContent = m.text;
  };

  const runCheck = (raw: string): void => {
    const h = normaliseHandle(raw);
    if (!h) { state.handleState = "empty"; paintHandleMsg(); return; }
    if (!HANDLE_RE.test(h)) { state.handleState = "invalid"; paintHandleMsg(); return; }
    state.handleState = "checking";
    paintHandleMsg();
    const seq = ++checkSeq;
    void checkHandle(h)
      .then((r) => {
        if (!alive || seq !== checkSeq) return;
        state.handleState = r.available ? "available" : r.reason === "reserved" ? "reserved" : r.reason === "invalid" ? "invalid" : "taken";
        paintHandleMsg();
      })
      .catch(() => {
        if (!alive || seq !== checkSeq) return;
        // The server is the authority and will check again at submit — a
        // failed availability probe must not block the form.
        state.handleState = "empty";
        paintHandleMsg();
      });
  };

  const submit = async (): Promise<void> => {
    const name = state.displayName.trim();
    const handle = normaliseHandle(state.handle);
    if (!name) { state.error = t(S.signupNeedName); paint(); return; }
    if (!HANDLE_RE.test(handle) || state.handleState === "taken" || state.handleState === "reserved") {
      state.error = t(S.signupNeedHandle); paint(); return;
    }
    if (!state.terms) { state.error = t(S.signupNeedConsent); paint(); return; }
    state.busy = true; state.error = null; paint();
    try {
      const me = await signup({
        displayName: name.slice(0, 40),
        handle,
        language: state.language,
        consents: { terms: true, privacy: true, marketing: state.marketing },
        ...(source ? { source } : {}),
        ...(storedIdentity().deviceToken ? { deviceToken: storedIdentity().deviceToken! } : {}),
      });
      setAccount(me.user);
      setIdentity(identityFromMe(me));
      setAuthState("ready");
      SETTINGS.language = state.language;
      saveSettings();
      router.navigate(next, { replace: true });
    } catch (e) {
      const code = e instanceof ApiError ? e.code : "";
      if (code === "handle_taken") {
        state.handleState = "taken";
        state.error = t(S.handleTakenJust);
      } else {
        state.error = `${t(S.signupFailed)}${code ? ` — ${code}` : ""}`;
      }
      state.busy = false;
      paint();
    }
  };

  const paint = (): void => {
    const consent = esc(t(S.consentLabel))
      .replace("{terms}", `<a href="${TERMS_URL}" target="_blank" rel="noopener">${esc(t(S.termsWord))}</a>`)
      .replace("{privacy}", `<a href="${PRIVACY_URL}" target="_blank" rel="noopener">${esc(t(S.privacyWord))}</a>`);
    const dis = state.busy ? "disabled" : "";
    const pic = account?.picture
      ? `<img class="avatar avatar-img su-pic-img" src="${esc(account.picture)}" alt="">`
      : avatarHtml(state.displayName || account?.displayName || "?", null);
    const m = handleMsg();

    container.innerHTML = `
      <div class="si-wrap">
        <div class="si-card su-card">
          <div class="si-mark">${esc(t(S.siteMark))}</div>
          <h2 class="su-title">${esc(t(S.signupTitle))}</h2>
          <p class="si-lede">${esc(t(S.signupLede))}</p>

          <div class="nt-row">${label(S.displayName)}
            <input id="suName" class="nt-txt" type="text" maxlength="40" ${dis}
                   value="${esc(state.displayName)}" autocomplete="nickname"></div>

          <div class="nt-row">${label(S.handle)}
            <span class="su-handle"><span class="su-at">@</span>
              <input id="suHandle" class="nt-txt" type="text" maxlength="20" ${dis}
                     value="${esc(state.handle)}" autocomplete="off" autocapitalize="none"
                     autocorrect="off" spellcheck="false" placeholder="yourname"></span></div>
          <div class="nt-row su-sub"><span></span><span id="suHandleMsg" class="su-status ${m.cls}">${esc(m.text)}</span></div>

          <div class="nt-row">${label(S.profilePicture)}
            <span class="su-pic">${pic}<small>${esc(t(S.pictureFromGoogle))}</small></span></div>

          <div class="nt-row">${label(S.language)}
            <span class="nt-seg" id="suLang">
              <button type="button" data-lang="en" class="${state.language === "en" ? "on" : ""}" ${dis}>English</button>
              <button type="button" data-lang="zh" class="${state.language === "zh" ? "on" : ""}" ${dis}>中文</button>
            </span></div>

          <label class="su-check"><input type="checkbox" id="suTerms" ${state.terms ? "checked" : ""} ${dis}><span>${consent}</span></label>
          <label class="su-check"><input type="checkbox" id="suMkt" ${state.marketing ? "checked" : ""} ${dis}><span>${esc(t(S.marketingLabel))}</span></label>

          ${state.error ? `<p class="su-err">${esc(state.error)}</p>` : ""}
          <button class="si-google su-go" id="suGo" ${dis}>${esc(state.busy ? t(S.signingUp) : t(S.startPlaying))}</button>
        </div>
      </div>`;

    const nameIn = container.querySelector<HTMLInputElement>("#suName")!;
    nameIn.oninput = () => { state.displayName = nameIn.value; };
    const handleIn = container.querySelector<HTMLInputElement>("#suHandle")!;
    handleIn.oninput = () => {
      state.handle = handleIn.value;
      window.clearTimeout(debounce);
      const raw = handleIn.value;
      debounce = window.setTimeout(() => runCheck(raw), DEBOUNCE_MS);
    };
    for (const b of Array.from(container.querySelectorAll<HTMLButtonElement>("#suLang button"))) {
      b.onclick = () => {
        state.language = b.dataset.lang === "zh" ? "zh" : "en";
        SETTINGS.language = state.language;
        saveSettings();
        paint();
      };
    }
    container.querySelector<HTMLInputElement>("#suTerms")!.onchange = (e) => {
      state.terms = (e.target as HTMLInputElement).checked;
    };
    container.querySelector<HTMLInputElement>("#suMkt")!.onchange = (e) => {
      state.marketing = (e.target as HTMLInputElement).checked;
    };
    container.querySelector<HTMLButtonElement>("#suGo")!.onclick = () => { void submit(); };
  };

  paint();
  return () => { alive = false; window.clearTimeout(debounce); };
};
