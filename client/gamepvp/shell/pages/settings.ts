/**
 * Game settings (`/me/settings`) — tile size, sound, haptics, count tiles,
 * coaching (desktop-only), language, theme, "not you?" (task brief §11
 * build item 2). Reads/writes the same `SETTINGS` object the in-match quick
 * panel (table.ts's HUD gear button) does, and the same `localStorage`
 * theme key `shell/session.ts`'s `applyTheme()` reads at boot.
 */
import { refreshTableIfLive } from "../../table.js";
import type { PageMount } from "../router.js";
import {
  esc, identity, saveSettings, SETTINGS, applyTheme, getThemeChoice, setThemeChoice, type ThemeChoice,
} from "../session.js";
import { S, t } from "../strings.js";
import { navHtml, pageTop, wireNav } from "../ui.js";

const shellRoot = (): HTMLElement => document.getElementById("shell")!;

function switchHtml(on: boolean, key: string): string {
  return `<button class="switch ${on ? "on" : ""}" data-toggle="${key}" role="switch" aria-checked="${on}"></button>`;
}

export const mount: PageMount = (container, _params, router) => {
  const paint = (): void => {
    container.innerHTML = `
      ${pageTop(t(S.titleSettings), { back: "/me", displayName: identity?.displayName ?? "", unread: 0 })}
      <div class="card">
        <div class="listrow"><span>${esc(t(S.tileSize))}</span>
          <input type="range" id="setScale" min="0.8" max="2" step="0.05" value="${SETTINGS.tileScale}">
          <b id="setScaleV">${Math.round(SETTINGS.tileScale * 100)}%</b></div>
        <div class="listrow"><span>${esc(t(S.sound))}</span>${switchHtml(SETTINGS.sound, "sound")}</div>
        <div class="listrow"><span>${esc(t(S.haptics))}</span>${switchHtml(SETTINGS.haptics, "haptics")}</div>
        <div class="listrow"><span>${esc(t(S.countTilesOnTap))}</span>${switchHtml(SETTINGS.hcCount, "hcCount")}</div>
        <div class="listrow"><span>${esc(t(S.doubleTapDiscardDesktop))}</span>${switchHtml(SETTINGS.discardDoubleTapDesktop, "discardDoubleTapDesktop")}</div>
        <div class="listrow"><span>${esc(t(S.doubleTapDiscardPhone))}</span>${switchHtml(SETTINGS.discardDoubleTapMobile, "discardDoubleTapMobile")}</div>
        <div class="listrow"><span>${esc(t(S.coachingDesktop))}</span>${switchHtml(SETTINGS.coaching, "coaching")}</div>
        <div class="listrow"><span>${esc(t(S.language))}</span>
          <select id="setLang"><option value="en" ${SETTINGS.language === "en" ? "selected" : ""}>English</option><option value="zh" ${SETTINGS.language === "zh" ? "selected" : ""}>中文</option></select></div>
        <div class="listrow"><span>${esc(t(S.theme))}</span>
          <select id="setTheme">
            <option value="system" ${getThemeChoice() === "system" ? "selected" : ""}>${esc(t(S.themeSystem))}</option>
            <option value="light" ${getThemeChoice() === "light" ? "selected" : ""}>${esc(t(S.themeLight))}</option>
            <option value="dark" ${getThemeChoice() === "dark" ? "selected" : ""}>${esc(t(S.themeDark))}</option>
          </select></div>
        <div class="listrow"><a href="#" id="notYou" class="more">${esc(t(S.notYou))}</a></div>
      </div>
      ${navHtml("/")}`;
    wireNav(container, router);

    const scale = document.getElementById("setScale") as HTMLInputElement;
    scale.oninput = () => {
      SETTINGS.tileScale = Number(scale.value);
      document.getElementById("setScaleV")!.textContent = `${Math.round(SETTINGS.tileScale * 100)}%`;
      saveSettings(); refreshTableIfLive();
    };
    for (const el of Array.from(container.querySelectorAll<HTMLElement>("[data-toggle]"))) {
      el.onclick = () => {
        const key = el.dataset.toggle as
          "sound" | "haptics" | "hcCount" | "coaching" | "discardDoubleTapDesktop" | "discardDoubleTapMobile";
        (SETTINGS as unknown as Record<string, boolean>)[key] = !SETTINGS[key];
        saveSettings(); refreshTableIfLive();
        el.classList.toggle("on", SETTINGS[key]);
      };
    }
    (document.getElementById("setLang") as HTMLSelectElement).onchange = (e) => {
      SETTINGS.language = (e.target as HTMLSelectElement).value as "en" | "zh";
      saveSettings();
      paint();
    };
    (document.getElementById("setTheme") as HTMLSelectElement).onchange = (e) => {
      setThemeChoice(shellRoot(), (e.target as HTMLSelectElement).value as ThemeChoice);
    };
    document.getElementById("notYou")!.addEventListener("click", (e) => {
      e.preventDefault();
      if (!window.confirm("Start a new player on this device? Your current name stays recorded on the games you already played.")) return;
      localStorage.removeItem("mjrc.gamepvp.deviceToken");
      localStorage.removeItem("mjrc.gamepvp.displayName");
      localStorage.removeItem("mjrc.gamepvp.playerId");
      location.href = "/";
    });
  };
  paint();
  applyTheme(shellRoot(), getThemeChoice());
};
