// @ts-nocheck
import { Dispatcher } from "@valenced/discord/flux";
import { lookupModules } from "@valenced/modules/finders";
import { withProps } from "@valenced/modules/finders/filters";

// ---- tweakables ----
const SELF_ACTION_WINDOW_MS = 3000;
const MIN_INTERVAL_MS = 1000;
const REJOIN_DELAY_MS = 500;
const MAX_CORRECTIVE_MOVES_PER_MINUTE = 3;

// ---- lookups (the only places that depend on Discord's internal modules) ----
// Finds the first already-loaded module that has `prop` and passes `check`.
function find(prop, check) {
  try {
    for (const [exports] of lookupModules(withProps(prop))) {
      if (exports && (!check || check(exports))) return exports;
    }
  } catch (e) {
    console.error("[AntiServerMute] lookup failed for", prop, e);
  }
  return null;
}

let pluginApi;
let dispatcher, RestAPI, UserStore, ChannelStore, SelectedChannelStore, ChannelActions;

function opt(key, fallback) {
  try {
    const s = pluginApi && pluginApi.settings;
    if (!s) return fallback;
    const v = typeof s.get === "function" ? s.get(key) : s[key];
    return v === undefined ? fallback : v;
  } catch (e) {
    return fallback;
  }
}

// Debug output: console + a popup (RN's global alert) so you can see it without adb
function dbg(msg, force) {
  const text = "[AntiServerMute] " + msg;
  console.log(text);
  if (force || opt("debug", true)) {
    try {
      alert(text);
    } catch (e) {}
  }
}

// ---- state ----
const intendedChannel = new Map(); // guildId -> channel I deliberately chose
const currentChannel = new Map(); // guildId -> channel I was last seen in
let lastSelfActionAt = 0;
let lastRequestAt = 0;
let pendingTimer = null;
let rejoinTimer = null;
let correctiveMoves = [];
let restoreSelect = null;

function guildOf(channelId) {
  if (!channelId) return null;
  const ch = ChannelStore.getChannel(channelId);
  return ch && ch.guild_id ? ch.guild_id : null;
}

function allowCorrectiveMove() {
  const now = Date.now();
  correctiveMoves = correctiveMoves.filter((t) => now - t < 60000);
  if (correctiveMoves.length >= MAX_CORRECTIVE_MOVES_PER_MINUTE) {
    console.warn("[AntiServerMute] corrective move limit reached, skipping");
    return false;
  }
  correctiveMoves.push(now);
  return true;
}

function sendFix(guildId, userId, body) {
  const run = () => {
    lastRequestAt = Date.now();
    dbg("sending " + JSON.stringify(body));
    try {
      Promise.resolve(RestAPI.patch({ url: `/guilds/${guildId}/members/${userId}`, body }))
        .then(() => dbg("request OK"))
        .catch((err) => {
          dbg("request FAILED: status " + (err && err.status) + " " + (err && err.body && err.body.message), true);
        });
    } catch (e) {
      dbg("request threw: " + e, true);
    }
  };

  const wait = MIN_INTERVAL_MS - (Date.now() - lastRequestAt);
  if (pendingTimer) clearTimeout(pendingTimer);
  if (wait > 0) {
    pendingTimer = setTimeout(() => {
      pendingTimer = null;
      run();
    }, wait);
  } else {
    run();
  }
}

function scheduleRejoin(channelId) {
  if (!allowCorrectiveMove()) return;
  if (rejoinTimer) clearTimeout(rejoinTimer);
  rejoinTimer = setTimeout(() => {
    rejoinTimer = null;
    if (SelectedChannelStore.getVoiceChannelId()) return; // already back in a VC
    try {
      ChannelActions.selectVoiceChannel(channelId);
    } catch (e) {
      console.error("[AntiServerMute] rejoin failed", e);
    }
  }, REJOIN_DELAY_MS);
}

// Called whenever *I* pick a voice channel / disconnect through the client
function markSelfAction(target) {
  lastSelfActionAt = Date.now();
  if (target) {
    const g = guildOf(target);
    if (g) intendedChannel.set(g, target);
  } else {
    const g = guildOf(SelectedChannelStore.getVoiceChannelId());
    if (g) intendedChannel.delete(g);
  }
}

function onVoiceChannelSelect(e) {
  lastSelfActionAt = Date.now();
  if (!e || !e.guildId) return;
  if (e.channelId) intendedChannel.set(e.guildId, e.channelId);
  else intendedChannel.delete(e.guildId);
}

function onVoiceStateUpdates(e) {
  const me = UserStore.getCurrentUser();
  if (!me || !e || !e.voiceStates) return;

  for (const state of e.voiceStates) {
    const uid = state.userId || state.user_id;
    const guildId = state.guildId || state.guild_id;
    if (uid !== me.id || !guildId) continue;

    state.channelId = state.channelId || state.channel_id || null;
    dbg("my voice state: mute=" + state.mute + " deaf=" + state.deaf + " channel=" + state.channelId);
    const newChannel = state.channelId || null;
    const prevChannel = currentChannel.get(guildId) || null;
    currentChannel.set(guildId, newChannel);

    const wanted = intendedChannel.get(guildId);
    const selfInitiated = Date.now() - lastSelfActionAt < SELF_ACTION_WINDOW_MS;

    // Disconnected and I didn't do it -> rejoin
    if (!newChannel) {
      if (prevChannel && wanted && !selfInitiated && opt("autoRejoin", true)) {
        scheduleRejoin(wanted);
      }
      continue;
    }

    const body = {};
    // mute / deaf = SERVER-side. selfMute / selfDeaf = my own toggles (ignored)
    if (state.mute && opt("autoUnmute", true)) body.mute = false;
    if (state.deaf && opt("autoUndeafen", true)) body.deaf = false;

    const channelChanged = prevChannel !== null && prevChannel !== newChannel;
    if (channelChanged && !selfInitiated && wanted && wanted !== newChannel) {
      // Forced move
      if (opt("moveBack", true) && allowCorrectiveMove()) body.channel_id = wanted;
    } else if (!wanted || selfInitiated || prevChannel === null) {
      intendedChannel.set(guildId, newChannel);
    }

    if (Object.keys(body).length) sendFix(guildId, me.id, body);
  }
}

export default plugin({
  start(api) {
    pluginApi = api;
    dispatcher = Dispatcher;
    RestAPI = find("getAPIBaseURL", (m) => typeof m.patch === "function");
    UserStore = find("getCurrentUser", (m) => typeof m.getCurrentUser === "function");
    ChannelStore = find("getMutableGuildChannelsForGuild", (m) => typeof m.getChannel === "function");
    SelectedChannelStore = find("getVoiceChannelId", (m) => typeof m.getVoiceChannelId === "function");
    ChannelActions = find("selectVoiceChannel", (m) => typeof m.selectVoiceChannel === "function");

    const missing = Object.entries({ dispatcher, RestAPI, UserStore, ChannelStore, SelectedChannelStore, ChannelActions })
      .filter(([, v]) => !v)
      .map(([k]) => k);
    if (missing.length) {
      dbg("could not find: " + missing.join(", ") + " - plugin NOT started", true);
      dispatcher = null; // so stop() has nothing to clean up
      return;
    }

    // Seed with the VC I'm already in
    const vc = SelectedChannelStore.getVoiceChannelId();
    const g = guildOf(vc);
    if (vc && g) {
      currentChannel.set(g, vc);
      intendedChannel.set(g, vc);
    }

    dispatcher.subscribe("VOICE_STATE_UPDATES", onVoiceStateUpdates);
    dbg("started (me=" + (UserStore.getCurrentUser() || {}).id + ", in VC: " + vc + ")");
    dispatcher.subscribe("VOICE_CHANNEL_SELECT", onVoiceChannelSelect);

    // Backup "I did this myself" detection, in case VOICE_CHANNEL_SELECT isn't dispatched
    if (ChannelActions && typeof ChannelActions.selectVoiceChannel === "function") {
      const orig = ChannelActions.selectVoiceChannel;
      ChannelActions.selectVoiceChannel = function (...args) {
        markSelfAction(args[0]);
        return orig.apply(this, args);
      };
      restoreSelect = () => {
        ChannelActions.selectVoiceChannel = orig;
      };
    }
  },

  stop() {
    if (dispatcher) {
      dispatcher.unsubscribe("VOICE_STATE_UPDATES", onVoiceStateUpdates);
      dispatcher.unsubscribe("VOICE_CHANNEL_SELECT", onVoiceChannelSelect);
    }
    if (restoreSelect) restoreSelect();
    restoreSelect = null;
    if (pendingTimer) clearTimeout(pendingTimer);
    if (rejoinTimer) clearTimeout(rejoinTimer);
    pendingTimer = rejoinTimer = null;
    correctiveMoves = [];
    intendedChannel.clear();
    currentChannel.clear();
  },
});
