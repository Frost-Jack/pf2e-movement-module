const MODULE_ID = "pf2e-movement-module";
const MAX_LEAP_HEIGHT_FEET = 8;
const HEIGHT_FLAG_SCOPE = "wall-height";

const SPECIAL_ACTIONS = new Set(["jump", "fly", "blink"]);

function getWallHeight(wallDoc) {
  const flags = wallDoc.flags?.[HEIGHT_FLAG_SCOPE];
  if (!flags) return null;
  const top = flags.top;
  const bottom = flags.bottom;
  if (typeof top !== "number" || !Number.isFinite(top)) return null;
  const base = typeof bottom === "number" && Number.isFinite(bottom) ? bottom : 0;
  return top - base;
}

function isWallIgnored(wallDoc, action) {
  if (action === "blink") return true;

  if (action === "fly") {
    return wallDoc.sight === CONST.WALL_SENSE_TYPES.NONE;
  }

  if (action === "jump") {
    const height = getWallHeight(wallDoc);
    if (height === null) return false;
    return height <= MAX_LEAP_HEIGHT_FEET;
  }

  return false;
}

function segmentBlockedByWall(origin, destination, action) {
  const walls = canvas?.walls?.placeables;
  if (!walls?.length) return false;

  const a = { x: origin.x, y: origin.y };
  const b = { x: destination.x, y: destination.y };

  for (const wall of walls) {
    const doc = wall.document;

    if (doc.move === CONST.WALL_MOVEMENT_TYPES.NONE) continue;
    if (doc.door !== CONST.WALL_DOOR_TYPES.NONE && doc.ds === CONST.WALL_DOOR_STATES.OPEN) continue;

    if (isWallIgnored(doc, action)) continue;

    const [x1, y1, x2, y2] = doc.c;
    const w1 = { x: x1, y: y1 };
    const w2 = { x: x2, y: y2 };

    if (foundry.utils.lineSegmentIntersects(a, b, w1, w2)) return true;
  }

  return false;
}

function isPointVisibleTo(token, point) {
  const visibility = canvas?.visibility;
  if (!visibility) return true;
  try {
    return visibility.testVisibility(point, { tolerance: 2, object: token });
  } catch (_err) {
    return true;
  }
}


function configureMovementActions() {
  const actions = CONFIG?.Token?.movement?.actions;
  if (!actions) return;

  if (actions.fly) {
    actions.fly.walls = null;
    actions.fly.canSelect = (tokenDoc) => !!tokenDoc?.actor?.isOfType?.("creature");
  }
  if (actions.jump) actions.jump.walls = null;
  if (actions.blink) actions.blink.walls = null;
}

function patchConstrainMovementPath() {
  const baseToken = foundry?.canvas?.placeables?.Token;
  const TokenClass = baseToken?.prototype?.constrainMovementPath
    ? baseToken
    : CONFIG?.Token?.objectClass;
  if (!TokenClass?.prototype?.constrainMovementPath) return;

  const original = TokenClass.prototype.constrainMovementPath;

  TokenClass.prototype.constrainMovementPath = function (waypoints, options = {}) {
    const [path, constrained] = original.call(this, waypoints, options);
    if (options.ignoreWalls) return [path, constrained];
    if (!Array.isArray(path) || path.length < 2) return [path, constrained];

    const out = [path[0]];
    let truncated = false;

    for (let i = 1; i < path.length; i++) {
      const prev = path[i - 1];
      const curr = path[i];
      const action = curr.action ?? prev.action ?? this.document.movementAction;

      if (SPECIAL_ACTIONS.has(action)) {
        const origin = this.document.getCenterPoint(prev);
        const destination = this.document.getCenterPoint(curr);

        if (action === "blink") {
          if (!isPointVisibleTo(this, destination)) {
            truncated = true;
            break;
          }
        } else if (segmentBlockedByWall(origin, destination, action)) {
          truncated = true;
          break;
        }
      }

      out.push(curr);
    }

    return [out, constrained || truncated];
  };
}

function registerPreMoveTokenHook() {
  Hooks.on("preMoveToken", (tokenDoc, movement /* , operation */) => {
    const passed = movement?.passed?.waypoints;
    if (!Array.isArray(passed) || passed.length === 0) return true;

    const token = tokenDoc.object;
    let prevPoint = tokenDoc.getCenterPoint(movement.origin);

    for (const wp of passed) {
      const action = wp.action ?? tokenDoc.movementAction;
      const point = tokenDoc.getCenterPoint(wp);

      if (SPECIAL_ACTIONS.has(action)) {
        if (action === "blink") {
          if (token && !isPointVisibleTo(token, point)) {
            ui.notifications?.warn(game.i18n.localize(`${MODULE_ID}.warnings.teleportNotVisible`));
            return false;
          }
        } else if (segmentBlockedByWall(prevPoint, point, action)) {
          const key = action === "fly"
            ? `${MODULE_ID}.warnings.flyBlocked`
            : `${MODULE_ID}.warnings.leapBlocked`;
          ui.notifications?.warn(game.i18n.localize(key));
          return false;
        }
      }

      prevPoint = point;
    }

    return true;
  });
}

const EMOJI_ROOT = "assets/emoji";
const EMOJI_EXT_RE = /\.(png|jpe?g|gif|webp|svg)$/i;
const EMOJI_DURATION_MS = 4000;
const EMOJI_FADE_MS = 350;
const EMOJI_POP_MS = 220;
const EMOJI_BOB_PERIOD_MS = 2000;

const SOCKET_NAME = `module.${MODULE_ID}`;

function getFilePicker() {
  return foundry?.applications?.apps?.FilePicker?.implementation ?? globalThis.FilePicker;
}

function userEmojiPath(userId) {
  return `${EMOJI_ROOT}/${userId}`;
}

async function ensureUserEmojiDirAsGM(userId) {
  const FP = getFilePicker();
  if (!FP) return;
  for (const dir of ["assets", EMOJI_ROOT, userEmojiPath(userId)]) {
    try { await FP.createDirectory("data", dir); } catch (_e) { /* exists, ignore */ }
  }
}

function requestEmojiDirFromGM(userId) {
  return new Promise(resolve => {
    if (!game.socket) return resolve(false);
    const requestId = foundry.utils.randomID();
    let settled = false;
    const onAck = (data) => {
      if (settled) return;
      if (data?.type === "ensure-emoji-dir-ack" && data.requestId === requestId) {
        settled = true;
        game.socket.off(SOCKET_NAME, onAck);
        resolve(true);
      }
    };
    game.socket.on(SOCKET_NAME, onAck);
    game.socket.emit(SOCKET_NAME, { type: "ensure-emoji-dir", userId, requestId });
    setTimeout(() => {
      if (settled) return;
      settled = true;
      game.socket.off(SOCKET_NAME, onAck);
      resolve(false);
    }, 7000);
  });
}

async function listEmojiFiles(userId) {
  const FP = getFilePicker();
  if (!FP) return [];
  try {
    const result = await FP.browse("data", userEmojiPath(userId));
    return (result?.files ?? []).filter(f => EMOJI_EXT_RE.test(f));
  } catch (_e) {
    return [];
  }
}

async function uploadEmojiFile(userId, file) {
  const FP = getFilePicker();
  if (!FP) throw new Error("FilePicker is unavailable");
  const path = userEmojiPath(userId);

  if (game.user.isGM) {
    await ensureUserEmojiDirAsGM(userId);
    return FP.upload("data", path, file, {}, { notify: false });
  }

  try {
    return await FP.upload("data", path, file, {}, { notify: false });
  } catch (err) {
    if (!/does not exist/i.test(err?.message ?? "")) throw err;
    if (!game.users.some(u => u.isGM && u.active)) {
      throw new Error(game.i18n.localize(`${MODULE_ID}.emoji.manager.noGM`));
    }
    const created = await requestEmojiDirFromGM(userId);
    if (!created) throw new Error(game.i18n.localize(`${MODULE_ID}.emoji.manager.noGM`));
    return FP.upload("data", path, file, {}, { notify: false });
  }
}


const STYLE_HEADER = "padding:0.5rem 0.75rem !important;display:flex !important;flex-direction:column !important;gap:0.25rem !important;border-bottom:1px solid var(--color-border-light,#999) !important;";
const STYLE_HEADER_P = "margin:0 !important;";
const STYLE_PATH = "font-size:0.85em !important;opacity:0.7 !important;word-break:break-all !important;";
const STYLE_TOOLBAR = "padding:0.5rem 0.75rem !important;display:flex !important;gap:0.5rem !important;align-items:center !important;";
const STYLE_BODY = "padding:0.5rem 0.75rem !important;overflow-y:auto !important;";
const STYLE_FOOTER = "padding:0.4rem 0.75rem !important;border-top:1px solid var(--color-border-light,#999) !important;opacity:0.7 !important;";
const STYLE_EMPTY = "text-align:center !important;opacity:0.6 !important;padding:1.5rem 0.5rem !important;";
const STYLE_GRID = "display:grid !important;grid-template-columns:repeat(auto-fill,minmax(80px,1fr)) !important;gap:0.5rem !important;";
const STYLE_CARD = "margin:0 !important;padding:0.4rem !important;display:flex !important;flex-direction:column !important;align-items:center !important;gap:0.25rem !important;border:1px solid var(--color-border-light,#999) !important;border-radius:4px !important;background:rgba(0,0,0,0.05) !important;";
const STYLE_CARD_IMG = "width:64px !important;height:64px !important;object-fit:contain !important;";
const STYLE_CARD_CAP = "font-size:0.7em !important;text-align:center !important;word-break:break-all !important;max-width:80px !important;opacity:0.8 !important;";
const STYLE_PICKER_GRID = "display:grid !important;grid-template-columns:repeat(auto-fill,minmax(80px,1fr)) !important;gap:0.5rem !important;padding:0.5rem !important;";
const STYLE_CELL = "width:72px !important;height:72px !important;padding:0.25rem !important;border:1px solid transparent !important;border-radius:6px !important;background:rgba(0,0,0,0.04) !important;cursor:pointer !important;display:flex !important;align-items:center !important;justify-content:center !important;";
const STYLE_CELL_IMG = "width:100% !important;height:100% !important;object-fit:contain !important;pointer-events:none !important;";


async function emojiManagerOnPickAndUpload(_event, _target) {
  const app = this;
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "image/png,image/jpeg,image/gif,image/webp,image/svg+xml";
  input.multiple = true;
  input.addEventListener("change", async () => {
    const files = Array.from(input.files ?? []);
    if (!files.length) return;
    let uploaded = 0;
    for (const file of files) {
      try {
        await uploadEmojiFile(game.user.id, file);
        uploaded++;
      } catch (err) {
        console.error(`${MODULE_ID} | upload failed`, err);
        ui.notifications?.error(game.i18n.format(`${MODULE_ID}.emoji.manager.uploadFailed`,
          { name: file.name }));
      }
    }
    if (uploaded > 0) {
      ui.notifications?.info(game.i18n.format(`${MODULE_ID}.emoji.manager.uploaded`, { count: uploaded }));
    }
    app.render();
  }, { once: true });
  input.click();
}

function emojiManagerOnRefresh(_event, _target) {
  this.render();
}

async function emojiPickerOnSend(_event, target) {
  const src = target?.dataset?.src;
  if (!src) return;
  const tokenId = pickActiveTokenId();
  if (!tokenId) {
    ui.notifications?.warn(game.i18n.localize(`${MODULE_ID}.emoji.picker.noToken`));
    return;
  }
  broadcastEmoji({ src, tokenId, sceneId: canvas.scene?.id });
  this.close();
}

class EmojiManagerApp extends foundry.applications.api.ApplicationV2 {
  static DEFAULT_OPTIONS = {
    id: "pf2emm-emoji-manager",
    tag: "div",
    classes: ["pf2emm", "pf2emm-emoji-manager"],
    window: {
      title: `${MODULE_ID}.emoji.manager.title`,
      icon: "fa-solid fa-face-smile",
      resizable: true
    },
    position: { width: 540, height: 480 },
    actions: {
      pickAndUpload: emojiManagerOnPickAndUpload,
      refresh: emojiManagerOnRefresh
    }
  };

  async _prepareContext(_options) {
    const userId = game.user.id;
    const files = await listEmojiFiles(userId);
    return {
      userId,
      userName: game.user.name,
      path: userEmojiPath(userId),
      emojis: files.map(src => ({ src, name: src.split("/").pop() })),
      hasEmojis: files.length > 0
    };
  }

  async _renderHTML(context, _options) {
    const esc = foundry.utils.escapeHTML;
    const empty = `<p class="pf2emm-empty" style="${STYLE_EMPTY}">${game.i18n.localize(`${MODULE_ID}.emoji.manager.empty`)}</p>`;
    const grid = context.hasEmojis
      ? `<div class="pf2emm-emoji-grid" style="${STYLE_GRID}">${context.emojis.map(e => `
          <figure class="pf2emm-emoji-card" style="${STYLE_CARD}" title="${esc(e.name)}">
            <img src="${esc(e.src)}" alt="${esc(e.name)}" style="${STYLE_CARD_IMG}">
            <figcaption style="${STYLE_CARD_CAP}">${esc(e.name)}</figcaption>
          </figure>`).join("")}</div>`
      : empty;

    return `
      <header class="pf2emm-header" style="${STYLE_HEADER}">
        <p style="${STYLE_HEADER_P}">${game.i18n.format(`${MODULE_ID}.emoji.manager.intro`, { user: esc(context.userName) })}</p>
        <code class="pf2emm-path" style="${STYLE_PATH}">${esc(context.path)}</code>
      </header>
      <section class="pf2emm-toolbar" style="${STYLE_TOOLBAR}">
        <button type="button" data-action="pickAndUpload">
          <i class="fa-solid fa-upload"></i> ${game.i18n.localize(`${MODULE_ID}.emoji.manager.upload`)}
        </button>
        <button type="button" data-action="refresh">
          <i class="fa-solid fa-rotate"></i> ${game.i18n.localize(`${MODULE_ID}.emoji.manager.refresh`)}
        </button>
      </section>
      <section class="pf2emm-body" style="${STYLE_BODY}">${grid}</section>
      <footer class="pf2emm-footer" style="${STYLE_FOOTER}">
        <small>${game.i18n.localize(`${MODULE_ID}.emoji.manager.deleteHint`)}</small>
      </footer>
    `;
  }

  _replaceHTML(result, content, _options) {
    content.innerHTML = result;
  }
}

class EmojiPickerApp extends foundry.applications.api.ApplicationV2 {
  static DEFAULT_OPTIONS = {
    id: "pf2emm-emoji-picker",
    tag: "div",
    classes: ["pf2emm", "pf2emm-emoji-picker"],
    window: {
      title: `${MODULE_ID}.emoji.picker.title`,
      icon: "fa-solid fa-face-smile-beam",
      resizable: false
    },
    position: { width: 460, height: "auto" },
    actions: {
      send: emojiPickerOnSend
    }
  };

  async _prepareContext(_options) {
    const files = await listEmojiFiles(game.user.id);
    return {
      hasEmojis: files.length > 0,
      emojis: files.map(src => ({ src, name: src.split("/").pop() }))
    };
  }

  async _renderHTML(context, _options) {
    const esc = foundry.utils.escapeHTML;
    if (!context.hasEmojis) {
      return `<p class="pf2emm-empty" style="${STYLE_EMPTY}">${game.i18n.localize(`${MODULE_ID}.emoji.picker.empty`)}</p>`;
    }
    const cells = context.emojis.map(e => `
      <button type="button" class="pf2emm-emoji-cell" style="${STYLE_CELL}" data-action="send"
              data-src="${esc(e.src)}"
              title="${esc(e.name)}">
        <img src="${esc(e.src)}" alt="${esc(e.name)}" style="${STYLE_CELL_IMG}">
      </button>`).join("");
    return `<div class="pf2emm-emoji-grid pf2emm-picker-grid" style="${STYLE_PICKER_GRID}">${cells}</div>`;
  }

  _replaceHTML(result, content, _options) {
    content.innerHTML = result;
  }
}


function pickActiveTokenId() {
  const controlled = canvas?.tokens?.controlled?.[0];
  if (controlled) return controlled.id;
  const character = game.user.character;
  if (character) {
    const t = canvas?.tokens?.placeables?.find(tk => tk.actor?.id === character.id);
    if (t) return t.id;
  }
  return null;
}

function broadcastEmoji(payload) {
  if (!payload?.tokenId || !payload?.sceneId || !payload?.src) return;
  const message = { type: "emoji", ...payload };
  showEmojiOnToken(payload);
  game.socket?.emit(SOCKET_NAME, message);
}

function registerEmojiSocket() {
  game.socket?.on(SOCKET_NAME, async (data) => {
    if (!data || typeof data !== "object") return;

    if (data.type === "emoji") {
      showEmojiOnToken(data);
      return;
    }

    if (data.type === "ensure-emoji-dir") {
      if (!game.user.isGM) return;
      const activeGM = game.users.activeGM;
      if (activeGM && activeGM.id !== game.user.id) return;
      try {
        await ensureUserEmojiDirAsGM(data.userId);
      } catch (err) {
        console.warn(`${MODULE_ID} | could not ensure emoji dir for ${data.userId}`, err);
      }
      game.socket.emit(SOCKET_NAME, {
        type: "ensure-emoji-dir-ack",
        userId: data.userId,
        requestId: data.requestId
      });
      return;
    }
  });
}


async function provisionAllUserDirsAsGM() {
  if (!game.user.isGM) return;
  const FP = getFilePicker();
  if (!FP) return;
  for (const dir of ["assets", EMOJI_ROOT]) {
    try { await FP.createDirectory("data", dir); } catch (_e) { /* exists */ }
  }
  for (const user of game.users) {
    try { await FP.createDirectory("data", userEmojiPath(user.id)); }
    catch (_e) { /* exists */ }
  }
}


const EMOJI_WIDTH_FRACTION = 0.8;
const EMOJI_BOB_FRACTION = 0.05;

function imageReady(img) {
  if (img.complete && img.naturalWidth > 0) return Promise.resolve();
  return new Promise(resolve => {
    img.addEventListener("load", () => resolve(), { once: true });
    img.addEventListener("error", () => resolve(), { once: true });
  });
}

async function showEmojiOnToken({ src, tokenId, sceneId }) {
  if (!src || !tokenId) return;
  if (sceneId && canvas?.scene?.id !== sceneId) return;
  const token = canvas?.tokens?.get(tokenId);
  if (!token) return;

  const hud = document.getElementById("hud");
  if (!hud) return;

  const img = document.createElement("img");
  img.src = src;
  img.alt = "";
  img.draggable = false;
  img.style.cssText = [
    "position:absolute !important",
    "pointer-events:none !important",
    "user-select:none !important",
    "transform-origin:center bottom !important",
    "object-fit:contain !important",
    "will-change:transform,opacity,left,top !important",
    "image-rendering:auto !important",
    "z-index:5 !important"
  ].join(";");
  hud.appendChild(img);

  await imageReady(img);
  if (!img.naturalWidth) {
    img.remove();
    return;
  }

  const tokenW = token.w ?? token.bounds?.width ?? canvas.grid.size;
  const ratio = img.naturalHeight / img.naturalWidth;
  const emojiW = tokenW * EMOJI_WIDTH_FRACTION;
  const emojiH = emojiW * ratio;
  img.style.width = `${emojiW}px`;
  img.style.height = `${emojiH}px`;

  if (!canvas?.app?.ticker) {
    setTimeout(() => img.remove(), EMOJI_DURATION_MS);
    return;
  }

  const startTime = performance.now();
  const bobAmplitude = emojiH * EMOJI_BOB_FRACTION;
  const ticker = canvas.app.ticker;

  const tick = () => {
    if (!img.isConnected) {
      ticker.remove(tick);
      return;
    }
    const elapsed = performance.now() - startTime;
    if (elapsed >= EMOJI_DURATION_MS) {
      ticker.remove(tick);
      img.remove();
      return;
    }

    let scale;
    if (elapsed < EMOJI_POP_MS) {
      const t = elapsed / EMOJI_POP_MS;
      const eased = 1 - Math.pow(1 - t, 3);
      scale = eased * (1 + 0.18 * Math.sin(t * Math.PI));
    } else {
      scale = 1;
    }

    let bob = 0;
    if (elapsed >= EMOJI_POP_MS) {
      const phase = ((elapsed - EMOJI_POP_MS) / EMOJI_BOB_PERIOD_MS) * Math.PI * 2;
      bob = -Math.abs(Math.sin(phase)) * bobAmplitude;
    }

    let opacity = 1;
    if (elapsed > EMOJI_DURATION_MS - EMOJI_FADE_MS) {
      opacity = Math.max(0, (EMOJI_DURATION_MS - elapsed) / EMOJI_FADE_MS);
    }

    const tokenX = token.x ?? token.bounds?.x ?? 0;
    const tokenY = token.y ?? token.bounds?.y ?? 0;
    const left = tokenX + tokenW / 2 - emojiW / 2;
    const top = tokenY - emojiH - 6 + bob;

    img.style.left = `${left}px`;
    img.style.top = `${top}px`;
    img.style.transform = `scale(${scale})`;
    img.style.opacity = `${opacity}`;
  };
  ticker.add(tick);
}

function registerEmojiSettings() {
  game.settings.registerMenu(MODULE_ID, "emojiManager", {
    name: `${MODULE_ID}.settings.emojiManager.name`,
    label: `${MODULE_ID}.settings.emojiManager.label`,
    hint: `${MODULE_ID}.settings.emojiManager.hint`,
    icon: "fa-solid fa-face-smile",
    type: EmojiManagerApp,
    restricted: false
  });
}

const PF2EMM_API = {
  showEmojiPicker: () => new EmojiPickerApp().render(true),
  openEmojiManager: () => new EmojiManagerApp().render(true)
};

globalThis.pf2eMovementModule = PF2EMM_API;

function exposeApi() {
  const mod = game.modules.get(MODULE_ID);
  if (!mod) {
    console.warn(`${MODULE_ID} | module record not found; API only available via globalThis.pf2eMovementModule`);
    return;
  }
  try {
    mod.api = PF2EMM_API;
  } catch (err) {
    console.warn(`${MODULE_ID} | could not assign module.api`, err);
    Object.defineProperty(mod, "api", { value: PF2EMM_API, writable: true, configurable: true });
  }
  console.log(`${MODULE_ID} | API ready: showEmojiPicker, openEmojiManager`);
}

Hooks.once("init", () => {
  try { configureMovementActions(); } catch (err) { console.error(`${MODULE_ID} | configureMovementActions failed`, err); }
  try { patchConstrainMovementPath(); } catch (err) { console.error(`${MODULE_ID} | patchConstrainMovementPath failed`, err); }
  try { registerPreMoveTokenHook(); } catch (err) { console.error(`${MODULE_ID} | registerPreMoveTokenHook failed`, err); }
  try { registerEmojiSettings(); } catch (err) { console.error(`${MODULE_ID} | registerEmojiSettings failed`, err); }
  try { exposeApi(); } catch (err) { console.error(`${MODULE_ID} | exposeApi (init) failed`, err); }
});

Hooks.once("ready", () => {
  try { configureMovementActions(); } catch (err) { console.error(`${MODULE_ID} | configureMovementActions (ready) failed`, err); }
  try { registerEmojiSocket(); } catch (err) { console.error(`${MODULE_ID} | registerEmojiSocket failed`, err); }
  try { exposeApi(); } catch (err) { console.error(`${MODULE_ID} | exposeApi (ready) failed`, err); }
  provisionAllUserDirsAsGM().catch(err =>
    console.warn(`${MODULE_ID} | provisionAllUserDirsAsGM failed`, err));
});
